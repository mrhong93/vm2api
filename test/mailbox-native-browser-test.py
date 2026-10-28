"""Offline contracts for native desktop launch and callback validation."""
import importlib.util
from pathlib import Path
import queue
import struct
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native', ROOT / 'scripts/mailbox-native-browser.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeContracts(unittest.TestCase):
    def test_slot_environment_and_proxy_scope(self):
        language, env = native.environment(
            {'slot_environment': {'locale': 'ja_JP.UTF-8', 'timezone': 'Asia/Tokyo', 'proxy_mode': 'slot_network'}},
            {'LANG': 'en_US.UTF-8', 'TZ': 'America/Chicago', 'HTTP_PROXY': 'fixture', 'all_proxy': 'fixture'})
        self.assertEqual(language, 'ja-JP')
        self.assertEqual(env['TZ'], 'Asia/Tokyo')
        self.assertEqual(env['LANG'], 'ja_JP.UTF-8')
        self.assertNotIn('HTTP_PROXY', env)
        self.assertNotIn('all_proxy', env)
        with self.assertRaisesRegex(native.NativeError, 'slot_egress_mismatch'):
            native.environment({'slot_environment': {'proxy_mode': 'other'}}, {})

    def test_allowlist_rejects_untrusted_navigation(self):
        for url in ['https://chatgpt.com/', 'https://auth.openai.com/oauth/authorize?state=fixture']:
            self.assertTrue(native.allowed_url(url))
        for url in ['javascript:alert(1)', 'file:///etc/passwd', 'https://chatgpt.com.evil.invalid/',
                    'https://user:password@chatgpt.com/', 'http://chatgpt.com/', 'https://chatgpt.com:8443/']:
            self.assertFalse(native.allowed_url(url))

    def test_native_frame_encodes_bgrx_pixels_without_external_image_tools(self):
        png = native.png_image(bytes([0, 0, 255, 0, 255, 0, 0, 0]), 2, 1, 8)
        self.assertTrue(png.startswith(b'\x89PNG\r\n\x1a\n'))
        self.assertEqual(struct.unpack('!II', png[16:24]), (2, 1))
        offset = png.index(b'IDAT')
        length = struct.unpack('!I', png[offset - 4:offset])[0]
        self.assertEqual(zlib.decompress(png[offset + 4:offset + 4 + length]), b'\0\xff\0\0\0\0\xff')

    def test_callback_requires_nonempty_server_generated_state(self):
        with self.assertRaisesRegex(native.NativeError, 'oauth_state_missing'):
            with native.callback_listener('', queue.Queue()):
                pass


if __name__ == '__main__':
    unittest.main()
