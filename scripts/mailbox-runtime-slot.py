"""Manage browser binaries inside a slot. Never read credentials or visit a website."""
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import fcntl
import re
import signal
import time

VERSION = '1.64.1'
HOME = Path('/home/kincli')
ROOT = HOME / '.local/share/kin-mailbox'
LEGACY = Path('/opt/kin-mailbox')
TARGETS = {('ubuntu', '22.04'): '3.10', ('ubuntu', '24.04'): '3.12',
           ('debian', '12'): '3.11', ('debian', '13'): '3.13'}
BINARIES = ('venv', 'browsers', 'display', 'lib', 'fonts', 'fonts.conf', 'portable.json',
            'ready-' + VERSION, 'tmp')
PRESERVED = ('profiles', 'cache', 'config')
# Old root-owned job directories may survive a failed installation. Keep each
# execution identity's lock/cancellation files private without changing owners.
JOBS = Path('/tmp/kin-mailbox-maintenance' + (f'-{os.geteuid()}' if os.geteuid() else ''))


class RuntimeFailure(Exception):
    pass


def facts():
    release = {}
    for line in Path('/etc/os-release').read_text().splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            release[key] = value.strip('"\'')
    distro, version = release.get('ID', ''), release.get('VERSION_ID', '')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine(), platform.machine())
    python = f'{sys.version_info.major}.{sys.version_info.minor}'
    return {'os': distro, 'os_version': version, 'arch': arch, 'python': python,
            'supported': TARGETS.get((distro, version)) == python and arch in ('amd64', 'arm64')}


def status():
    info = facts()
    try:
        portable = json.loads((ROOT / 'portable.json').read_text())
    except (OSError, ValueError):
        portable = {}
    managed = bool(portable and (ROOT / 'venv/bin/python').is_file())
    legacy = (LEGACY / ('ready-' + VERSION)).is_file() and (LEGACY / 'venv/bin/python').is_file()
    graphical = managed and (ROOT / 'display/runtime.py').is_file() and all(
        (ROOT / name).is_file() and os.access(ROOT / name, os.X_OK)
        for name in ('display/bin/Xvfb', 'display/bin/xkbcomp'))
    info.update(installed=managed or legacy, managed=managed, legacy=bool(legacy),
                version=portable.get('version') if managed else VERSION if legacy else None,
                revision=portable.get('revision') if managed else None,
                graphical=graphical,
                needs_upgrade=bool((legacy and not managed) or (managed and (
                    portable.get('revision', 0) < 4 or not graphical))))
    return info


def require_target(info):
    if not info['supported']:
        raise RuntimeFailure('browser_os_unsupported')


def own_tree(root):
    owner = HOME.stat()
    if os.geteuid() != 0:
        return
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in ['.'] + dirs + files:
            os.chown(Path(directory) / name, owner.st_uid, owner.st_gid, follow_symlinks=False)


def remove(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def verify(root):
    """Use a disposable profile and inline page; no account profile or network request."""
    owner = HOME.stat()
    env = {**os.environ, 'HOME': str(HOME), 'KIN_MAILBOX_ROOT': str(root), 'PLAYWRIGHT_BROWSERS_PATH': str(root / 'browsers'),
           'LD_LIBRARY_PATH': str(root / 'lib'), 'TMPDIR': str(root / 'tmp'),
           'XDG_CACHE_HOME': str(root / 'tmp/cache'), 'XDG_CONFIG_HOME': str(root / 'tmp/config'),
           'FONTCONFIG_FILE': str(root / 'fonts.conf')}
    for key in list(env):
        if key.lower() in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
            del env[key]
    (root / 'tmp').mkdir(exist_ok=True)
    own_tree(root)
    def drop_user():
        os.setgroups([])
        os.setgid(owner.st_gid)
        os.setuid(owner.st_uid)
    code = '''import importlib.metadata, importlib.util, os
from pathlib import Path
from playwright.sync_api import sync_playwright
assert importlib.metadata.version('playwright') == '1.64.1'
root = Path(os.environ['KIN_MAILBOX_ROOT'])
spec = importlib.util.spec_from_file_location('mailbox_display', root / 'display/runtime.py')
display = importlib.util.module_from_spec(spec)
spec.loader.exec_module(display)
with display.slot_browser_display(root) as env, sync_playwright() as p:
 b = p.chromium.launch(headless=False, env=env, args=['--disable-dev-shm-usage', '--disable-background-networking', '--no-proxy-server'])
 c = b.new_context(service_workers='block')
 c.route('**/*', lambda route: route.abort())
 page = c.new_page()
 page.set_content('<title>Browser runtime ready</title>')
 assert page.title() == 'Browser runtime ready'
 assert not page.evaluate("navigator.userAgent.includes('HeadlessChrome')")
 page.set_content('<button onclick="this.textContent=String.fromCharCode(99,108,105,99,107,101,100)">check</button>')
 page.locator('button').click()
 assert page.locator('button').inner_text() == 'clicked'
 assert len(page.screenshot()) > 0
 c.close()
 b.close()
'''
    try:
        child = subprocess.Popen([str(root / 'venv/bin/python'), '-c', code], env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True,
                                 preexec_fn=drop_user if os.geteuid() == 0 else None)
        try:
            if child.wait(timeout=90) != 0:
                raise RuntimeFailure('browser_launch_failed')
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
    except (OSError, subprocess.SubprocessError):
        raise RuntimeFailure('browser_launch_failed') from None


def install(stream, expected):
    info = facts()
    require_target(info)
    if any(p.is_symlink() for p in (HOME, HOME / '.local', ROOT.parent, ROOT)):
        raise RuntimeFailure('browser_runtime_invalid')
    ROOT.parent.mkdir(parents=True, exist_ok=True)
    if os.geteuid() == 0:
        owner = HOME.stat()
        for parent in (HOME / '.local', ROOT.parent):
            os.chown(parent, owner.st_uid, owner.st_gid)
    temp = Path(tempfile.mkdtemp(prefix='kin-mailbox-install-', dir=ROOT.parent))
    previous = temp.with_name(temp.name + '.previous')
    moved = []
    try:
        with tarfile.open(fileobj=stream, mode='r|gz') as archive:
            total = 0
            for member in archive:
                total += member.size
                target = temp / member.name
                # Compatible with guest Python 3.10/3.11 as well as newer tarfile APIs.
                if (not Path(member.name).parts or Path(member.name).parts[0] not in BINARIES
                        or not target.resolve().is_relative_to(temp.resolve())
                        or not (member.isfile() or member.isdir()) or total > 3_000_000_000):
                    raise RuntimeFailure('browser_runtime_invalid')
                archive.extract(member, temp)
        metadata = json.loads((temp / 'portable.json').read_text())
        for key in ('os', 'os_version', 'arch', 'python'):
            if metadata.get(key) != info[key] or expected.get(key) != info[key]:
                raise RuntimeFailure('browser_runtime_invalid')
        if metadata.get('version') != VERSION:
            raise RuntimeFailure('browser_runtime_invalid')
        if metadata.get('revision') != 4 or not (temp / 'display/runtime.py').is_file():
            raise RuntimeFailure('browser_runtime_invalid')
        # venv Python uses the selected guest's interpreter, never a builder absolute path.
        bin_dir = temp / 'venv/bin'
        for name in ('python', 'python3', 'python' + info['python']):
            remove(bin_dir / name)
            (bin_dir / name).symlink_to('/usr/bin/python3')
        (temp / 'venv/pyvenv.cfg').write_text('home = /usr/bin\ninclude-system-site-packages = false\n')
        write_fonts(temp, temp)
        own_tree(temp)
        verify(temp)
        write_fonts(temp, ROOT)
        metadata['verified'] = True
        (temp / 'portable.json').write_text(json.dumps(metadata))
        # The directory swap is short and must not be interrupted half-way.
        old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGALRM})
        if ROOT.exists():
            ROOT.rename(previous)
            for name in PRESERVED:
                if (previous / name).exists():
                    # The disposable launch check may create a fontconfig cache.
                    # Replace only that new fixture with the existing session data.
                    remove(temp / name)
                    (previous / name).rename(temp / name)
                    moved.append(name)
        own_tree(temp)
        temp.rename(ROOT)
    except Exception:
        if previous.exists():
            for name in moved:
                (temp / name).rename(previous / name)
            previous.rename(ROOT)
        raise
    finally:
        if temp.exists():
            shutil.rmtree(temp)
    if previous.exists():
        shutil.rmtree(previous)
    signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
    return {**status(), 'verified': True}


def write_fonts(location, target):
    (location / 'fonts.conf').write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">'
        f'<fontconfig><dir>{target}/fonts</dir><cachedir>{target}/cache/fontconfig</cachedir></fontconfig>')


def uninstall():
    require_target(facts())
    if any(p.is_symlink() for p in (HOME, HOME / '.local', ROOT.parent, ROOT)):
        raise RuntimeFailure('browser_runtime_invalid')
    for root in (ROOT, LEGACY):
        if root.is_symlink():
            raise RuntimeFailure('browser_runtime_invalid')
        if root == LEGACY and not (root / ('ready-' + VERSION)).exists():
            continue
        for name in BINARIES:
            try:
                remove(root / name)
            except OSError:
                raise RuntimeFailure('browser_uninstall_failed') from None
    return status()


def main():
    marker = None
    lock = None
    job = {}
    owns_marker = False
    try:
        job = json.loads(sys.stdin.buffer.readline())
        action = job['action']
        if action in ('install', 'uninstall', 'cancel'):
            job_id = job.get('job_id', '')
            if not re.fullmatch(r'[a-f0-9-]{36}', job_id):
                raise RuntimeFailure('invalid_browser_operation')
            JOBS.mkdir(mode=0o700, exist_ok=True)
            if JOBS.is_symlink() or JOBS.stat().st_uid != os.geteuid() or JOBS.stat().st_mode & 0o077:
                raise RuntimeFailure('browser_runtime_invalid')
            marker = JOBS / (job_id + '.json')
            cancelled = JOBS / (job_id + '.cancel')
            if action == 'cancel':
                cancelled.touch(mode=0o600)
                # A marker also covers cancellation before docker exec starts.
                if marker.exists():
                    pid_info = json.loads(marker.read_text())
                    proc = Path('/proc') / str(pid_info['pid']) / 'stat'
                    if proc.exists() and proc.read_text().split()[21] == pid_info['start']:
                        os.kill(pid_info['pid'], signal.SIGTERM)
                deadline = time.monotonic() + 20
                while marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                if marker.exists():
                    raise RuntimeFailure('browser_runtime_operation_failed')
                print(json.dumps({'ok': True, 'data': {}}), flush=True)
                return
            lock = (JOBS / 'runtime.lock').open('w')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeFailure('mailbox_login_busy') from None
            def interrupted(_signal, _frame):
                # Finish rollback without a second signal interrupting it.
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                signal.signal(signal.SIGALRM, signal.SIG_IGN)
                raise RuntimeFailure('login_cancelled')
            signal.signal(signal.SIGTERM, interrupted)
            signal.signal(signal.SIGALRM, interrupted)
            marker.write_text(json.dumps({'pid': os.getpid(), 'start': Path('/proc/self/stat').read_text().split()[21]}))
            owns_marker = True
            if cancelled.exists():
                raise RuntimeFailure('login_cancelled')
            signal.alarm(220)
        if action == 'status':
            result = status()
        elif action == 'install':
            result = install(sys.stdin.buffer, job['target'])
        elif action == 'uninstall':
            result = uninstall()
        else:
            raise RuntimeFailure('invalid_browser_operation')
        print(json.dumps({'ok': True, 'data': result}), flush=True)
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeFailure) else 'browser_runtime_operation_failed'
        print(json.dumps({'ok': False, 'code': code}), flush=True)
        sys.exit(1)
    finally:
        signal.alarm(0)
        if owns_marker:
            marker.unlink(missing_ok=True)
            (JOBS / (job['job_id'] + '.cancel')).unlink(missing_ok=True)
        if lock is not None:
            lock.close()


if __name__ == '__main__':
    main()
