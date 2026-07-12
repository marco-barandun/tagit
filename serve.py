#!/usr/bin/env python3
"""Serve docs/ for local development with caching fully disabled.

Plain `python3 -m http.server` sends no Cache-Control header, so a normal
browser refresh (not a hard refresh) can silently reuse an old cached copy of
index.html/app.js/styles.css from a previous edit — a confusing "why isn't my
change showing" trap during active development. This wrapper adds
Cache-Control: no-store to every response so every reload always fetches the
current files on disk. It always serves docs/ next to this script, regardless
of the working directory it's launched from.
"""
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
DOCS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    Handler = functools.partial(NoCacheHandler, directory=DOCS_DIR)
    http.server.test(HandlerClass=Handler, port=PORT)
