#!/usr/bin/env python3
"""Download, verify (SHA1), and extract CEF 150 minimal binary distribution."""

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request

CEF_VERSION = "150.0.24+g62e98ba+chromium-150.0.7871.289"
CEF_BASE_URL = "https://cef-builds.spotifycdn.com"
KNOWN_SHA1 = {
    "linux64": "108d037b0d4c8014ece83f56c2efddf7491d1123",
    "windows64": "bb62ad2417bb0844338c0e781b8407d0873184e3",
}


def detect_platform() -> str:
    if sys.platform.startswith("win"):
        return "windows64"
    if sys.platform.startswith("linux"):
        return "linux64"
    raise RuntimeError(f"Unsupported host platform: {sys.platform}. Pass --platform explicitly.")


def is_already_extracted(dest: Path, version: str, plat: str) -> bool:
    marker = dest / ".cef_version"
    if not marker.is_file():
        return False
    expected = f"{version}:{plat}"
    if marker.read_text(encoding="utf-8").strip() != expected:
        return False
    return (
        (dest / "CMakeLists.txt").is_file()
        and (dest / "Release").is_dir()
        and (dest / "Resources" / "resources.pak").is_file()
    )


def fetch_expected_sha1(sha1_url: str, version: str, plat: str) -> str:
    try:
        req = urllib.request.Request(sha1_url, headers={"User-Agent": "Cr-PDF-fetch-cef/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode("ascii", errors="strict").strip().lower()
            digest = text.split()[0] if text else ""
            if len(digest) == 40 and all(c in "0123456789abcdef" for c in digest):
                return digest
            raise ValueError(f"Unexpected .sha1 content: {text!r}")
    except Exception as exc:
        if version == CEF_VERSION and plat in KNOWN_SHA1:
            print(f"[fetch_cef] Warning: failed to fetch {sha1_url} ({exc}); using known SHA1.")
            return KNOWN_SHA1[plat]
        raise


def download_and_verify(url: str, archive_path: Path, expected_sha1: str) -> None:
    part_path = archive_path.with_name(archive_path.name + ".part")
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    if part_path.exists():
        part_path.unlink()

    print(f"[fetch_cef] Downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Cr-PDF-fetch-cef/1.0"})
    hasher = hashlib.sha1()
    total_bytes = 0
    next_report_mb = 25

    try:
        with urllib.request.urlopen(req, timeout=120) as resp, open(part_path, "wb") as out:
            content_length = resp.headers.get("Content-Length")
            total_mb = int(content_length) / (1024 * 1024) if content_length and content_length.isdigit() else 0.0
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                hasher.update(chunk)
                total_bytes += len(chunk)
                cur_mb = total_bytes / (1024 * 1024)
                if cur_mb >= next_report_mb:
                    if total_mb > 0:
                        print(f"[fetch_cef]   {cur_mb:.1f} / {total_mb:.1f} MiB", flush=True)
                    else:
                        print(f"[fetch_cef]   {cur_mb:.1f} MiB", flush=True)
                    next_report_mb += 25
    except Exception:
        if part_path.exists():
            part_path.unlink()
        raise

    computed = hasher.hexdigest().lower()
    if computed != expected_sha1:
        part_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"SHA1 mismatch for {archive_path.name}: expected {expected_sha1}, got {computed}"
        )

    print(f"[fetch_cef] Verified SHA1 ({computed}), {total_bytes / (1024 * 1024):.1f} MiB.")
    os.replace(part_path, archive_path)


def safe_extract_strip_top(archive_path: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    dest_resolved = dest.resolve()

    print(f"[fetch_cef] Extracting {archive_path.name} -> {dest} ...")
    with tarfile.open(archive_path, "r:bz2") as tf:
        for member in tf.getmembers():
            # Normalize POSIX path separators and strip top-level directory.
            raw_parts = [p for p in member.name.replace("\\", "/").split("/") if p and p != "."]
            if len(raw_parts) <= 1:
                continue
            rel_parts = raw_parts[1:]
            if any(p == ".." for p in rel_parts):
                raise RuntimeError(f"Unsafe tar member path: {member.name}")

            rel_path = "/".join(rel_parts)
            target = (dest / rel_path).resolve()
            if not str(target).startswith(str(dest_resolved) + os.sep) and target != dest_resolved:
                raise RuntimeError(f"Tar slip detected: {member.name} -> {target}")

            member.name = rel_path
            if member.issym() or member.islnk():
                link_target = member.linkname.replace("\\", "/")
                if member.islnk():
                    link_parts = [p for p in link_target.split("/") if p and p != "."]
                    if len(link_parts) > 1:
                        member.linkname = "/".join(link_parts[1:])
            tf.extract(member, path=dest)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch CEF 150 minimal binary distribution.")
    parser.add_argument(
        "--platform",
        choices=["linux64", "windows64"],
        default=None,
        help="Target CEF platform (default: auto-detect).",
    )
    parser.add_argument(
        "--dest",
        default="third_party/cef",
        help="Destination directory (default: third_party/cef).",
    )
    parser.add_argument(
        "--version",
        default=CEF_VERSION,
        help=f"CEF version string (default: {CEF_VERSION}).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download and overwrite even if already extracted.",
    )
    parser.add_argument(
        "--keep-archive",
        action="store_true",
        help="Keep the downloaded .tar.bz2 archive after extraction.",
    )
    args = parser.parse_args()

    plat = args.platform or detect_platform()
    dest = Path(args.dest)
    version = args.version

    if not args.force and is_already_extracted(dest, version, plat):
        print(f"[fetch_cef] Already extracted at {dest} ({version} / {plat}); skipping.")
        return 0

    filename = f"cef_binary_{version}_{plat}_minimal.tar.bz2"
    url = f"{CEF_BASE_URL}/{urllib.parse.quote(filename)}"
    sha1_url = f"{url}.sha1"
    archive_path = dest.parent / filename

    expected_sha1 = fetch_expected_sha1(sha1_url, version, plat)

    # Reuse an already-downloaded archive only if its SHA1 matches.
    need_download = True
    if archive_path.is_file():
        h = hashlib.sha1()
        with open(archive_path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        if h.hexdigest().lower() == expected_sha1:
            print(f"[fetch_cef] Reusing verified local archive {archive_path}.")
            need_download = False
        else:
            archive_path.unlink(missing_ok=True)

    if need_download:
        download_and_verify(url, archive_path, expected_sha1)

    safe_extract_strip_top(archive_path, dest)

    # Post-extraction sanity check.
    for req_path in [dest / "CMakeLists.txt", dest / "Release", dest / "Resources" / "resources.pak"]:
        if not req_path.exists():
            raise RuntimeError(f"Extraction incomplete: missing {req_path}")

    (dest / ".cef_version").write_text(f"{version}:{plat}\n", encoding="utf-8")

    if not args.keep_archive and archive_path.exists():
        archive_path.unlink()
        print(f"[fetch_cef] Removed archive {archive_path} to save disk space.")

    print(f"[fetch_cef] Ready at {dest} ({version} / {plat}).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"[fetch_cef] ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
