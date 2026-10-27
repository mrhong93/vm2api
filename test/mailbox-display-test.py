"""Portable display security and lifecycle tests; no browser or account network."""
import ast
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('display', ROOT / 'scripts/mailbox-display.py')
display = importlib.util.module_from_spec(spec)
spec.loader.exec_module(display)


class DisplayTests(unittest.TestCase):
    def test_missing_graphical_component_fails_instead_of_using_headless(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(display.DisplayError, 'browser_graphical_runtime_missing'):
                with display.slot_browser_display(folder):
                    self.fail('Missing display must not be accepted')

    @unittest.skipUnless(os.name == 'posix', 'The slot X display uses POSIX pipes')
    def test_private_display_is_relocatable_and_cleaned_up(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ['display/bin/Xvfb', 'display/bin/xkbcomp']:
                p = root / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.touch()
            (root / 'tmp').mkdir()
            calls = []

            class Process:
                stopped = False

                def poll(self):
                    return 0 if self.stopped else None

                def terminate(self):
                    self.stopped = True

                def wait(self, timeout=None):
                    return 0

            process = Process()
            original_environment = dict(os.environ)

            def launch(argv, **kwargs):
                calls.append((argv, kwargs))
                os.write(kwargs['pass_fds'][0], b'42\n')
                return process

            with patch.object(display.subprocess, 'Popen', side_effect=launch):
                with display.slot_browser_display(root) as env:
                    authority = Path(env['XAUTHORITY'])
                    self.assertEqual(authority.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(env['DISPLAY'], ':42')
                    self.assertEqual(env['PATH'].split(os.pathsep)[0], str(root / 'display/bin'))
                    self.assertIn('tcp', calls[0][0])
                    self.assertIn('-auth', calls[0][0])
                    self.assertEqual(dict(os.environ), original_environment)
                    self.assertTrue(authority.exists())
            self.assertFalse(authority.exists())
            self.assertTrue(process.stopped)

    def test_installer_embedded_verification_program_compiles(self):
        tree = ast.parse((ROOT / 'scripts/mailbox-runtime-slot.py').read_text())
        verify = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'verify')
        code = next(n.value.value for n in verify.body if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == 'code' for t in n.targets))
        compile(code, 'installation-verification', 'exec')


if __name__ == '__main__':
    unittest.main()
