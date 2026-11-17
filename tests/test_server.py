import http.client
import json
import threading
import unittest

from test_clocks import execution
from clock_visualizer.server import create_server


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = create_server(port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, response.getheader("Content-Type"), response.read()
        connection.close()
        return result

    def test_calculate_and_bad_payloads(self):
        status, content_type, body = self.request("POST", "/api/calculate", json.dumps(execution("modified")))
        self.assertEqual(status, 200)
        self.assertIn("application/json", content_type)
        self.assertEqual(json.loads(body)["events"][-1]["timestamp"], [2, 1, 1])
        for payload in ["broken", "null", "{}", '{"mode": [], "processes": [], "events": []}']:
            with self.subTest(payload=payload):
                status, _, body = self.request("POST", "/api/calculate", payload)
                self.assertEqual(status, 400)
                self.assertIn("error", json.loads(body))

    def test_unknown_and_traversal_paths(self):
        for method, path in [("GET", "/missing"), ("GET", "/../server.py"), ("POST", "/missing")]:
            with self.subTest(path=path):
                self.assertEqual(self.request(method, path)[0], 404)

    def test_rejects_invalid_lengths_and_large_bodies(self):
        self.assertEqual(self.request("POST", "/api/calculate", "", {"Content-Length": "-1"})[0], 400)
        self.assertEqual(self.request("POST", "/api/calculate", "", {"Content-Length": "bad"})[0], 400)
        self.assertEqual(self.request("POST", "/api/calculate", "x" * 262145)[0], 413)

    def test_serves_gui_assets(self):
        for path, mime in [("/", "text/html"), ("/app.js", "javascript"), ("/style.css", "text/css")]:
            with self.subTest(path=path):
                status, content_type, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertIn(mime, content_type)
                self.assertTrue(body)


if __name__ == "__main__":
    unittest.main()
