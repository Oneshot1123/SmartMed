"""
Serves the dashboard and proxies Groq chat calls so the API key never reaches the browser.

Run:  python serve.py [port]        (default 8000, then open http://localhost:8000/dashboard/index.html)

The key is read from a .env file next to this script (GROQ_API_KEY=gsk_...),
which stays on this machine and is never committed.
"""
import json
import os
import socket
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


def load_env():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        if self.path.rstrip("/") != "/api/groq":
            self.send_error(404)
            return
        key = os.environ.get("GROQ_API_KEY")
        if not key:
            self._json(500, {"error": {"message": "GROQ_API_KEY is missing. Add it to .env next to serve.py and restart."}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        req = urllib.request.Request(
            GROQ_URL,
            data=body,
            method="POST",
            # Groq sits behind a CDN that blocks the default Python-urllib user agent
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "SmartMed/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                self._json(resp.status, json.loads(resp.read()))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            try:
                payload = json.loads(detail)
            except ValueError:
                payload = {"error": {"message": "Groq returned HTTP " + str(exc.code) + ": " + detail[:200]}}
            self._json(exc.code, payload)
        except Exception as exc:
            self._json(502, {"error": {"message": "Cannot reach Groq: " + str(exc)}})

    def _json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass  # keep the console quiet; only the startup banner prints


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    load_env()

    # Bind both IPv4 and IPv6 so stray http.server processes can't steal
    # localhost traffic (::1) - which shows up as spurious 501s on /api/groq.
    Server = ThreadingHTTPServer
    try:
        class DualStackServer(ThreadingHTTPServer):
            address_family = socket.AF_INET6

            def server_bind(self):
                try:
                    self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                except OSError:
                    pass
                super().server_bind()

        Server = DualStackServer
    except (OSError, AttributeError):
        pass  # IPv6 unavailable - plain IPv4 still works

    key_state = "loaded" if os.environ.get("GROQ_API_KEY") else "not set (see .env)"
    print("Serving http://localhost:" + str(port) + "/ - Groq key " + key_state)
    Server(("", port), Handler).serve_forever()
