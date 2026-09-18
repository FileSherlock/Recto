"""serve.py — static file server for the WebAssembly benchmark.

    python lab/wasm-bench/serve.py [port]

Plain files, plus the two headers that make a page cross-origin isolated
(COOP/COEP): only then does the browser expose
performance.measureUserAgentSpecificMemory(), which counts the WebAssembly
heap and the worker — performance.memory does not. This is also the whole
"server" a static Recto would need.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript'}
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a): pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5055
root = Path(__file__).resolve().parent
ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, directory=str(root))).serve_forever()
