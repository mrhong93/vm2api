"""Build a browser bundle inside a matching Ubuntu/Debian builder.

Python, Playwright and browsers must be installed under /opt/kin-mailbox.
stdout is the tar.gz stream; diagnostics belong on stderr.
No browser profile, account, token or network request is included.
"""
import json
import gzip
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import platform

try:
    DISPLAY_HELPER_SOURCE
except NameError:
    DISPLAY_HELPER_SOURCE = Path(__file__).with_name('mailbox-display.py').read_text()


def command(argv, cwd=None):
    subprocess.run(argv, cwd=cwd, check=True, stdout=sys.stderr, stderr=sys.stderr)


def build_display(destination):
    """Use signed distro sources, with no fixed /usr/bin dependency in slots."""
    sources = Path('/etc/apt/sources.list.d')
    enabled = False
    for file in sources.glob('*.sources'):
        text = file.read_text()
        replacement = re.sub(r'^Types:\s*deb\s*$', 'Types: deb deb-src', text, flags=re.M)
        if replacement != text:
            file.write_text(replacement)
        enabled |= bool(re.search(r'^Types:.*\bdeb-src\b', replacement, re.M))
    for file in [Path('/etc/apt/sources.list'), *sources.glob('*.list')]:
        if not file.is_file():
            continue
        text = file.read_text()
        additions = [re.sub(r'^(\s*)deb\s', r'\1deb-src ', line)
                     for line in text.splitlines() if re.match(r'^\s*deb\s', line)]
        if additions:
            file.write_text(text + '\n' + '\n'.join(additions) + '\n')
        enabled |= bool(additions or re.search(r'^\s*deb-src\s', text, re.M))
    if not enabled:
        raise RuntimeError('Distro source repositories unavailable')
    command(['apt-get', 'update', '-qq'])
    command(['apt-get', 'install', '-y', '--no-install-recommends', 'dpkg-dev', 'x11-xkb-utils', 'xkb-data'])
    command(['apt-get', 'build-dep', '-y', '--no-install-recommends', 'xorg-server'])
    with tempfile.TemporaryDirectory(prefix='mailbox-display-source-') as folder:
        command(['apt-get', 'source', 'xorg-server'], cwd=folder)
        source = next(p for p in Path(folder).glob('xorg-server-*') if p.is_dir() and (p / 'configure').is_file())
        command(['./configure', '--prefix=/opt/kin-mailbox/display',
                 '--with-xkb-bin-directory=', '--with-xkb-output=/tmp',
                 '--disable-xorg', '--disable-xnest', '--disable-xephyr', '--disable-xwayland',
                 '--disable-xwin', '--disable-dmx', '--enable-xvfb', '--disable-glamor',
                 '--disable-glx', '--disable-dri', '--disable-dri2', '--disable-dri3',
                 '--disable-docs', '--disable-devel-docs', '--disable-unit-tests'], cwd=source)
        command(['make', '-j2'], cwd=source)
        (destination / 'bin').mkdir(parents=True)
        shutil.copyfile(source / 'hw/vfb/Xvfb', destination / 'bin/Xvfb')
        (destination / 'licenses').mkdir()
        shutil.copyfile(source / 'COPYING', destination / 'licenses/xorg-server-COPYING')
        shutil.copyfile(source / 'debian/copyright', destination / 'licenses/xorg-server-copyright')
    shutil.copyfile(shutil.which('xkbcomp'), destination / 'bin/xkbcomp')
    for file in (destination / 'bin').iterdir():
        file.chmod(0o755)
    shutil.copytree('/usr/share/X11/xkb', destination / 'xkb', symlinks=False)
    for package in ['x11-xkb-utils', 'xkb-data']:
        shutil.copyfile(Path('/usr/share/doc') / package / 'copyright', destination / 'licenses' / (package + '-copyright'))
    (destination / 'runtime.py').write_text(DISPLAY_HELPER_SOURCE)


def collect_libraries(queue, libs):
    libs.mkdir(exist_ok=True)
    checked = set()
    core = re.compile(r'^(?:ld-linux.*|lib(?:c|m|pthread|dl|rt|resolv|util|anl)\.so.*)$')
    while queue:
        binary = queue.pop()
        if str(binary) in checked:
            continue
        checked.add(str(binary))
        result = subprocess.run(['ldd', str(binary)], capture_output=True, text=True)
        if re.search(r'=>\s+not found', result.stdout):
            raise RuntimeError('Missing build dependency')
        if result.returncode:
            # Playwright also ships static ELF tools (for example ffmpeg).
            # ldd returns 1 for these even though no shared library is needed.
            if re.search(r'not a dynamic executable|statically linked', result.stdout + result.stderr):
                continue
            raise RuntimeError('Cannot inspect build dependency')
        for line in result.stdout.splitlines():
            match = re.search(r'=>\s+(/\S+)', line)
            if not match:
                continue
            dep = Path(match[1])
            if core.match(dep.name) or (libs / dep.name).exists():
                continue
            shutil.copyfile(dep.resolve(), libs / dep.name)
            os.chmod(libs / dep.name, 0o755)
            queue.append(dep)

release = {}
for line in Path('/etc/os-release').read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        release[key] = value.strip('"\'')
python_version = f'{sys.version_info.major}.{sys.version_info.minor}'
architecture = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]

with tempfile.TemporaryDirectory(prefix='mailbox-bundle-') as temp:
    root = Path(temp)
    source = Path('/opt/kin-mailbox')
    build_display(root / 'display')
    collect_libraries(list((root / 'display/bin').iterdir()), root / 'display/lib')
    for name in ['venv', 'browsers']:
        shutil.copytree(source / name, root / name, symlinks=False,
                        ignore=shutil.ignore_patterns('lib64', '__pycache__'))
    for binary in (root / 'venv/bin').glob('python*'):
        binary.unlink()
    libs = root / 'lib'
    libs.mkdir()
    queue = []
    # NSS loads these via dlopen, so ldd on Chromium alone cannot discover them.
    for pattern in ['libsoftokn3.*', 'libfreebl3.*', 'libfreeblpriv3.*', 'libnssdbm3.*', 'libnssckbi.so']:
        for dep in Path('/usr/lib').glob('*/' + pattern):
            shutil.copyfile(dep.resolve(), libs / dep.name)
            if dep.suffix == '.so':
                queue.append(dep)
    shutil.copytree('/usr/share/fonts/truetype', root / 'fonts', symlinks=False)
    (root / 'fonts.conf').write_text('''<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig><dir>/home/kincli/.local/share/kin-mailbox/fonts</dir>
<cachedir>/home/kincli/.local/share/kin-mailbox/cache/fontconfig</cachedir></fontconfig>
''')
    for p in (root / 'browsers').rglob('*'):
        if p.is_file() and not p.is_symlink():
            with p.open('rb') as stream:
                if stream.read(4) == b'\x7fELF':
                    queue.append(p)
    queue.append(root / f'venv/lib/python{python_version}/site-packages/playwright/driver/node')
    collect_libraries(queue, libs)
    (root / 'portable.json').write_text(json.dumps({'version': '1.64.1', 'revision': 4,
        'graphical': True,
        'os': release['ID'], 'os_version': release['VERSION_ID'],
        'arch': architecture, 'python': python_version}))
    (root / 'ready-1.64.1').touch()
    # Python 3.10/3.11 do not accept compresslevel with tarfile stream mode.
    with gzip.GzipFile(fileobj=sys.stdout.buffer, mode='wb', compresslevel=1) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|') as archive:
            for name in ['venv', 'browsers', 'display', 'lib', 'fonts', 'fonts.conf', 'portable.json', 'ready-1.64.1']:
                archive.add(root / name, arcname=name)
