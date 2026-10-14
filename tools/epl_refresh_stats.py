#!/usr/bin/env python3
"""PC side of the EPL pipeline: refresh the statistics and ship them to the server.

  python -I tools/epl_refresh_stats.py [--host hoh] [--skip-collect] [--no-upload] [--log FILE]

The Premier League stats API and Fantasy refuse the Russian server's IP, so the statistics are refreshed
here (epl_collect.py all: only new or stale files are downloaded), the xG model is refitted
(epl_xg.py), and normalized/ goes to the server as one archive, where deploy/epl/receive_stats.sh swaps
it in under the same lock as the line job. Windows Task Scheduler runs this every few hours with
pythonw.exe and --log (no console windows; ssh/scp of Git for Windows, as in the manual runs).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import epl_collect as epl  # noqa: E402

TOOLS = Path(__file__).resolve().parent
REMOTE_BASE = "/opt/hoh-epl"
SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"]
GIT_TOOLS = Path(r"C:\Program Files\Git\usr\bin")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def run(command: list[str], *, timeout: int) -> None:
    started = time.monotonic()
    epl.log(f"$ {' '.join(command[:4])}{' …' if len(command) > 4 else ''}")
    sys.stdout.flush()
    subprocess.run(command, check=True, timeout=timeout, stdout=sys.stdout, stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
    epl.log(f"  done in {time.monotonic() - started:.0f}s")


def archive_normalized(target: Path) -> int:
    files = sorted(p for p in epl.NORM.glob("*.json") if p.is_file())
    with tarfile.open(target, "w:gz", compresslevel=6) as tar:
        for path in files:
            tar.add(path, arcname=path.name)
    return len(files)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="hoh", help="ssh alias of the server")
    parser.add_argument("--skip-collect", action="store_true", help="only upload what is already built")
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--log", help="append all output to this file (for the scheduled run)")
    args = parser.parse_args(argv)
    if args.log:
        Path(args.log).parent.mkdir(parents=True, exist_ok=True)
        sys.stdout = sys.stderr = open(args.log, "a", encoding="utf-8", buffering=1)
        epl.log(f"=== {epl.now_iso()} refresh")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
    if GIT_TOOLS.exists():  # the same ssh/scp (and ~/.ssh/config) as the manual runs from Git Bash
        os.environ["PATH"] = f"{GIT_TOOLS}{os.pathsep}{os.environ.get('PATH', '')}"
    python = str(Path(sys.executable).with_name("python.exe")) if sys.executable.lower().endswith("pythonw.exe") else sys.executable
    if not args.skip_collect:
        run([python, "-I", str(TOOLS / "epl_collect.py"), "all"], timeout=3 * 3600)
        run([python, "-I", str(TOOLS / "epl_xg.py")], timeout=1800)
    if args.no_upload:
        return 0
    with tempfile.TemporaryDirectory() as folder:
        archive = Path(folder) / "normalized.tar.gz"
        count = archive_normalized(archive)
        epl.log(f"archive: {count} files, {archive.stat().st_size / 1e6:.1f} MB")
        run(["ssh", *SSH_OPTIONS, args.host, f"mkdir -p {REMOTE_BASE}/incoming"], timeout=120)
        run(["scp", *SSH_OPTIONS, "-q", str(archive), f"{args.host}:{REMOTE_BASE}/incoming/normalized.tar.gz"], timeout=900)
        run(["ssh", *SSH_OPTIONS, args.host, f"sh {REMOTE_BASE}/repo/deploy/epl/receive_stats.sh {REMOTE_BASE}/incoming/normalized.tar.gz"],
            timeout=1200)
    return 0


if __name__ == "__main__":
    sys.exit(main())
