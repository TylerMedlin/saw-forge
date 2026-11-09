#!/usr/bin/env python3
"""Local server for Saw Forge Studio.

Serves the app on http://127.0.0.1:8765 with the headers it needs:
  * Cross-origin isolation (COOP/COEP), so SharedArrayBuffer is available and
    the audio thread can publish meters/transport state without messages.
  * Correct JavaScript MIME types (the Windows registry can map .js to
    text/plain, which breaks ES modules and AudioWorklet loading).
  * No caching, so edits show up on reload.

It also gives the app a place to keep files next to it, so saving works even
where the browser can't show a save dialog:
  saves/<name>.sfproj            projects (Ctrl+S)
  saves/.history/<name> <time>   the previous 10 versions of each project
  saves/.autosave/<name>.sfproj  unsaved work, written every few seconds
  exports/<name>.wav             WAV exports
Only same-origin requests from the app itself may write (see store_allowed).

Usage:  python serve.py [--port 8765] [--host 127.0.0.1]
"""
import argparse
import functools
import http.server
import json
import os
import re
import shutil
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse

MIME = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".md": "text/plain; charset=utf-8",
    ".sfproj": "application/octet-stream",
}

# kind -> (folder relative to the app, file extension)
STORE = {
    "project": ("saves", ".sfproj"),
    "autosave": ("saves/.autosave", ".sfproj"),
    "export": ("exports", ".wav"),
}
HISTORY_DIR = "saves/.history"
HISTORY_KEEP = 10
MAX_BODY = 2 * 1024 ** 3
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}


def safe_name(name):
    """A file name made from a project name: no paths, nothing Windows rejects."""
    n = re.sub(r"[^\w \-().,&'+!]", "_", name or "").strip(" .")[:120].strip(" .")
    if not n:
        n = "Untitled"
    if n.split(".")[0].upper() in RESERVED:
        n = "_" + n
    return n


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("SAWFORGE_LOG"):
            super().log_message(fmt, *args)

    # ------------------------------------------------------------ file store
    def store_allowed(self):
        # The custom header can't be sent cross-site without a CORS preflight,
        # which this server never approves; Origin / Sec-Fetch-Site are checked too.
        if self.headers.get("X-SawForge-Store") != "1":
            return False
        site = self.headers.get("Sec-Fetch-Site")
        if site and site not in ("same-origin", "none"):
            return False
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            return False
        return True

    def send_json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def store_path(self, kind, name):
        folder, ext = STORE[kind]
        return os.path.join(self.directory, *folder.split("/")), f"{folder}/{name}{ext}", name + ext

    def listing(self, kind):
        folder, ext = STORE[kind]
        full = os.path.join(self.directory, *folder.split("/"))
        out = []
        if os.path.isdir(full):
            for f in os.listdir(full):
                p = os.path.join(full, f)
                if f.endswith(ext) and os.path.isfile(p):
                    st = os.stat(p)
                    out.append({"name": f[: -len(ext)], "file": f"{folder}/{f}", "size": st.st_size, "modified": int(st.st_mtime * 1000)})
        out.sort(key=lambda e: -e["modified"])
        return out

    def keep_history(self, path, name):
        hist = os.path.join(self.directory, *HISTORY_DIR.split("/"))
        os.makedirs(hist, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(os.path.getmtime(path)))
        shutil.copy2(path, os.path.join(hist, f"{name} {stamp}.sfproj"))
        mine = re.compile(re.escape(name) + r" \d{8}-\d{6}\.sfproj")
        old = sorted(f for f in os.listdir(hist) if mine.fullmatch(f))
        for f in old[:-HISTORY_KEEP]:
            os.remove(os.path.join(hist, f))

    def do_GET(self):
        u = urlparse(self.path)
        if not u.path.startswith("/__store/"):
            return super().do_GET()
        if not self.store_allowed():
            return self.send_json(403, {"ok": False, "error": "not allowed"})
        if u.path == "/__store/list":
            return self.send_json(200, {"ok": True, "saves": self.listing("project"), "autosaves": self.listing("autosave"), "exports": self.listing("export")})
        return self.send_json(404, {"ok": False, "error": "unknown request"})

    def do_POST(self):
        u = urlparse(self.path)
        if not u.path.startswith("/__store/"):
            return self.send_json(404, {"ok": False, "error": "unknown request"})
        if not self.store_allowed():
            return self.send_json(403, {"ok": False, "error": "not allowed"})
        q = parse_qs(u.query)
        kind = q.get("kind", ["project"])[0]
        if kind not in STORE:
            return self.send_json(400, {"ok": False, "error": "unknown kind"})
        name = safe_name(q.get("name", [""])[0])
        folder, rel, fname = self.store_path(kind, name)
        path = os.path.join(folder, fname)
        try:
            if u.path == "/__store/delete":
                if os.path.isfile(path):
                    os.remove(path)
                return self.send_json(200, {"ok": True, "name": name})
            if u.path != "/__store/save":
                return self.send_json(404, {"ok": False, "error": "unknown request"})
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self.send_json(413, {"ok": False, "error": "empty or too large"})
            body = self.rfile.read(n)
            if len(body) != n:
                return self.send_json(400, {"ok": False, "error": "incomplete upload"})
            exists = os.path.isfile(path)
            if kind == "project" and exists and q.get("overwrite", ["0"])[0] != "1":
                return self.send_json(409, {"ok": False, "exists": True, "name": name})
            os.makedirs(folder, exist_ok=True)
            if kind == "project" and exists:
                self.keep_history(path, name)
            tmp = f"{path}.{threading.get_ident()}.part"
            with open(tmp, "wb") as f:
                f.write(body)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)  # atomic: a crash never leaves a half-written project
            return self.send_json(200, {"ok": True, "name": name, "file": rel, "bytes": n})
        except OSError as e:
            return self.send_json(500, {"ok": False, "error": str(e)})


def make_handler(root):
    return functools.partial(Handler, directory=root)


def main():
    ap = argparse.ArgumentParser(description="Serve Saw Forge Studio locally")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    root = os.path.dirname(os.path.abspath(__file__))
    try:
        httpd = http.server.ThreadingHTTPServer((args.host, args.port), make_handler(root))
    except OSError as e:
        print(f"Could not start server on {args.host}:{args.port}: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"Saw Forge Studio: http://{args.host}:{args.port}/  (Ctrl+C to stop)", flush=True)
    print(f"Projects are saved in {os.path.join(root, 'saves')}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
