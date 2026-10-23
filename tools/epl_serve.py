#!/usr/bin/env python3
"""Serve the operator site locally: epl-site/ as the site, local-data/epl/site/ as /data/.

  python -I tools/epl_serve.py [--port 8780] [--host 127.0.0.1] [--onair http://127.0.0.1:8097]

For development. On a server put epl-site/ behind any web server and copy the site.json that
tools/epl_site_data.py builds into its data/ folder. --onair forwards /api/onair/* to a local
tools/epl_onair.py, so the on-air buttons and overlay.html can be tried without the real channel.
"""
from __future__ import annotations

import argparse
import functools
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "epl-site"
DATA = ROOT / "local-data" / "epl" / "site"
ONAIR = {"url": ""}
# open without a login, as on the server (deploy/epl/epl.caddy, epl-worker): the login page and the OBS overlay
PUBLIC = ("/login.html", "/login.js", "/overlay.html", "/overlay.js", "/plate.js", "/robots.txt", "/favicon.ico", "/assets/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


class Handler(SimpleHTTPRequestHandler):
    def ask(self, path: str, method: str, body: bytes | None, extra: dict | None = None):
        headers = {k: v for k, v in self.headers.items() if k.lower() in ("content-type", "cookie")}
        request = urllib.request.Request(ONAIR["url"] + path, data=body, headers={**headers, **(extra or {})}, method=method)
        try:
            with OPENER.open(request, timeout=10) as answer:
                return answer.status, answer.read(), answer.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    def relay(self, status: int, body: bytes, headers) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        for name in ("Set-Cookie", "Location"):
            if headers.get(name):
                self.send_header(name, headers[name])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def forward(self) -> bool:
        if not (ONAIR["url"] and self.path.startswith("/api/onair/")):
            return False
        length = int(self.headers.get("Content-Length") or 0)
        self.relay(*self.ask(self.path, self.command, self.rfile.read(length) if length else None))
        return True

    def allowed(self) -> bool:
        """With --onair the site is closed without a login, like Caddy's forward_auth on the server."""
        path = self.path.split("?", 1)[0]
        if not ONAIR["url"] or path in PUBLIC or path.startswith("/assets/"):
            return True
        status, body, headers = self.ask("/api/onair/auth", "GET", None, {"X-Forwarded-Uri": self.path})
        if status == 200:
            return True
        self.relay(status, body, headers)
        return False

    def do_GET(self) -> None:
        if not self.forward() and self.allowed():
            super().do_GET()

    def do_POST(self) -> None:
        if not self.forward():
            self.send_error(405)

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
    parser.add_argument("--onair", default="", help="base URL of a local tools/epl_onair.py to forward /api/onair/* to")
    args = parser.parse_args()
    ONAIR["url"] = args.onair.rstrip("/")
    handler = functools.partial(Handler, directory=str(SITE))
    print(f"EPL operator site: http://{args.host}:{args.port}/  (data from {DATA})", flush=True)
    ThreadingHTTPServer((args.host, args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
