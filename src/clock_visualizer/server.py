"""Local HTTP transport and command-line entry point."""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from urllib.parse import urlsplit

from .clocks import calculate

ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
MAX_BODY = 262144


class Handler(BaseHTTPRequestHandler):
    def _respond(self, status, body, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, value):
        self._respond(status, json.dumps(value).encode("utf-8"))

    def do_GET(self):
        asset = ASSETS.get(urlsplit(self.path).path)
        if asset is None:
            self._json(404, {"error": "Route not found."})
            return
        name, content_type = asset
        self._respond(200, files("clock_visualizer").joinpath("static", name).read_bytes(), content_type)

    def do_POST(self):
        if urlsplit(self.path).path != "/api/calculate":
            self._json(404, {"error": "Route not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0:
                raise ValueError
        except ValueError:
            self._json(400, {"error": "Invalid Content-Length."})
            return
        if length > MAX_BODY:
            self._json(413, {"error": "Execution exceeds the 256 KiB request limit."})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            result = calculate(payload)
        except (ValueError, UnicodeDecodeError, RecursionError) as error:
            self._json(400, {"error": str(error) or "Invalid execution."})
            return
        self._json(200, result)


def create_server(host="127.0.0.1", port=8888):
    return ThreadingHTTPServer((host, port), Handler)


def main():
    parser = argparse.ArgumentParser(description="Explore Lamport and vector clocks in your browser.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8888, help="HTTP port (default: 8888)")
    args = parser.parse_args()
    try:
        server = create_server(args.host, args.port)
    except (OSError, OverflowError) as error:
        parser.exit(1, f"Cannot start server: {error}\n")
    print(f"Logical clock visualizer: http://{args.host}:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
