import unittest

from hyucoms_api import HucomsResponseError, iter_multipart, parse_text


class ParserTests(unittest.TestCase):
    def test_text_response_and_sections(self):
        response = parse_text("""[Version]\nFirmware = 1.2 * current\n[Audio]\ncodec = ulaw\n""")
        self.assertEqual(response["Firmware"], "1.2")
        self.assertEqual(response.sections["Audio"]["codec"], "ulaw")
        self.assertIsNone(response.message)

    def test_error_response_is_preserved(self):
        response = parse_text("Error: PTZ not supported")
        self.assertEqual(response.message, "PTZ not supported")
        with self.assertRaises(HucomsResponseError):
            raise HucomsResponseError(response.message)

    def test_multipart_payloads(self):
        content_type = "multipart/x-mixed-replace; boundary=eventlist"
        body = (
            b"--eventlist\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\n"
            b"a = first\r\n--eventlist\r\nContent-Type: text/plain\r\n\r\n"
            b"b = second\r\n--eventlist--\r\n"
        )
        self.assertEqual(list(iter_multipart(body, content_type)), [b"a = first", b"b = second"])


if __name__ == "__main__":
    unittest.main()
