"""Checks for serve.py's file store (saves/, autosaves, history, exports).

Runs a real server on a free port over a temporary folder, so your own saves
are never touched.   Usage:  python tests/test_serve.py
"""
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import serve  # noqa: E402

GOOD = {"X-SawForge-Store": "1"}


def main():
    root = tempfile.mkdtemp(prefix="sawforge-store-")
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), serve.make_handler(root))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    def req(method, path, body=None, headers=None):
        r = urllib.request.Request(base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def js(res):
        return json.loads(res[1].decode())

    fails = []

    def check(cond, msg):
        print(("ok    " if cond else "FAIL  ") + msg)
        if not cond:
            fails.append(msg)

    try:
        check(req("GET", "/__store/list")[0] == 403, "listing without the app's header is refused")
        st, _ = req("GET", "/__store/list", headers={**GOOD, "Origin": "http://evil.example"})
        check(st == 403, "a request from another site is refused")
        st, _ = req("POST", "/__store/save?name=x", b"1", {**GOOD, "Sec-Fetch-Site": "cross-site"})
        check(st == 403, "a cross-site write is refused")
        st, body = req("GET", "/__store/list", headers=GOOD)
        check(st == 200 and js((st, body))["saves"] == [], "empty listing")

        st, body = req("POST", "/__store/save?kind=project&name=My%20Song", b"version1", GOOD)
        j = json.loads(body)
        check(st == 200 and j["file"] == "saves/My Song.sfproj", f"first save -> {j}")
        check(open(os.path.join(root, "saves", "My Song.sfproj"), "rb").read() == b"version1", "file written")
        check(req("POST", "/__store/save?kind=project&name=My%20Song", b"other", GOOD)[0] == 409, "an existing project isn't replaced without overwrite")
        st, _ = req("POST", "/__store/save?kind=project&name=My%20Song&overwrite=1", b"version2", GOOD)
        hist = os.listdir(os.path.join(root, "saves", ".history"))
        check(st == 200 and len(hist) == 1 and open(os.path.join(root, "saves", ".history", hist[0]), "rb").read() == b"version1",
              "overwrite keeps the previous version in .history")
        # history keeps the last 10 versions
        path = os.path.join(root, "saves", "My Song.sfproj")
        for i in range(12):
            os.utime(path, (1_700_000_000 + i * 60, 1_700_000_000 + i * 60))  # distinct timestamps
            req("POST", "/__store/save?kind=project&name=My%20Song&overwrite=1", f"v{i + 3}".encode(), GOOD)
        hist = [f for f in os.listdir(os.path.join(root, "saves", ".history")) if f.startswith("My Song ")]
        check(len(hist) == 10, f"history trimmed to 10 (has {len(hist)})")

        st, body = req("POST", "/__store/save?kind=project&name=..%2F..%2Fevil", b"x", GOOD)
        j = json.loads(body)
        inside = os.path.abspath(os.path.join(root, j.get("file", ""))).startswith(os.path.join(os.path.abspath(root), "saves"))
        check(st == 200 and inside and "/" not in j["name"], f"path tricks stay inside saves/ ({j.get('file')})")
        st, body = req("POST", "/__store/save?kind=project&name=CON", b"x", GOOD)
        check(st == 200 and json.loads(body)["name"] == "_CON", "Windows device names are made safe")

        st, _ = req("POST", "/__store/save?kind=autosave&name=My%20Song", b"auto", GOOD)
        st2, _ = req("POST", "/__store/save?kind=autosave&name=My%20Song", b"auto2", GOOD)
        lst = js(req("GET", "/__store/list", headers=GOOD))
        check(st == 200 and st2 == 200 and [a["name"] for a in lst["autosaves"]] == ["My Song"], "autosaves overwrite freely and are listed")
        req("POST", "/__store/delete?kind=autosave&name=My%20Song", None, GOOD)
        check(js(req("GET", "/__store/list", headers=GOOD))["autosaves"] == [], "autosave deleted after a real save")

        st, body = req("POST", "/__store/save?kind=export&name=Mix", b"RIFF....WAVE", GOOD)
        check(st == 200 and json.loads(body)["file"] == "exports/Mix.wav", "exports go to exports/")
        st, body = req("GET", "/saves/My%20Song.sfproj")
        check(st == 200 and body == b"v14", "saved projects are readable by the app")
        check(req("POST", "/__store/save?kind=bogus&name=x", b"x", GOOD)[0] == 400, "unknown kinds rejected")
        check(req("POST", "/__store/save?kind=project&name=empty", b"", GOOD)[0] == 413, "empty uploads rejected")
    finally:
        httpd.shutdown()
        shutil.rmtree(root, ignore_errors=True)
    print(f"\n{'all passed' if not fails else str(len(fails)) + ' failed'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
