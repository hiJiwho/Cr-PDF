#!/usr/bin/env python3
"""
Cr-PDF DataPack v5 (resources.pak) unpacker, content-fingerprint patcher,
repacker, and structural validator.

Pure Python 3 stdlib (+ optional brotli / brotlicffi / `brotli` CLI fallback).
Supports CEF 150 / Chromium DataPack v5 (Windows x64 & Linux x64).
"""

from __future__ import annotations

import argparse
import dataclasses
import gzip
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List, Literal, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DATAPACK_V5_VERSION = 5
HEADER_STRUCT = struct.Struct("<IBxxxHH")  # 12 bytes
RESOURCE_ENTRY_STRUCT = struct.Struct("<HI")  # 6 bytes
ALIAS_ENTRY_STRUCT = struct.Struct("<HH")  # 4 bytes

VALID_ENCODINGS = {0: "BINARY", 1: "UTF8", 2: "UTF16"}

GZIP_MAGIC = b"\x1f\x8b"
CHROMIUM_BROTLI_MAGIC = b"\x1e\x9b"
CHROMIUM_BROTLI_HEADER_SIZE = 8  # 2-byte magic + 6-byte LE uncompressed size

PATCH_START = "/* CRPDF_PATCH_START */"
PATCH_END = "/* CRPDF_PATCH_END */"

CompressionKind = Literal["raw", "gzip", "brotli"]
CompressionMode = Literal["preserve", "raw", "gzip", "brotli"]

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_FINGERPRINT_ERROR = 2
EXIT_BROTLI_UNAVAILABLE = 3


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class PakError(Exception):
    """Base error for DataPack operations."""

    exit_code: int = EXIT_ERROR


class PakFormatError(PakError):
    """Raised when a .pak binary fails DataPack v5 structural validation."""

    exit_code: int = EXIT_ERROR


class FingerprintError(PakError):
    """Raised when a target resource fingerprint matches 0 or >1 entries."""

    exit_code: int = EXIT_FINGERPRINT_ERROR


class BrotliUnavailableError(PakError):
    """Raised when Chromium-Brotli processing is needed but no backend exists."""

    exit_code: int = EXIT_BROTLI_UNAVAILABLE


class PatchError(PakError):
    """Raised when patch markers or patch files are invalid."""

    exit_code: int = EXIT_ERROR


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class DataPack:
    """Parsed representation of a DataPack v5 archive."""

    version: int
    encoding: int
    resources: Dict[int, bytes]  # All resource_ids (canonical + aliases) -> raw bytes
    canonical_ids: List[int]  # Sorted primary resource IDs from Resource Table
    aliases: Dict[int, int]  # alias_id -> canonical_resource_id


@dataclasses.dataclass(frozen=True)
class FingerprintSpec:
    """Version-resilient content fingerprint for a target resource."""

    name: str
    required_tokens: Tuple[str, ...]
    excluded_tokens: Tuple[str, ...] = ()


@dataclasses.dataclass
class MatchResult:
    """Result of matching a FingerprintSpec against a DataPack."""

    name: str
    resource_id: int
    compression: CompressionKind
    raw_size: int
    decompressed_size: int
    text: str


DEFAULT_FINGERPRINTS: Tuple[FingerprintSpec, ...] = (
    FingerprintSpec(
        name="main.js",
        required_tokens=(
            "pdf_viewer_wrapper.js",
            "browser_api.js",
            "chrome.contentSettings.javascript",
        ),
        excluded_tokens=(
            "pdf_print_wrapper.js",
            "createBrowserApiForPrintPreview",
        ),
    ),
    FingerprintSpec(
        name="pdf_internal_plugin_wrapper.js",
        required_tokens=(
            "syncScrollToRemote",
            "ackScrollToRemote",
            "syncScrollFromRemote",
            "chrome-untrusted://print",
            "parent.postMessage",
        ),
        excluded_tokens=("pdf-viewer-print",),
    ),
)


# ---------------------------------------------------------------------------
# Brotli backend helpers (optional, lazy)
# ---------------------------------------------------------------------------


def _get_python_brotli():
    """Return an imported brotli or brotlicffi module, or None."""
    for mod_name in ("brotli", "brotlicffi"):
        try:
            return __import__(mod_name)
        except ImportError:
            continue
    return None


def _get_brotli_cli() -> Optional[str]:
    """Return path to `brotli` CLI executable if installed, else None."""
    return shutil.which("brotli")


def _brotli_decompress_raw(stream: bytes) -> bytes:
    """Decompress a raw Brotli stream using Python lib or CLI fallback."""
    mod = _get_python_brotli()
    if mod is not None:
        try:
            return mod.decompress(stream)
        except Exception as exc:
            raise PakFormatError(f"Python brotli decompression failed: {exc}") from exc

    cli = _get_brotli_cli()
    if cli is not None:
        proc = subprocess.run(
            [cli, "-d", "-c"],
            input=stream,
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", errors="replace").strip()
            raise PakFormatError(f"brotli CLI decompression failed: {err}")
        return proc.stdout

    raise BrotliUnavailableError(
        "Chromium-Brotli entry encountered, but neither Python 'brotli'/'brotlicffi' "
        "nor the 'brotli' CLI is installed. Install via: pip install brotli"
    )


def _brotli_compress_raw(payload: bytes) -> Optional[bytes]:
    """Compress bytes to a raw Brotli stream, or return None if unavailable."""
    mod = _get_python_brotli()
    if mod is not None:
        return mod.compress(payload)

    cli = _get_brotli_cli()
    if cli is not None:
        proc = subprocess.run(
            [cli, "-c"],
            input=payload,
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", errors="replace").strip()
            raise PakError(f"brotli CLI compression failed: {err}")
        return proc.stdout

    return None


# ---------------------------------------------------------------------------
# Per-entry compression detection, decompression & recompression
# ---------------------------------------------------------------------------


def detect_compression(raw: bytes) -> CompressionKind:
    """Detect per-entry compression format using Chromium magic bytes."""
    if len(raw) >= 2 and raw[:2] == GZIP_MAGIC:
        return "gzip"
    if len(raw) >= CHROMIUM_BROTLI_HEADER_SIZE and raw[:2] == CHROMIUM_BROTLI_MAGIC:
        return "brotli"
    return "raw"


def decompress_entry(raw: bytes) -> Tuple[bytes, CompressionKind]:
    """
    Transparently decompress a DataPack resource entry.

    Returns `(decompressed_bytes, detected_compression)`.
    """
    kind = detect_compression(raw)
    if kind == "raw":
        return raw, "raw"

    if kind == "gzip":
        try:
            return gzip.decompress(raw), "gzip"
        except Exception as exc:
            raise PakFormatError(f"Failed to gzip-decompress entry: {exc}") from exc

    # Chromium-Brotli: 2-byte magic (0x1e 0x9b) + 6-byte LE uncompressed size + stream
    expected_size = int.from_bytes(raw[2:CHROMIUM_BROTLI_HEADER_SIZE], "little")
    stream = raw[CHROMIUM_BROTLI_HEADER_SIZE:]
    out = _brotli_decompress_raw(stream)
    if len(out) != expected_size:
        raise PakFormatError(
            f"Chromium-Brotli size mismatch: header declared {expected_size} bytes, "
            f"decompressed {len(out)} bytes"
        )
    return out, "brotli"


def compress_entry(
    payload: bytes,
    mode: CompressionMode,
    original_compression: CompressionKind = "raw",
) -> bytes:
    """
    Compress a resource payload according to `mode`.

    - `preserve`: keep `original_compression` (if `brotli` is unavailable for
      recompression, safely fall back to deterministic `gzip`, which Chromium's
      `ResourceBundle::DecompressIfNeeded` loads identically).
    - `raw`: store uncompressed.
    - `gzip`: deterministic gzip (`compresslevel=6, mtime=0`).
    - `brotli`: Chromium-Brotli (`0x1e 0x9b` + 6-byte LE size + stream); raises
      `BrotliUnavailableError` if no Brotli encoder is available.
    """
    target: CompressionKind = original_compression if mode == "preserve" else mode

    if target == "raw":
        return payload

    if target == "gzip":
        return gzip.compress(payload, compresslevel=6, mtime=0)

    if target == "brotli":
        compressed = _brotli_compress_raw(payload)
        if compressed is None:
            if mode == "preserve":
                # Chromium inspects magic bytes dynamically; gzip is 100% valid.
                return gzip.compress(payload, compresslevel=6, mtime=0)
            raise BrotliUnavailableError(
                "Requested --compression brotli, but no Brotli encoder is installed. "
                "Install via: pip install brotli"
            )
        header = CHROMIUM_BROTLI_MAGIC + len(payload).to_bytes(6, "little")
        return header + compressed

    raise ValueError(f"Unsupported compression mode: {mode}")


# ---------------------------------------------------------------------------
# DataPack v5 validator, parser, and serializer
# ---------------------------------------------------------------------------


def validate_pak(data: bytes) -> Dict[str, object]:
    """
    Strictly validate DataPack v5 binary invariants matching Chromium's data_pack.cc.

    Returns a stats dict on success, or raises `PakFormatError`.
    """
    total_size = len(data)
    if total_size < HEADER_STRUCT.size:
        raise PakFormatError(
            f"Truncated DataPack header: expected at least {HEADER_STRUCT.size} bytes, "
            f"got {total_size}"
        )

    version, encoding, resource_count, alias_count = HEADER_STRUCT.unpack_from(data, 0)
    if version != DATAPACK_V5_VERSION:
        raise PakFormatError(
            f"Unsupported DataPack version: expected {DATAPACK_V5_VERSION}, got {version}"
        )

    if encoding not in VALID_ENCODINGS:
        raise PakFormatError(
            f"Invalid DataPack encoding value: {encoding} (expected one of 0, 1, 2)"
        )

    if data[5:8] != b"\x00\x00\x00":
        raise PakFormatError(
            f"Non-zero reserved padding bytes in DataPack v5 header: {data[5:8]!r}"
        )

    resource_table_offset = HEADER_STRUCT.size
    resource_table_bytes = (resource_count + 1) * RESOURCE_ENTRY_STRUCT.size
    alias_table_offset = resource_table_offset + resource_table_bytes
    alias_table_bytes = alias_count * ALIAS_ENTRY_STRUCT.size
    data_start = alias_table_offset + alias_table_bytes

    if data_start > total_size:
        raise PakFormatError(
            f"Truncated DataPack tables: tables require {data_start} bytes, "
            f"but file is only {total_size} bytes"
        )

    primary_ids: set[int] = set()
    prev_id: Optional[int] = None
    prev_offset: Optional[int] = None

    for idx in range(resource_count):
        pos = resource_table_offset + idx * RESOURCE_ENTRY_STRUCT.size
        res_id, offset = RESOURCE_ENTRY_STRUCT.unpack_from(data, pos)
        if prev_id is not None and res_id <= prev_id:
            raise PakFormatError(
                f"Resource table not strictly ascending at index {idx}: "
                f"prev_id={prev_id}, curr_id={res_id}"
            )
        if offset < data_start or offset > total_size:
            raise PakFormatError(
                f"Resource entry {idx} (id={res_id}) has out-of-bounds offset {offset} "
                f"(valid range [{data_start}, {total_size}])"
            )
        if prev_offset is not None and offset < prev_offset:
            raise PakFormatError(
                f"Resource offsets not non-decreasing at index {idx} (id={res_id}): "
                f"prev_offset={prev_offset}, offset={offset}"
            )
        primary_ids.add(res_id)
        prev_id = res_id
        prev_offset = offset

    # Sentinel entry
    sentinel_pos = resource_table_offset + resource_count * RESOURCE_ENTRY_STRUCT.size
    sentinel_id, sentinel_offset = RESOURCE_ENTRY_STRUCT.unpack_from(data, sentinel_pos)
    if sentinel_id != 0:
        raise PakFormatError(
            f"Invalid sentinel resource_id: expected 0, got {sentinel_id}"
        )
    if sentinel_offset != total_size:
        raise PakFormatError(
            f"Invalid sentinel offset: expected file size {total_size}, got {sentinel_offset}"
        )
    if prev_offset is not None and sentinel_offset < prev_offset:
        raise PakFormatError(
            f"Sentinel offset {sentinel_offset} is smaller than last resource offset {prev_offset}"
        )

    # Alias table
    prev_alias_id: Optional[int] = None
    for idx in range(alias_count):
        pos = alias_table_offset + idx * ALIAS_ENTRY_STRUCT.size
        alias_id, entry_index = ALIAS_ENTRY_STRUCT.unpack_from(data, pos)
        if prev_alias_id is not None and alias_id <= prev_alias_id:
            raise PakFormatError(
                f"Alias table not strictly ascending at index {idx}: "
                f"prev_id={prev_alias_id}, curr_id={alias_id}"
            )
        if entry_index >= resource_count:
            raise PakFormatError(
                f"Alias entry {idx} (id={alias_id}) has out-of-range entry_index "
                f"{entry_index} (resource_count={resource_count})"
            )
        if alias_id in primary_ids:
            raise PakFormatError(
                f"Alias ID {alias_id} duplicates a primary resource_id"
            )
        prev_alias_id = alias_id

    return {
        "version": version,
        "encoding": encoding,
        "encoding_name": VALID_ENCODINGS[encoding],
        "resource_count": resource_count,
        "alias_count": alias_count,
        "data_start": data_start,
        "file_size": total_size,
    }


def parse_pak(data: bytes) -> DataPack:
    """Validate and parse a DataPack v5 byte buffer into a `DataPack`."""
    stats = validate_pak(data)
    version = int(stats["version"])
    encoding = int(stats["encoding"])
    resource_count = int(stats["resource_count"])
    alias_count = int(stats["alias_count"])

    resource_table_offset = HEADER_STRUCT.size
    entries: List[Tuple[int, int]] = []
    for idx in range(resource_count + 1):
        pos = resource_table_offset + idx * RESOURCE_ENTRY_STRUCT.size
        entries.append(RESOURCE_ENTRY_STRUCT.unpack_from(data, pos))

    resources: Dict[int, bytes] = {}
    canonical_ids: List[int] = []
    for idx in range(resource_count):
        res_id, start = entries[idx]
        _, end = entries[idx + 1]
        resources[res_id] = data[start:end]
        canonical_ids.append(res_id)

    alias_table_offset = (
        resource_table_offset + (resource_count + 1) * RESOURCE_ENTRY_STRUCT.size
    )
    aliases: Dict[int, int] = {}
    for idx in range(alias_count):
        pos = alias_table_offset + idx * ALIAS_ENTRY_STRUCT.size
        alias_id, entry_index = ALIAS_ENTRY_STRUCT.unpack_from(data, pos)
        canonical_id = canonical_ids[entry_index]
        aliases[alias_id] = canonical_id
        resources[alias_id] = resources[canonical_id]

    return DataPack(
        version=version,
        encoding=encoding,
        resources=resources,
        canonical_ids=canonical_ids,
        aliases=aliases,
    )


def serialize_pak(resources: Dict[int, bytes], encoding: int = 1) -> bytes:
    """
    Serialize `resources: dict[int, bytes]` into a valid DataPack v5 binary.

    Mirrors Chromium's `WriteDataPackToString`:
    - Groups identical byte payloads so the lowest `resource_id` is canonical
      and higher IDs with identical bytes become Alias Table entries.
    - Emits strictly ascending Resource Table + sentinel `(0, file_size)` and
      strictly ascending Alias Table.
    """
    if encoding not in VALID_ENCODINGS:
        raise PakFormatError(f"Invalid encoding: {encoding}")

    # Validate resource IDs
    for res_id in resources:
        if not isinstance(res_id, int) or res_id < 0 or res_id > 0xFFFF:
            raise PakFormatError(f"Resource ID out of uint16 range: {res_id!r}")

    # Group IDs by identical raw payload bytes
    payload_to_ids: Dict[bytes, List[int]] = {}
    for res_id in sorted(resources.keys()):
        payload = resources[res_id]
        payload_to_ids.setdefault(payload, []).append(res_id)

    canonical_items: List[Tuple[int, bytes]] = []
    alias_pairs_by_canonical: List[Tuple[int, int]] = []  # (alias_id, canonical_id)
    for payload, ids in payload_to_ids.items():
        canonical_id = ids[0]
        canonical_items.append((canonical_id, payload))
        for alias_id in ids[1:]:
            alias_pairs_by_canonical.append((alias_id, canonical_id))

    # Sort canonical entries ascending by resource_id
    canonical_items.sort(key=lambda item: item[0])
    canonical_id_to_index = {
        res_id: idx for idx, (res_id, _) in enumerate(canonical_items)
    }

    # Sort aliases ascending by alias_id
    alias_entries: List[Tuple[int, int]] = sorted(
        (alias_id, canonical_id_to_index[canon_id])
        for alias_id, canon_id in alias_pairs_by_canonical
    )

    resource_count = len(canonical_items)
    alias_count = len(alias_entries)
    if resource_count > 0xFFFF or alias_count > 0xFFFF:
        raise PakFormatError(
            f"Too many entries for DataPack v5 uint16 counts: "
            f"resources={resource_count}, aliases={alias_count}"
        )

    data_start = (
        HEADER_STRUCT.size
        + (resource_count + 1) * RESOURCE_ENTRY_STRUCT.size
        + alias_count * ALIAS_ENTRY_STRUCT.size
    )

    chunks: List[bytes] = [
        HEADER_STRUCT.pack(DATAPACK_V5_VERSION, encoding, resource_count, alias_count)
    ]

    offset = data_start
    for res_id, payload in canonical_items:
        chunks.append(RESOURCE_ENTRY_STRUCT.pack(res_id, offset))
        offset += len(payload)

    # Sentinel entry: (0, total_file_size)
    chunks.append(RESOURCE_ENTRY_STRUCT.pack(0, offset))

    for alias_id, entry_index in alias_entries:
        chunks.append(ALIAS_ENTRY_STRUCT.pack(alias_id, entry_index))

    for _, payload in canonical_items:
        chunks.append(payload)

    return b"".join(chunks)


# ---------------------------------------------------------------------------
# Content-fingerprint discovery
# ---------------------------------------------------------------------------


def _matches_spec(text: str, spec: FingerprintSpec) -> bool:
    for token in spec.required_tokens:
        if token not in text:
            return False
    for token in spec.excluded_tokens:
        if token in text:
            return False
    return True


def find_target_resources(
    pak: DataPack,
    specs: Sequence[FingerprintSpec] = DEFAULT_FINGERPRINTS,
    *,
    strict: bool = True,
) -> Tuple[Dict[str, MatchResult], List[int]]:
    """
    Scan canonical entries in `pak` for each `FingerprintSpec`.

    Returns `(matches_by_name, skipped_brotli_ids)`.
    If `strict=True`, raises:
      - `BrotliUnavailableError` (exit 3) if a target has 0 matches and any
        Brotli entries could not be decompressed.
      - `FingerprintError` (exit 2) if a target has 0 matches or >1 matches.
    """
    candidates: Dict[str, List[MatchResult]] = {spec.name: [] for spec in specs}
    skipped_brotli_ids: List[int] = []

    for res_id in pak.canonical_ids:
        raw = pak.resources[res_id]
        try:
            decompressed, comp = decompress_entry(raw)
        except BrotliUnavailableError:
            skipped_brotli_ids.append(res_id)
            continue
        except PakFormatError:
            # Unrelated binary entry whose bytes coincidentally start with
            # gzip (\x1f\x8b) or Chromium-Brotli (\x1e\x9b) magic; treat as opaque binary.
            continue

        try:
            text = decompressed.decode("utf-8")
        except UnicodeDecodeError:
            # Binary resource (PNG, ICO, font, etc.) — cannot be JS
            continue

        for spec in specs:
            if _matches_spec(text, spec):
                candidates[spec.name].append(
                    MatchResult(
                        name=spec.name,
                        resource_id=res_id,
                        compression=comp,
                        raw_size=len(raw),
                        decompressed_size=len(decompressed),
                        text=text,
                    )
                )

    resolved: Dict[str, MatchResult] = {}
    for spec in specs:
        found = candidates[spec.name]
        if len(found) == 1:
            resolved[spec.name] = found[0]
        elif len(found) == 0:
            if strict:
                if skipped_brotli_ids:
                    raise BrotliUnavailableError(
                        f"Target '{spec.name}' was not found, and "
                        f"{len(skipped_brotli_ids)} Chromium-Brotli entries could not "
                        f"be scanned because no Brotli backend is installed. "
                        f"Install via: pip install brotli"
                    )
                raise FingerprintError(
                    f"Target '{spec.name}' matched 0 resources "
                    f"(required={spec.required_tokens}, excluded={spec.excluded_tokens})"
                )
        else:
            ids = [m.resource_id for m in found]
            if strict:
                raise FingerprintError(
                    f"Ambiguous fingerprint for '{spec.name}': matched {len(found)} "
                    f"resources (IDs: {ids}). Run with --inspect or --unpack to diagnose."
                )

    return resolved, skipped_brotli_ids


# ---------------------------------------------------------------------------
# Idempotent patch stripping & injection
# ---------------------------------------------------------------------------

_PATCH_BLOCK_RE = re.compile(
    r"\n?" + re.escape(PATCH_START) + r".*?" + re.escape(PATCH_END) + r"\r?\n?",
    re.DOTALL,
)


def has_crpdf_patch(text: str) -> bool:
    """Return True if text contains exactly one balanced CRPDF patch block."""
    if text.count(PATCH_START) != 1 or text.count(PATCH_END) != 1:
        return False
    return text.find(PATCH_START) < text.find(PATCH_END)


def strip_existing_patch(text: str) -> str:
    """
    Remove any prior `/* CRPDF_PATCH_START */ ... /* CRPDF_PATCH_END */` block(s).

    Raises `PatchError` if markers are unbalanced or out of order.
    """
    pos = 0
    while True:
        start_idx = text.find(PATCH_START, pos)
        end_idx = text.find(PATCH_END, pos)

        if start_idx == -1 and end_idx == -1:
            break
        if start_idx == -1 and end_idx != -1:
            raise PatchError(
                f"Malformed existing CRPDF patch markers: found {PATCH_END!r} "
                f"without matching {PATCH_START!r}"
            )
        if end_idx == -1:
            raise PatchError(
                f"Malformed existing CRPDF patch markers: found {PATCH_START!r} "
                f"without matching {PATCH_END!r}"
            )
        if end_idx < start_idx:
            raise PatchError(
                f"Malformed existing CRPDF patch markers: {PATCH_END!r} appears "
                f"before {PATCH_START!r}"
            )
        # Check for nested PATCH_START before PATCH_END
        nested_start = text.find(PATCH_START, start_idx + len(PATCH_START))
        if nested_start != -1 and nested_start < end_idx:
            raise PatchError(
                f"Malformed existing CRPDF patch markers: nested {PATCH_START!r} "
                f"before {PATCH_END!r}"
            )
        pos = end_idx + len(PATCH_END)

    if PATCH_START not in text:
        return text

    stripped = _PATCH_BLOCK_RE.sub("", text)
    return stripped


def inject_patch(
    original_text: str,
    js_code: str,
    css_text: Optional[str] = None,
) -> str:
    """
    Idempotently inject JS (and optional CSS via `json.dumps(..., ensure_ascii=True)`)
    into `original_text` wrapped in `/* CRPDF_PATCH_START */ ... /* CRPDF_PATCH_END */`.
    """
    if PATCH_START in js_code or PATCH_END in js_code:
        raise PatchError(
            f"js_code must not contain patch marker literals ({PATCH_START!r} or {PATCH_END!r})"
        )

    clean_base = strip_existing_patch(original_text)

    # Always emit a single LF delimiter when clean_base is non-empty so:
    # 1. A trailing `//` comment on the last line of original JS can never
    #    comment out PATCH_START.
    # 2. strip_existing_patch strips only this exact LF delimiter without ever
    #    consuming `\r` or `\n` belonging to original_text (CRLF / trailing blank
    #    lines remain 100% byte-identical across repeated patching).
    separator = "\n" if clean_base else ""

    body_parts: List[str] = []
    if css_text is not None:
        # Escape `/` as `\/` in the JSON string literal so CSS comments (including
        # any `/* CRPDF_PATCH_START */` / `/* CRPDF_PATCH_END */` or `</script>`)
        # can never corrupt patch markers while still evaluating to the exact
        # original CSS string in JavaScript.
        encoded_css = json.dumps(css_text, ensure_ascii=True).replace("/", "\\/")
        body_parts.append(f"globalThis.__CRPDF_STYLE_CSS__ = {encoded_css};")

    js_trimmed = js_code.rstrip("\r\n")
    if js_trimmed:
        body_parts.append(js_trimmed)

    body = "\n".join(body_parts)
    if body:
        block = f"{PATCH_START}\n{body}\n{PATCH_END}\n"
    else:
        block = f"{PATCH_START}\n{PATCH_END}\n"

    return clean_base + separator + block


# ---------------------------------------------------------------------------
# High-level patch / inspect / unpack / verify workflows
# ---------------------------------------------------------------------------


def patch_pak_bytes(
    pak_bytes: bytes,
    patches_dir: Path,
    *,
    allow_partial: bool = False,
    compression: CompressionMode = "preserve",
) -> Tuple[bytes, Dict[str, object]]:
    """
    Patch a DataPack v5 byte buffer using files from `patches_dir`.

    Expected files in `patches_dir`:
      - `crpdf_main.js` (injected into `main.js`)
      - `crpdf_style.css` (optional; embedded into `main.js` as `__CRPDF_STYLE_CSS__`)
      - `crpdf_plugin_wrapper.js` (injected into `pdf_internal_plugin_wrapper.js`)
    """
    if not patches_dir.is_dir():
        raise PatchError(f"Patches directory does not exist: {patches_dir}")

    main_js_path = patches_dir / "crpdf_main.js"
    style_css_path = patches_dir / "crpdf_style.css"
    wrapper_js_path = patches_dir / "crpdf_plugin_wrapper.js"

    has_main = main_js_path.is_file()
    has_wrapper = wrapper_js_path.is_file()

    if not allow_partial:
        missing = []
        if not has_main:
            missing.append(str(main_js_path))
        if not has_wrapper:
            missing.append(str(wrapper_js_path))
        if missing:
            raise PatchError(
                "Missing required patch file(s) (use --allow-partial to patch a subset): "
                + ", ".join(missing)
            )
    elif not has_main and not has_wrapper:
        raise PatchError(
            f"No patch files found in {patches_dir} "
            f"(expected crpdf_main.js and/or crpdf_plugin_wrapper.js)"
        )

    pak = parse_pak(pak_bytes)

    specs_to_find: List[FingerprintSpec] = []
    if has_main:
        specs_to_find.append(DEFAULT_FINGERPRINTS[0])
    if has_wrapper:
        specs_to_find.append(DEFAULT_FINGERPRINTS[1])

    matches, skipped_brotli = find_target_resources(pak, specs_to_find, strict=True)

    # Copy resources map; unmodified entries keep their exact original raw bytes.
    new_resources: Dict[int, bytes] = dict(pak.resources)
    patched_summary: Dict[str, Dict[str, object]] = {}

    if has_main:
        m = matches["main.js"]
        main_js_code = main_js_path.read_text(encoding="utf-8")
        css_text = (
            style_css_path.read_text(encoding="utf-8")
            if style_css_path.is_file()
            else ""
        )
        patched_text = inject_patch(m.text, main_js_code, css_text=css_text)
        encoded_bytes = compress_entry(
            patched_text.encode("utf-8"),
            mode=compression,
            original_compression=m.compression,
        )
        new_resources[m.resource_id] = encoded_bytes
        patched_summary["main.js"] = {
            "resource_id": m.resource_id,
            "original_compression": m.compression,
            "output_compression": detect_compression(encoded_bytes),
            "original_size": m.raw_size,
            "patched_size": len(encoded_bytes),
        }

    if has_wrapper:
        m = matches["pdf_internal_plugin_wrapper.js"]
        wrapper_js_code = wrapper_js_path.read_text(encoding="utf-8")
        patched_text = inject_patch(m.text, wrapper_js_code, css_text=None)
        encoded_bytes = compress_entry(
            patched_text.encode("utf-8"),
            mode=compression,
            original_compression=m.compression,
        )
        new_resources[m.resource_id] = encoded_bytes
        patched_summary["pdf_internal_plugin_wrapper.js"] = {
            "resource_id": m.resource_id,
            "original_compression": m.compression,
            "output_compression": detect_compression(encoded_bytes),
            "original_size": m.raw_size,
            "patched_size": len(encoded_bytes),
        }

    out_bytes = serialize_pak(new_resources, encoding=pak.encoding)
    report: Dict[str, object] = {
        "encoding": pak.encoding,
        "patched_targets": patched_summary,
        "skipped_brotli_count": len(skipped_brotli),
        "output_size": len(out_bytes),
    }
    return out_bytes, report


def inspect_pak_bytes(pak_bytes: bytes) -> Dict[str, object]:
    """Return a structured inspection report for a DataPack v5 binary."""
    stats = validate_pak(pak_bytes)
    pak = parse_pak(pak_bytes)

    comp_counts: Dict[str, int] = {"raw": 0, "gzip": 0, "brotli": 0}
    for res_id in pak.canonical_ids:
        kind = detect_compression(pak.resources[res_id])
        comp_counts[kind] += 1

    matches, skipped_brotli = find_target_resources(
        pak, DEFAULT_FINGERPRINTS, strict=False
    )

    targets_info: Dict[str, Optional[Dict[str, object]]] = {}
    for spec in DEFAULT_FINGERPRINTS:
        m = matches.get(spec.name)
        if m is None:
            targets_info[spec.name] = None
        else:
            targets_info[spec.name] = {
                "resource_id": m.resource_id,
                "compression": m.compression,
                "raw_size": m.raw_size,
                "decompressed_size": m.decompressed_size,
                "already_patched": has_crpdf_patch(m.text),
            }

    return {
        **stats,
        "compression_counts": comp_counts,
        "skipped_brotli_count": len(skipped_brotli),
        "targets": targets_info,
    }


def _guess_extension(payload: bytes) -> str:
    """Heuristically guess a file extension for unpacked resources."""
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if payload.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if payload.startswith(b"RIFF") and payload[8:12] == b"WEBP":
        return ".webp"
    try:
        head = payload[:512].decode("utf-8").lstrip()
    except UnicodeDecodeError:
        return ".bin"

    low = head.lower()
    if low.startswith("<!doctype html") or low.startswith("<html"):
        return ".html"
    if low.startswith("<svg"):
        return ".svg"
    if head.startswith("{") or head.startswith("["):
        try:
            json.loads(payload.decode("utf-8"))
            return ".json"
        except Exception:
            pass
    if any(
        kw in head
        for kw in ("import ", "export ", "function ", "const ", "let ", "var ", "'use strict'", '"use strict"')
    ):
        return ".js"
    if "{" in head and ":" in head and ";" in head and ("color:" in low or "display:" in low or "@media" in low):
        return ".css"
    return ".txt"


def unpack_pak_to_dir(pak_bytes: bytes, out_dir: Path) -> Dict[str, object]:
    """Unpack all canonical resources from `pak_bytes` into `out_dir` + manifest.json."""
    stats = validate_pak(pak_bytes)
    pak = parse_pak(pak_bytes)
    out_dir.mkdir(parents=True, exist_ok=True)

    matches, skipped_brotli = find_target_resources(
        pak, DEFAULT_FINGERPRINTS, strict=False
    )

    entries_manifest: List[Dict[str, object]] = []
    for res_id in pak.canonical_ids:
        raw = pak.resources[res_id]
        comp = detect_compression(raw)
        decompressed: Optional[bytes] = None
        try:
            decompressed, _ = decompress_entry(raw)
        except BrotliUnavailableError:
            decompressed = None
        except PakFormatError:
            # False-positive magic bytes on an unrelated binary entry; write raw bytes.
            decompressed = None
            comp = "raw"

        if decompressed is not None:
            ext = _guess_extension(decompressed)
            filename = f"{res_id}{ext}"
            (out_dir / filename).write_bytes(decompressed)
        else:
            filename = f"{res_id}.br.bin" if comp == "brotli" else f"{res_id}.bin"
            (out_dir / filename).write_bytes(raw)

        entries_manifest.append(
            {
                "resource_id": res_id,
                "file": filename,
                "compression": comp,
                "raw_size": len(raw),
                "decompressed_size": len(decompressed) if decompressed is not None else None,
            }
        )

    manifest: Dict[str, object] = {
        **stats,
        "skipped_brotli_count": len(skipped_brotli),
        "targets": {
            name: m.resource_id for name, m in matches.items()
        },
        "aliases": {str(k): v for k, v in sorted(pak.aliases.items())},
        "entries": entries_manifest,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return manifest


def verify_patched_pak(
    pak_bytes: bytes,
    expected_targets: Iterable[str],
) -> Dict[str, object]:
    """
    Re-parse `pak_bytes`, validate DataPack v5 invariants, confirm every expected
    target matches its fingerprint cleanly, decodes as UTF-8, and contains
    balanced `CRPDF_PATCH_START` / `CRPDF_PATCH_END` markers.
    """
    stats = validate_pak(pak_bytes)
    pak = parse_pak(pak_bytes)
    target_names = set(expected_targets)
    specs = [s for s in DEFAULT_FINGERPRINTS if s.name in target_names]

    matches, _ = find_target_resources(pak, specs, strict=True)
    for name in target_names:
        m = matches[name]
        if not has_crpdf_patch(m.text):
            raise PatchError(
                f"Verification failed: target '{name}' (id={m.resource_id}) "
                f"is missing CRPDF patch markers"
            )
        # Ensure markers are balanced (strip_existing_patch validates balance)
        strip_existing_patch(m.text)

    return {
        **stats,
        "verified_targets": {
            name: matches[name].resource_id for name in sorted(target_names)
        },
    }


def _atomic_write_bytes(dest: Path, data: bytes) -> None:
    """Atomically write `data` to `dest` via a temp file in the same directory."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".crpdf_pak_", suffix=".tmp", dir=str(dest.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, dest)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="patch_pak.py",
        description="Cr-PDF Chromium/CEF DataPack v5 (resources.pak) patcher and inspector.",
    )
    parser.add_argument(
        "--input",
        required=True,
        type=Path,
        help="Path to input resources.pak",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Path to output patched .pak (supports in-place --input == --output)",
    )
    parser.add_argument(
        "--patches",
        type=Path,
        help="Directory containing crpdf_main.js, crpdf_plugin_wrapper.js, and optional crpdf_style.css",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Validate DataPack v5 structure (and verify injected markers when patching)",
    )
    parser.add_argument(
        "--inspect",
        action="store_true",
        help="Inspect input .pak and print JSON summary including matched PDF targets",
    )
    parser.add_argument(
        "--unpack",
        type=Path,
        help="Unpack all canonical resources and manifest.json into the given directory",
    )
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="Allow --patches to contain only a subset of patch files",
    )
    parser.add_argument(
        "--compression",
        choices=("preserve", "raw", "gzip", "brotli"),
        default="preserve",
        help="Compression mode for modified entries (default: preserve)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        if not args.input.is_file():
            raise PakError(f"Input file not found: {args.input}")

        pak_bytes = args.input.read_bytes()

        did_action = False

        if args.inspect:
            report = inspect_pak_bytes(pak_bytes)
            print(json.dumps(report, indent=2, ensure_ascii=False))
            did_action = True

        if args.unpack is not None:
            manifest = unpack_pak_to_dir(pak_bytes, args.unpack)
            print(
                f"Unpacked {manifest['resource_count']} resources "
                f"({manifest['alias_count']} aliases) to {args.unpack}"
            )
            did_action = True

        if args.output is not None or args.patches is not None:
            if args.output is None or args.patches is None:
                raise PakError("Both --output and --patches are required for patching.")
            patched_bytes, report = patch_pak_bytes(
                pak_bytes,
                args.patches,
                allow_partial=args.allow_partial,
                compression=args.compression,
            )
            _atomic_write_bytes(args.output, patched_bytes)
            did_action = True

            if args.verify:
                reloaded = args.output.read_bytes()
                verify_report = verify_patched_pak(
                    reloaded, report["patched_targets"].keys()
                )
                report["verified"] = verify_report["verified_targets"]

            print(json.dumps(report, indent=2, ensure_ascii=False))
        elif args.verify:
            stats = validate_pak(pak_bytes)
            print(json.dumps({"valid": True, **stats}, indent=2, ensure_ascii=False))
            did_action = True

        if not did_action:
            parser.error(
                "Specify at least one action: --output + --patches, --inspect, --unpack, or --verify."
            )

        return EXIT_OK

    except PakError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return exc.exit_code
    except OSError as exc:
        print(f"I/O ERROR: {exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
