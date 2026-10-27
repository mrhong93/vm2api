"""Private slot-local X display shared by installation checks and login tasks."""
import contextlib
import os
from pathlib import Path
import select
import struct
import subprocess
import tempfile


class DisplayError(Exception):
    pass


@contextlib.contextmanager
def slot_browser_display(runtime):
    runtime = Path(runtime)
    display_root = runtime / 'display'
    binary = display_root / 'bin/Xvfb'
    if not binary.is_file() or not (display_root / 'bin/xkbcomp').is_file():
        raise DisplayError('browser_graphical_runtime_missing')
    env = dict(os.environ)
    env['LD_LIBRARY_PATH'] = str(display_root / 'lib') + ':' + env.get('LD_LIBRARY_PATH', '')
    # Xvfb is built with an empty xkb binary prefix. PATH makes the compiler
    # relocatable, including the disposable directory used before installation.
    env['PATH'] = str(display_root / 'bin') + os.pathsep + env.get('PATH', '/usr/bin:/bin')
    read_fd, write_fd = os.pipe()
    process = None
    with tempfile.TemporaryDirectory(prefix='display-', dir=runtime / 'tmp') as folder:
        authority = Path(folder) / 'authority'
        cookie = os.urandom(16)

        def write_authority(number):
            fields = [b'', str(number).encode(), b'MIT-MAGIC-COOKIE-1', cookie]
            authority.write_bytes(struct.pack('!H', 65535) + b''.join(struct.pack('!H', len(v)) + v for v in fields))
            authority.chmod(0o600)

        write_authority('')
        try:
            process = subprocess.Popen([str(binary), '-displayfd', str(write_fd),
                '-screen', '0', '1365x900x24', '-nolisten', 'tcp', '-auth', str(authority),
                '-xkbdir', str(display_root / 'xkb'), '-fp', 'built-ins'],
                env=env, pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.close(write_fd)
            write_fd = None
            if not select.select([read_fd], [], [], 15)[0]:
                raise DisplayError('browser_display_unavailable')
            number = os.read(read_fd, 64).decode().strip()
            if not number.isdigit() or process.poll() is not None:
                raise DisplayError('browser_display_unavailable')
            write_authority(number)
            env.update(DISPLAY=':' + number, XAUTHORITY=str(authority))
            yield env
        except OSError:
            raise DisplayError('browser_display_unavailable') from None
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
