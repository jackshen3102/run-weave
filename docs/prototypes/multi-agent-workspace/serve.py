#!/usr/bin/env python3
"""No-cache static server for the prototype.

Always serves the latest files on disk: every response carries
Cache-Control: no-store, so a plain refresh never hits a stale asset.

Usage:
    python3 serve.py            # serves this directory on :6189
    python3 serve.py 6190       # custom port
"""

import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 6189
    directory = str(Path(__file__).resolve().parent)
    handler = partial(NoCacheHandler, directory=directory)
    server = HTTPServer(("127.0.0.1", port), handler)
    print(f"no-cache prototype server on http://127.0.0.1:{port}/ (dir: {directory})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
