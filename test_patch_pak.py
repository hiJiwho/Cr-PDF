#!/usr/bin/env python3
"""Unit tests for scripts/patch_pak.py (DataPack v5 parser, patcher & CLI)."""

from __future__ import annotations

import gzip
import io
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import patch_pak  # noqa: E402


# Realistic Chromium 150 PDF viewer JS fixtures
SAMPLE_MAIN_JS = """\
import './pdf_viewer_wrapper.js';
import {createBrowserApi} from './browser_api.js';
function initViewer(browserApi) {
  const viewer = document.querySelector('#viewer');
  chrome.contentSettings.javascript.get({}, () => {});
  Object.assign(window, {viewer});
}
"""

SAMPLE_MAIN_PRINT_JS = """\
import './pdf_print_wrapper.js';
import {createBrowserApiForPrintPreview} from './browser_api.js';
function initViewer(browserApi) {
  const viewer = document.querySelector('#viewer');
  Object.assign(window, {viewer});
}
"""

SAMPLE_INDEX_HTML = """\
<!doctype html>
<html>
<head><script type="module" src="main.js"></script></head>
<body><pdf-viewer id="viewer"></pdf-viewer></body>
</html>
"""

SAMPLE_PLUGIN_WRAPPER_JS = """\
(function(){const a=new MessageChannel;window.parent.postMessage({type:"init"},"chrome-untrusted://print",[a.port2]);const b=["syncScrollToRemote","ackScrollToRemote","syncScrollFromRemote"];a.port1.onmessage=e=>{void b;void e;};})();
"""

SAMPLE_VIEWER_WRAPPER_JS = """\
export function syncScrollToRemote(){}
export function ackScrollToRemote(){}
export function syncScrollFromRemote(){}
"""

SAMPLE_PRINT_WRAPPER_JS = """\
const el = document.querySelector('pdf-viewer-print');
window.parent.postMessage({type:"syncScrollToRemote"},"chrome-untrusted://print");
const x = ["ackScrollToRemote","syncScrollFromRemote"];
"""

# Pre-baked valid uncompressed Brotli metablock for b"hello brotli" (12 bytes)
# Works for header/magic detection tests even if no brotli encoder is installed.
PREBAKED_BROTLI_PLAIN = b"hello brotli"
PREBAKED_BROTLI_STREAM = b"\x8f\x05\x80hello brotli\x03"
PREBAKED_CHROMIUM_BROTLI = (
    patch_pak.CHROMIUM_BROTLI_MAGIC
    + len(PREBAKED_BROTLI_PLAIN).to_bytes(6, "little")
    + PREBAKED_BROTLI_STREAM
)


def _has_brotli_backend() -> bool:
    return (
        patch_pak._get_python_brotli() is not None
        or patch_pak._get_brotli_cli() is not None
    )


def _make_standard_pak(
    *,
    main_compression: str = "raw",
    wrapper_compression: str = "raw",
    extra_resources: dict[int, bytes] | None = None,
) -> bytes:
    resources: dict[int, bytes] = {
        100: SAMPLE_INDEX_HTML.encode("utf-8"),
        200: patch_pak.compress_entry(
            SAMPLE_MAIN_JS.encode("utf-8"), mode=main_compression
        ),
        201: SAMPLE_MAIN_PRINT_JS.encode("utf-8"),
        300: patch_pak.compress_entry(
            SAMPLE_PLUGIN_WRAPPER_JS.encode("utf-8"), mode=wrapper_compression
        ),
        301: SAMPLE_VIEWER_WRAPPER_JS.encode("utf-8"),
        302: SAMPLE_PRINT_WRAPPER_JS.encode("utf-8"),
        400: b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRbinarydata",
    }
    if extra_resources:
        resources.update(extra_resources)
    return patch_pak.serialize_pak(resources, encoding=1)


def _write_patches(
    patches_dir: Path,
    *,
    main_js: str | None = "console.log('crpdf_main_loaded');",
    wrapper_js: str | None = "console.log('crpdf_wrapper_loaded');",
    style_css: str | None = "viewer-toolbar { display: flex; }",
) -> None:
    patches_dir.mkdir(parents=True, exist_ok=True)
    if main_js is not None:
        (patches_dir / "crpdf_main.js").write_text(main_js, encoding="utf-8")
    if wrapper_js is not None:
        (patches_dir / "crpdf_plugin_wrapper.js").write_text(
            wrapper_js, encoding="utf-8"
        )
    if style_css is not None:
        (patches_dir / "crpdf_style.css").write_text(style_css, encoding="utf-8")


class TestDataPackV5Format(unittest.TestCase):
    """Tests for DataPack v5 binary serialization, parsing, aliases, and validation."""

    def test_synthetic_round_trip_raw_gzip_and_brotli(self) -> None:
        raw_payload = b"plain utf8 resource"
        gzip_payload = gzip.compress(b"gzipped resource content", compresslevel=6, mtime=0)
        resources = {
            10: raw_payload,
            20: gzip_payload,
            30: PREBAKED_CHROMIUM_BROTLI,
        }
        pak_bytes = patch_pak.serialize_pak(resources, encoding=1)

        stats = patch_pak.validate_pak(pak_bytes)
        self.assertEqual(stats["version"], 5)
        self.assertEqual(stats["encoding"], 1)
        self.assertEqual(stats["resource_count"], 3)
        self.assertEqual(stats["alias_count"], 0)
        self.assertEqual(stats["file_size"], len(pak_bytes))

        parsed = patch_pak.parse_pak(pak_bytes)
        self.assertEqual(parsed.resources[10], raw_payload)
        self.assertEqual(parsed.resources[20], gzip_payload)
        self.assertEqual(parsed.resources[30], PREBAKED_CHROMIUM_BROTLI)

        self.assertEqual(patch_pak.detect_compression(parsed.resources[10]), "raw")
        self.assertEqual(patch_pak.detect_compression(parsed.resources[20]), "gzip")
        self.assertEqual(patch_pak.detect_compression(parsed.resources[30]), "brotli")

        dec_raw, kind_raw = patch_pak.decompress_entry(parsed.resources[10])
        self.assertEqual((dec_raw, kind_raw), (raw_payload, "raw"))

        dec_gz, kind_gz = patch_pak.decompress_entry(parsed.resources[20])
        self.assertEqual((dec_gz, kind_gz), (b"gzipped resource content", "gzip"))

        if _has_brotli_backend():
            dec_br, kind_br = patch_pak.decompress_entry(parsed.resources[30])
            self.assertEqual((dec_br, kind_br), (PREBAKED_BROTLI_PLAIN, "brotli"))

    def test_alias_preservation_and_deduplication(self) -> None:
        shared = b"shared identical resource bytes"
        resources = {
            500: shared,
            100: shared,
            300: shared,
            200: b"unique two hundred",
            400: b"unique four hundred",
        }
        pak_bytes = patch_pak.serialize_pak(resources, encoding=1)
        stats = patch_pak.validate_pak(pak_bytes)
        self.assertEqual(stats["resource_count"], 3)
        self.assertEqual(stats["alias_count"], 2)

        parsed = patch_pak.parse_pak(pak_bytes)
        self.assertEqual(parsed.canonical_ids, [100, 200, 400])
        self.assertEqual(parsed.aliases, {300: 100, 500: 100})
        for rid in (100, 300, 500):
            self.assertEqual(parsed.resources[rid], shared)

    def test_patching_aliased_target_detaches_without_corrupting_alias(self) -> None:
        # Resource 50 is canonical for main.js; resource 500 is an alias of 50.
        main_bytes = SAMPLE_MAIN_JS.encode("utf-8")
        pak_bytes = patch_pak.serialize_pak(
            {
                50: main_bytes,
                500: main_bytes,
                300: SAMPLE_PLUGIN_WRAPPER_JS.encode("utf-8"),
            },
            encoding=1,
        )
        parsed_before = patch_pak.parse_pak(pak_bytes)
        self.assertEqual(parsed_before.aliases, {500: 50})

        with tempfile.TemporaryDirectory() as tmp:
            pdir = Path(tmp) / "patches"
            _write_patches(pdir)
            patched_bytes, _ = patch_pak.patch_pak_bytes(pak_bytes, pdir)

        parsed_after = patch_pak.parse_pak(patched_bytes)
        # Canonical 50 was patched, so 500 is detached and still holds original bytes
        self.assertEqual(parsed_after.aliases, {})
        self.assertEqual(parsed_after.resources[500], main_bytes)
        self.assertIn(
            patch_pak.PATCH_START.encode("utf-8"), parsed_after.resources[50]
        )

    def test_corrupt_pak_validation_rejections(self) -> None:
        valid_pak = _make_standard_pak()

        # 1. Truncated header (<12 bytes)
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(b"\x05\x00\x00\x00")

        # 2. Wrong version (4 and 99)
        for bad_ver in (4, 99):
            bad = bytearray(valid_pak)
            struct.pack_into("<I", bad, 0, bad_ver)
            with self.assertRaises(patch_pak.PakFormatError):
                patch_pak.validate_pak(bytes(bad))

        # 3. Invalid encoding (5)
        bad = bytearray(valid_pak)
        bad[4] = 5
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(bytes(bad))

        # 4. Non-zero reserved padding bytes
        bad = bytearray(valid_pak)
        bad[6] = 0xFF
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(bytes(bad))

        # 5. Unsorted resource IDs (swap entry 0 and entry 1 IDs)
        bad = bytearray(valid_pak)
        id0, off0 = struct.unpack_from("<HI", bad, 12)
        id1, off1 = struct.unpack_from("<HI", bad, 18)
        struct.pack_into("<HI", bad, 12, id1, off0)
        struct.pack_into("<HI", bad, 18, id0, off1)
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(bytes(bad))

        # 6. Non-decreasing offset violation
        bad = bytearray(valid_pak)
        id0, off0 = struct.unpack_from("<HI", bad, 12)
        id1, off1 = struct.unpack_from("<HI", bad, 18)
        struct.pack_into("<HI", bad, 12, id0, off1)
        struct.pack_into("<HI", bad, 18, id1, off0)
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(bytes(bad))

        # 7. Wrong sentinel ID (!= 0)
        stats = patch_pak.validate_pak(valid_pak)
        sentinel_pos = 12 + int(stats["resource_count"]) * 6
        bad = bytearray(valid_pak)
        struct.pack_into("<H", bad, sentinel_pos, 999)
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(bytes(bad))

        # 8. Wrong sentinel offset (!= file_size)
        bad = bytearray(valid_pak)
        struct.pack_into("<I", bad, sentinel_pos + 2, len(valid_pak) - 1)
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(bytes(bad))

        # 9. Alias table errors: out-of-range index, unsorted alias IDs, colliding alias ID
        aliased_pak = patch_pak.serialize_pak(
            {10: b"dup", 20: b"dup", 30: b"dup", 40: b"other"}, encoding=1
        )
        # resource_count=2 (IDs 10, 40), alias_count=2 (IDs 20->0, 30->0)
        alias_pos = 12 + (2 + 1) * 6

        # 9a. Out-of-range entry_index
        bad = bytearray(aliased_pak)
        struct.pack_into("<HH", bad, alias_pos, 20, 99)
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(bytes(bad))

        # 9b. Unsorted alias IDs
        bad = bytearray(aliased_pak)
        struct.pack_into("<HH", bad, alias_pos, 30, 0)
        struct.pack_into("<HH", bad, alias_pos + 4, 20, 0)
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(bytes(bad))

        # 9c. Alias ID colliding with primary resource ID (40)
        bad = bytearray(aliased_pak)
        struct.pack_into("<HH", bad, alias_pos + 4, 40, 0)
        with self.assertRaises(patch_pak.PakFormatError):
            patch_pak.validate_pak(bytes(bad))


class TestFingerprintingAndPatching(unittest.TestCase):
    """Tests for fingerprint matching, compression preservation, and idempotency."""

    def test_fingerprint_matches_main_and_wrapper_excluding_distractors(self) -> None:
        pak_bytes = _make_standard_pak()
        pak = patch_pak.parse_pak(pak_bytes)
        matches, skipped = patch_pak.find_target_resources(pak)
        self.assertEqual(skipped, [])
        self.assertEqual(matches["main.js"].resource_id, 200)
        self.assertEqual(matches["pdf_internal_plugin_wrapper.js"].resource_id, 300)

    def test_fingerprint_zero_matches_raises(self) -> None:
        pak_bytes = patch_pak.serialize_pak(
            {1: b"console.log('nothing here');"}, encoding=1
        )
        pak = patch_pak.parse_pak(pak_bytes)
        with self.assertRaises(patch_pak.FingerprintError) as ctx:
            patch_pak.find_target_resources(pak)
        self.assertEqual(ctx.exception.exit_code, patch_pak.EXIT_FINGERPRINT_ERROR)

    def test_fingerprint_ambiguous_matches_raises(self) -> None:
        pak_bytes = _make_standard_pak(
            extra_resources={
                250: (SAMPLE_MAIN_JS + "\n// duplicate copy\n").encode("utf-8"),
            }
        )
        pak = patch_pak.parse_pak(pak_bytes)
        with self.assertRaises(patch_pak.FingerprintError) as ctx:
            patch_pak.find_target_resources(pak)
        self.assertEqual(ctx.exception.exit_code, patch_pak.EXIT_FINGERPRINT_ERROR)
        self.assertIn("200", str(ctx.exception))
        self.assertIn("250", str(ctx.exception))

    def test_idempotent_double_patching_byte_identical(self) -> None:
        pak_bytes = _make_standard_pak(
            main_compression="gzip", wrapper_compression="raw"
        )
        with tempfile.TemporaryDirectory() as tmp:
            pdir = Path(tmp) / "patches"
            _write_patches(pdir)

            out1, report1 = patch_pak.patch_pak_bytes(pak_bytes, pdir)
            out2, report2 = patch_pak.patch_pak_bytes(out1, pdir)

            self.assertEqual(out1, out2)
            self.assertEqual(
                report1["patched_targets"]["main.js"]["output_compression"], "gzip"
            )
            self.assertEqual(
                report2["patched_targets"]["pdf_internal_plugin_wrapper.js"][
                    "output_compression"
                ],
                "raw",
            )

    def test_safe_css_escaping_and_trailing_line_comment_guard(self) -> None:
        tricky_css = (
            "/* 한글 주석 */\n"
            ".a::after { content: \"`backticks` ${expr} 'single' \\\\ </script>\"; }\n"
            "/* separators: \u2028 and \u2029 */"
        )
        original_with_comment = SAMPLE_MAIN_JS.rstrip() + "\n// trailing comment without newline"
        injected = patch_pak.inject_patch(
            original_with_comment,
            "console.log(globalThis.__CRPDF_STYLE_CSS__);",
            css_text=tricky_css,
        )
        # Ensure PATCH_START is on its own line (not swallowed by `//`)
        self.assertIn(
            "// trailing comment without newline\n/* CRPDF_PATCH_START */\n",
            injected,
        )
        # Ensure CSS literal is ASCII-escaped JSON string with `/` neutralized (safe in JS)
        expected_literal = json.dumps(tricky_css, ensure_ascii=True).replace("/", "\\/")
        self.assertEqual(json.loads(expected_literal), tricky_css)
        self.assertIn(
            f"globalThis.__CRPDF_STYLE_CSS__ = {expected_literal};", injected
        )
        # Verify raw U+2028 / U+2029 do not appear unescaped
        self.assertNotIn("\u2028", injected)
        self.assertNotIn("\u2029", injected)

        # Stripping recovers original cleanly
        stripped = patch_pak.strip_existing_patch(injected)
        self.assertEqual(stripped, original_with_comment)

    def test_unbalanced_markers_raise_patch_error(self) -> None:
        cases = [
            f"code();\n{patch_pak.PATCH_START}\nmissing end",
            f"code();\n{patch_pak.PATCH_END}\nmissing start",
            f"{patch_pak.PATCH_END}\n{patch_pak.PATCH_START}",
            f"{patch_pak.PATCH_START}\n{patch_pak.PATCH_START}\n{patch_pak.PATCH_END}",
        ]
        for bad_text in cases:
            with self.assertRaises(patch_pak.PatchError):
                patch_pak.strip_existing_patch(bad_text)

    def test_brotli_round_trip_when_available(self) -> None:
        if not _has_brotli_backend():
            self.skipTest("No Brotli backend installed")

        pak_bytes = _make_standard_pak(
            main_compression="brotli", wrapper_compression="brotli"
        )
        with tempfile.TemporaryDirectory() as tmp:
            pdir = Path(tmp) / "patches"
            _write_patches(pdir)
            patched, report = patch_pak.patch_pak_bytes(
                pak_bytes, pdir, compression="preserve"
            )
            self.assertEqual(
                report["patched_targets"]["main.js"]["output_compression"], "brotli"
            )
            verified = patch_pak.verify_patched_pak(
                patched, ["main.js", "pdf_internal_plugin_wrapper.js"]
            )
            self.assertEqual(verified["verified_targets"]["main.js"], 200)

    def test_brotli_unavailable_handling(self) -> None:
        # 1. Unrelated Brotli entry does NOT block patching raw/gzip targets
        pak_with_unrelated_br = _make_standard_pak(
            main_compression="gzip",
            wrapper_compression="raw",
            extra_resources={999: PREBAKED_CHROMIUM_BROTLI},
        )
        with tempfile.TemporaryDirectory() as tmp:
            pdir = Path(tmp) / "patches"
            _write_patches(pdir)
            with (
                mock.patch.object(patch_pak, "_get_python_brotli", return_value=None),
                mock.patch.object(patch_pak, "_get_brotli_cli", return_value=None),
            ):
                patched, report = patch_pak.patch_pak_bytes(
                    pak_with_unrelated_br, pdir
                )
                self.assertEqual(report["skipped_brotli_count"], 1)
                # Unrelated brotli entry preserved verbatim
                parsed = patch_pak.parse_pak(patched)
                self.assertEqual(parsed.resources[999], PREBAKED_CHROMIUM_BROTLI)

        # 2. Target missing while Brotli entries exist raises BrotliUnavailableError (exit 3)
        pak_missing_target_with_br = patch_pak.serialize_pak(
            {999: PREBAKED_CHROMIUM_BROTLI}, encoding=1
        )
        with (
            mock.patch.object(patch_pak, "_get_python_brotli", return_value=None),
            mock.patch.object(patch_pak, "_get_brotli_cli", return_value=None),
        ):
            pak = patch_pak.parse_pak(pak_missing_target_with_br)
            with self.assertRaises(patch_pak.BrotliUnavailableError) as ctx:
                patch_pak.find_target_resources(pak)
            self.assertEqual(
                ctx.exception.exit_code, patch_pak.EXIT_BROTLI_UNAVAILABLE
            )

    def test_idempotent_crlf_trailing_blank_lines_and_line_endings(self) -> None:
        sources = [
            "const a = 1;\r\n",
            "const a = 1;\r\n\r\n",
            "const a = 1;\n\n",
            "const a = 1;\n",
            "const a = 1;",
            "const a = 1; // comment",
            "",
        ]
        for src in sources:
            with self.subTest(src=src):
                p1 = patch_pak.inject_patch(src, "console.log(1);", css_text="body{color:red;}")
                p2 = patch_pak.inject_patch(p1, "console.log(1);", css_text="body{color:red;}")
                self.assertEqual(p1, p2)
                self.assertEqual(patch_pak.strip_existing_patch(p1), src)
                self.assertTrue(patch_pak.has_crpdf_patch(p1))

    def test_patch_marker_substrings_in_css_neutralized_and_in_js_rejected(self) -> None:
        adversarial_css = (
            f"{patch_pak.PATCH_START}\n"
            f"{patch_pak.PATCH_END}\n"
            "body::after { content: '</script> \\/ \\\\/'; }"
        )
        base = "const x = 1;\n"
        p1 = patch_pak.inject_patch(base, "console.log(1);", css_text=adversarial_css)
        p2 = patch_pak.inject_patch(p1, "console.log(1);", css_text=adversarial_css)

        self.assertEqual(p1, p2)
        self.assertTrue(patch_pak.has_crpdf_patch(p1))
        self.assertEqual(patch_pak.strip_existing_patch(p1), base)

        # Verify the embedded JSON string evaluates back to the exact original CSS
        prefix = "globalThis.__CRPDF_STYLE_CSS__ = "
        line = next(ln for ln in p1.splitlines() if ln.startswith(prefix))
        literal = line[len(prefix) : -1]
        self.assertEqual(json.loads(literal), adversarial_css)

        # js_code containing literal patch markers must be rejected up front
        for bad_js in (
            f"// {patch_pak.PATCH_START}\nconsole.log(1);",
            f"// {patch_pak.PATCH_END}\nconsole.log(1);",
        ):
            with self.assertRaises(patch_pak.PatchError):
                patch_pak.inject_patch(base, bad_js, css_text="body{}")

    def test_false_positive_gzip_and_brotli_magic_binary_entries(self) -> None:
        fake_gzip_blob = b"\x1f\x8bNOT_GZIP_BINARY_BLOB_123456"
        fake_brotli_blob = b"\x1e\x9b\x10\x00\x00\x00\x00\x00NOT_A_VALID_BROTLI_STREAM"

        pak_bytes = _make_standard_pak(
            main_compression="gzip",
            wrapper_compression="raw",
            extra_resources={
                901: fake_gzip_blob,
                902: fake_brotli_blob,
            },
        )

        # 1. _brotli_decompress_raw wraps Python brotli errors into PakFormatError
        class _FakeBrotliError(Exception):
            pass

        class _FakeBrotliMod:
            @staticmethod
            def decompress(_data: bytes) -> bytes:
                raise _FakeBrotliError("corrupt stream")

        with mock.patch.object(
            patch_pak, "_get_python_brotli", return_value=_FakeBrotliMod
        ):
            with self.assertRaises(patch_pak.PakFormatError):
                patch_pak._brotli_decompress_raw(b"not-brotli")

        # 2. find_target_resources, patch_pak_bytes, and unpack_pak_to_dir handle
        # false-positive gzip/brotli binary blobs gracefully without crashing
        with mock.patch.object(
            patch_pak, "_get_python_brotli", return_value=_FakeBrotliMod
        ):
            pak = patch_pak.parse_pak(pak_bytes)
            matches, _ = patch_pak.find_target_resources(pak, strict=True)
            self.assertEqual(matches["main.js"].resource_id, 200)
            self.assertEqual(matches["pdf_internal_plugin_wrapper.js"].resource_id, 300)

            with tempfile.TemporaryDirectory() as tmp:
                tmp_path = Path(tmp)
                pdir = tmp_path / "patches"
                _write_patches(pdir)
                patched, _ = patch_pak.patch_pak_bytes(pak_bytes, pdir)
                parsed_patched = patch_pak.parse_pak(patched)
                self.assertEqual(parsed_patched.resources[901], fake_gzip_blob)
                self.assertEqual(parsed_patched.resources[902], fake_brotli_blob)

                unpack_dir = tmp_path / "unpacked"
                manifest = patch_pak.unpack_pak_to_dir(pak_bytes, unpack_dir)
                by_id = {e["resource_id"]: e for e in manifest["entries"]}
                self.assertEqual(
                    (unpack_dir / by_id[901]["file"]).read_bytes(), fake_gzip_blob
                )
                self.assertEqual(
                    (unpack_dir / by_id[902]["file"]).read_bytes(), fake_brotli_blob
                )

    def test_has_crpdf_patch_requires_single_balanced_block(self) -> None:
        self.assertFalse(patch_pak.has_crpdf_patch("const x = 1;\n"))
        self.assertFalse(patch_pak.has_crpdf_patch(f"{patch_pak.PATCH_START}\nonly start"))
        self.assertFalse(patch_pak.has_crpdf_patch(f"{patch_pak.PATCH_END}\nonly end"))
        self.assertFalse(
            patch_pak.has_crpdf_patch(f"{patch_pak.PATCH_END}\n{patch_pak.PATCH_START}")
        )
        self.assertFalse(
            patch_pak.has_crpdf_patch(
                f"{patch_pak.PATCH_START}\n{patch_pak.PATCH_START}\n{patch_pak.PATCH_END}"
            )
        )
        self.assertFalse(
            patch_pak.has_crpdf_patch(
                f"{patch_pak.PATCH_START}\na\n{patch_pak.PATCH_END}\n"
                f"{patch_pak.PATCH_START}\nb\n{patch_pak.PATCH_END}\n"
            )
        )
        self.assertTrue(
            patch_pak.has_crpdf_patch(
                f"const x = 1;\n{patch_pak.PATCH_START}\nconsole.log(1);\n{patch_pak.PATCH_END}\n"
            )
        )


class TestCLIMode(unittest.TestCase):
    """Tests for patch_pak.py CLI flags and exit codes."""

    def _run_cli(self, argv: list[str]) -> tuple[int, str, str]:
        out_buf = io.StringIO()
        err_buf = io.StringIO()
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            code = patch_pak.main(argv)
        return code, out_buf.getvalue(), err_buf.getvalue()

    def test_cli_inspect_unpack_patch_verify_and_inplace(self) -> None:
        pak_bytes = _make_standard_pak(main_compression="gzip")
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            in_pak = tmp_path / "resources.pak"
            out_pak = tmp_path / "patched.pak"
            unpack_dir = tmp_path / "unpacked"
            patches_dir = tmp_path / "patches"

            in_pak.write_bytes(pak_bytes)
            _write_patches(patches_dir)

            # --inspect
            code, stdout, stderr = self._run_cli(["--input", str(in_pak), "--inspect"])
            self.assertEqual(code, 0, stderr)
            insp = json.loads(stdout)
            self.assertEqual(insp["targets"]["main.js"]["resource_id"], 200)
            self.assertEqual(
                insp["targets"]["pdf_internal_plugin_wrapper.js"]["resource_id"], 300
            )
            self.assertFalse(insp["targets"]["main.js"]["already_patched"])

            # --unpack
            code, stdout, stderr = self._run_cli(
                ["--input", str(in_pak), "--unpack", str(unpack_dir)]
            )
            self.assertEqual(code, 0, stderr)
            manifest = json.loads(
                (unpack_dir / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["targets"]["main.js"], 200)
            self.assertEqual(len(manifest["entries"]), 7)

            # --output + --patches + --verify
            code, stdout, stderr = self._run_cli(
                [
                    "--input",
                    str(in_pak),
                    "--output",
                    str(out_pak),
                    "--patches",
                    str(patches_dir),
                    "--verify",
                ]
            )
            self.assertEqual(code, 0, stderr)
            res = json.loads(stdout)
            self.assertEqual(res["verified"]["main.js"], 200)
            self.assertEqual(
                res["verified"]["pdf_internal_plugin_wrapper.js"], 300
            )

            # Standalone --verify on valid and corrupt pak
            code, stdout, stderr = self._run_cli(["--input", str(out_pak), "--verify"])
            self.assertEqual(code, 0, stderr)
            self.assertTrue(json.loads(stdout)["valid"])

            corrupt_pak = tmp_path / "corrupt.pak"
            corrupt_pak.write_bytes(b"not a valid pak")
            code, _, _ = self._run_cli(["--input", str(corrupt_pak), "--verify"])
            self.assertEqual(code, 1)

            # In-place patching (--input == --output)
            code, stdout, stderr = self._run_cli(
                [
                    "--input",
                    str(out_pak),
                    "--output",
                    str(out_pak),
                    "--patches",
                    str(patches_dir),
                    "--verify",
                ]
            )
            self.assertEqual(code, 0, stderr)

    def test_cli_partial_patch_flag(self) -> None:
        pak_bytes = _make_standard_pak()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            in_pak = tmp_path / "in.pak"
            out_pak = tmp_path / "out.pak"
            patches_dir = tmp_path / "patches"
            in_pak.write_bytes(pak_bytes)
            _write_patches(patches_dir, wrapper_js=None)

            # Without --allow-partial -> exit 1
            code, _, stderr = self._run_cli(
                [
                    "--input",
                    str(in_pak),
                    "--output",
                    str(out_pak),
                    "--patches",
                    str(patches_dir),
                ]
            )
            self.assertEqual(code, 1)
            self.assertIn("Missing required patch file", stderr)

            # With --allow-partial -> exit 0
            code, stdout, stderr = self._run_cli(
                [
                    "--input",
                    str(in_pak),
                    "--output",
                    str(out_pak),
                    "--patches",
                    str(patches_dir),
                    "--allow-partial",
                    "--verify",
                ]
            )
            self.assertEqual(code, 0, stderr)
            res = json.loads(stdout)
            self.assertEqual(list(res["verified"].keys()), ["main.js"])

    def test_cli_subprocess_exit_code_fingerprint_error(self) -> None:
        pak_bytes = patch_pak.serialize_pak({1: b"empty"}, encoding=1)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            in_pak = tmp_path / "in.pak"
            out_pak = tmp_path / "out.pak"
            patches_dir = tmp_path / "patches"
            in_pak.write_bytes(pak_bytes)
            _write_patches(patches_dir)

            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "patch_pak.py"),
                    "--input",
                    str(in_pak),
                    "--output",
                    str(out_pak),
                    "--patches",
                    str(patches_dir),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, patch_pak.EXIT_FINGERPRINT_ERROR)


class TestConditionalRealCefPak(unittest.TestCase):
    """Conditional integration test against real CEF resources.pak if present."""

    def test_real_cef_resources_pak_if_present(self) -> None:
        cef_root = REPO_ROOT / "third_party" / "cef"
        candidates = list(cef_root.rglob("resources.pak")) if cef_root.exists() else []
        if not candidates:
            self.skipTest("CEF resources.pak not downloaded yet under third_party/cef")

        pak_path = candidates[0]
        raw = pak_path.read_bytes()
        stats = patch_pak.validate_pak(raw)
        self.assertEqual(stats["version"], 5)

        pak = patch_pak.parse_pak(raw)
        matches, _ = patch_pak.find_target_resources(pak, strict=True)
        self.assertIn("main.js", matches)
        self.assertIn("pdf_internal_plugin_wrapper.js", matches)

        with tempfile.TemporaryDirectory() as tmp:
            pdir = Path(tmp) / "patches"
            _write_patches(pdir)
            out1, _ = patch_pak.patch_pak_bytes(raw, pdir)
            out2, _ = patch_pak.patch_pak_bytes(out1, pdir)
            self.assertEqual(out1, out2)
            patch_pak.verify_patched_pak(
                out1, ["main.js", "pdf_internal_plugin_wrapper.js"]
            )


if __name__ == "__main__":
    unittest.main()
