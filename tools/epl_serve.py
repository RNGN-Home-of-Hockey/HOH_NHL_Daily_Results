#!/usr/bin/env python3
"""Serve the operator site locally: epl-site/ as the site, local-data/epl/site/ as /data/.

  python -I tools/epl_serve.py [--port 8780] [--host 127.0.0.1]

Read-only and for development. On a server put epl-site/ behind any web server and copy the
site.json that tools/epl_site_data.py builds into its data/ folder.
"""
from __future__ import annotations

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "epl-site"
DATA = ROOT / "local-data" / "epl" / "site"


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/data/"):
            target = (DATA / clean[len("/data/"):]).resolve()
            return str(target if DATA.resolve() in target.parents or target == DATA.resolve() else DATA / "missing")
        return super().translate_path(path)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=str(SITE))
    print(f"EPL operator site: http://{args.host}:{args.port}/  (data from {DATA})", flush=True)
    ThreadingHTTPServer((args.host, args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
