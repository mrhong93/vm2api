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
    checked = set()
    # The installer requires matching guest OS, architecture and Python ABI.
    core = re.compile(r'^(?:ld-linux.*|lib(?:c|m|pthread|dl|rt|resolv|util|anl)\.so.*)$')
    while queue:
        binary = queue.pop()
        key = str(binary)
        if key in checked:
            continue
        checked.add(key)
        result = subprocess.run(['ldd', str(binary)], capture_output=True, text=True)
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
    (root / 'portable.json').write_text(json.dumps({'version': '1.64.1', 'revision': 3,
        'os': release['ID'], 'os_version': release['VERSION_ID'],
        'arch': architecture, 'python': python_version}))
    (root / 'ready-1.64.1').touch()
    # Python 3.10/3.11 do not accept compresslevel with tarfile stream mode.
    with gzip.GzipFile(fileobj=sys.stdout.buffer, mode='wb', compresslevel=1) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|') as archive:
            for name in ['venv', 'browsers', 'lib', 'fonts', 'fonts.conf', 'portable.json', 'ready-1.64.1']:
                archive.add(root / name, arcname=name)
