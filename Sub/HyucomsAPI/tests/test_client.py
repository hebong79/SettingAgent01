import io
import sys
import unittest
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, ".")

from hyucoms_api import HucomsCameraClient, HucomsHTTPError, HucomsValidationError, HttpResponse, StreamResponse


class FakeTransport:
    def __init__(self, body=b"ok = yes\n", headers=None):
        self.body = body
        self.headers = headers or {"Content-Type": "text/plain"}
        self.urls = []

    def request(self, url, *, headers, timeout):
        self.urls.append(url)
        return HttpResponse(200, "OK", self.headers, self.body, url)

    def open(self, url, *, headers, timeout):
        self.urls.append(url)
        return StreamResponse(200, "OK", self.headers, io.BytesIO(self.body), url)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeTransport()
        self.camera = HucomsCameraClient("192.168.1.30", "admin", "secret", transport=self.transport)

    def query(self):
        parsed = urlsplit(self.transport.urls[-1])
        return parsed.path, parse_qs(parsed.query)

    def test_auth_and_action_are_encoded(self):
        result = self.camera.get_server_name()
        self.assertEqual(result["ok"], "yes")
        path, query = self.query()
        self.assertEqual(path, "/cgi-bin/control/servername.cgi")
        self.assertEqual(query["id"], ["admin"])
        self.assertEqual(query["passwd"], ["secret"])
        self.assertEqual(query["action"], ["getservername"])

    def test_motion_area_and_rtsp_queries(self):
        self.camera.set_motion(1, level=3, areas={1: 1, 18: 0xFFFFFF})
        _, query = self.query()
        self.assertEqual(query["motion1.level"], ["3"])
        self.assertEqual(query["motion1.area18"], ["16777215"])
        self.camera.set_rtsp(rtsp_port=554, rtp_port_start=5000, rtp_port_end=5999)
        _, query = self.query()
        self.assertEqual(query["rtpport"], ["5000,5999"])

    def test_night_color_alias_uses_setncolor(self):
        self.camera.set_night_color(bright=42)
        _, query = self.query()
        self.assertEqual(query["action"], ["setncolor"])
        self.assertEqual(query["bright"], ["42"])

    def test_jpeg_is_returned_as_bytes(self):
        transport = FakeTransport(b"\xff\xd8jpeg\xff\xd9", {"Content-Type": "image/jpeg"})
        camera = HucomsCameraClient("192.168.1.30", transport=transport)
        self.assertEqual(camera.get_jpeg(), b"\xff\xd8jpeg\xff\xd9")

    def test_validation_happens_before_request(self):
        with self.assertRaises(HucomsValidationError):
            self.camera.set_color(bright=101)
        self.assertEqual(self.transport.urls, [])

    def test_capability_and_arbitrary_request(self):
        self.camera.get_capabilities_ptz()
        path, query = self.query()
        self.assertEqual(path, "/cgi-bin/control/capabilityptz.cgi")
        self.assertEqual(query["action"], ["getPTZ"])
        self.camera.request("/cgi-bin/control/example.cgi", {"action": "x", "a.b": "hello world"})
        _, query = self.query()
        self.assertEqual(query["a.b"], ["hello world"])

    def test_mjpeg_stream_yields_frames(self):
        body = (
            b"--cam\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n"
            b"--cam\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\ndef\r\n--cam--\r\n"
        )
        transport = FakeTransport(body, {"Content-Type": "multipart/x-mixed-replace; boundary=cam"})
        camera = HucomsCameraClient("192.168.1.30", transport=transport)
        self.assertEqual(list(camera.iter_mjpeg()), [b"abc", b"def"])

    def test_http_status_is_distinguished(self):
        class ErrorTransport(FakeTransport):
            def request(self, url, *, headers, timeout):
                return HttpResponse(500, "Internal Server Error", {}, b"", url)

        with self.assertRaises(HucomsHTTPError):
            HucomsCameraClient("192.168.1.30", transport=ErrorTransport()).get_server_name()


if __name__ == "__main__":
    unittest.main()
