"""
ReturnShield AI — one-command local server.

Browsers only allow camera access on secure contexts (https:// or localhost).
Opening index.html directly via file:// blocks the camera in most browsers.
This script serves the dashboard on http://localhost:3000, which browsers
treat as secure — so the Agent 3 camera works.

Run:
    python serve.py
Then open:
    http://localhost:3000
"""
import http.server
import os
import socketserver
import webbrowser

PORT = 3000
DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Explicitly allow camera for the Agent 3 demo
        self.send_header("Permissions-Policy", "camera=(self)")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"ReturnShield AI dashboard running at {url}")
        print("Camera will work here (localhost = secure context). Ctrl+C to stop.")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        httpd.serve_forever()
