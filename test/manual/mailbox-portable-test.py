"""Offline r5 integration in a disposable, read-only, capless Docker slot.

Requires a matching Ubuntu/Debian image with python3, and an r5 bundle.
No account, external network, existing slot or profile is used.
"""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--scripts', type=Path, default=Path(__file__).resolve().parents[2] / 'scripts')
    parser.add_argument('--work-dir', type=Path, default=Path('/var/tmp'),
                        help='Disk-backed host directory; do not use tmpfs for the browser installation')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run on a Linux Docker test host as root to prepare the synthetic UID 10005 home')
    bundle = args.bundle.resolve(strict=True)
    scripts = args.scripts.resolve(strict=True)
    runner = (scripts / 'mailbox-runtime-slot.py').read_text()
    # Browser files on host tmpfs are charged as unreclaimable shared memory to
    # the installing container, invalidating its ordinary 1 GiB runtime limit.
    base = Path(tempfile.mkdtemp(prefix='vm2api-portable-fixture-', dir=args.work_dir))
    home = base / 'home'
    home.mkdir(mode=0o700)
    os.chown(home, 10005, 987)
    name = 'vm2api-portable-fixture-' + uuid.uuid4().hex[:12]
    runtime = home / '.local/share/kin-mailbox'

    def docker(*argv):
        return subprocess.check_output(['docker', *argv], stderr=subprocess.STDOUT).decode()

    def command():
        return ['docker', 'exec', '-i', '-u', '10005:987', name, 'python3', '-u', '-c', runner]

    def operation(action, archive=None, success=True, job_id=None):
        request = {'action': action, 'target': facts, 'job_id': job_id or str(uuid.uuid4())}
        child = subprocess.Popen(command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            child.stdin.write((json.dumps(request) + '\n').encode())
            if archive:
                with archive.open('rb') as stream:
                    shutil.copyfileobj(stream, child.stdin)
            child.stdin.close()
            child.stdin = None
            out, err = child.communicate(timeout=250)
        except Exception:
            child.kill()
            child.wait()
            raise
        result = json.loads(out)
        assert result.get('ok') is success, (result, err.decode()[-1500:])
        assert (child.returncode == 0) is success, result
        return result

    def retained():
        for folder in ['profiles', 'cache', 'config']:
            assert (runtime / folder / 'fixture-only').read_text() == 'synthetic session marker'

    facts = {}
    try:
        docker('run', '-d', '--name', name, '--network', 'none', '--read-only',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10005:987',
               '--memory', '1536m', '--memory-swap', '1536m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
               '-v', str(home) + ':/home/kincli', '-v', str(scripts) + ':/fixture-source:ro',
               '--entrypoint', 'sleep', args.image, 'infinity')
        denied = subprocess.run(['docker', 'exec', '-u', '0', name, 'ls', '/home/kincli'], capture_output=True)
        assert denied.returncode != 0, 'Fixture must enforce ordinary-user 0700 home isolation'
        facts = operation('status')['data']
        assert facts['supported'] and not facts['installed'], facts
        info = operation('install', bundle)['data']
        assert info['verified'] and info['graphical'] and not info['needs_upgrade'], info
        assert info['revision'] == 5 and info['native_input'] and info['version'] == '1.64.1', info
        print('PASS fresh installation: temporary-path graphical launch, screenshot and click', flush=True)
        display_binary = runtime / 'display/bin/Xvfb'
        original_mode = display_binary.stat().st_mode & 0o777
        try:
            display_binary.chmod(0o644)
            degraded = operation('status')['data']
            assert not degraded['graphical'] and degraded['needs_upgrade'], degraded
        finally:
            display_binary.chmod(original_mode)
        assert operation('status')['data']['graphical']
        print('PASS missing display execution permission requires an environment upgrade', flush=True)

        # Exercise the real login runner's headed persistent-context and remote
        # input paths; replace authorization with a local synthetic page only.
        code = r'''
import importlib.util, os
from pathlib import Path
root = Path('/home/kincli/.local/share/kin-mailbox')
os.environ.update(KIN_MAILBOX_ROOT=str(root), PLAYWRIGHT_BROWSERS_PATH=str(root/'browsers'),
    LD_LIBRARY_PATH=str(root/'lib'), TMPDIR=str(root/'tmp'), FONTCONFIG_FILE=str(root/'fonts.conf'),
    XDG_CACHE_HOME=str(root/'cache'), XDG_CONFIG_HOME=str(root/'config'))
# LD_LIBRARY_PATH must be applied before Python starts (passed via docker exec).
spec=importlib.util.spec_from_file_location('mailbox', '/fixture-source/codex-mailbox-browser.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
flow=mod.BrowserLogin({'email':'fixture@example.invalid','mode':'fixture',
    'slot_environment':{'locale':'ja_JP.UTF-8','timezone':'Asia/Tokyo','proxy_mode':'slot_network'}})
def authorize(context):
    context.route('**/*', lambda route: route.abort())
    page=context.pages[0] if context.pages else context.new_page()
    flow.active_page=page
    page.set_content('<iframe srcdoc="&lt;button onclick=\'this.textContent=String.fromCharCode(111,107)\'&gt;click&lt;/button&gt;"></iframe>')
    assert not page.evaluate("navigator.userAgent.includes('HeadlessChrome')")
    assert page.evaluate('navigator.language')=='ja-JP'
    assert page.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone')=='Asia/Tokyo'
    button=page.frame_locator('iframe').locator('button')
    button.wait_for()
    box=button.bounding_box()
    flow.control({'op':'takeover'})
    flow.control({'op':'click','x':box['x']+box['width']/2,'y':box['y']+box['height']/2})
    assert button.inner_text()=='ok'
    frame=flow.control({'op':'frame'})
    assert frame['width']==1365 and frame['height']==900 and len(frame['image'])>100
    return 'fixture-complete'
flow.authorize=authorize
flow.run()
'''
        docker('exec', '-u', '10005:987', '-e', 'LD_LIBRARY_PATH=/home/kincli/.local/share/kin-mailbox/lib',
               name, '/home/kincli/.local/share/kin-mailbox/venv/bin/python', '-c', code)
        print('PASS real runner: headed browser, slot locale/timezone, iframe remote click and frame', flush=True)
        for folder in ['profiles', 'cache', 'config']:
            p = runtime / folder
            p.mkdir(exist_ok=True)
            os.chown(p, 10005, 987)
            (p / 'fixture-only').write_text('synthetic session marker')
            os.chown(p / 'fixture-only', 10005, 987)
        assert operation('install', bundle)['data']['verified']
        retained()
        print('PASS reinstall preserves synthetic profiles/cache/config', flush=True)

        invalid = base / 'invalid.tar.gz'
        invalid.write_bytes(b'invalid fixture archive')
        operation('install', invalid, success=False)
        assert operation('status')['data']['graphical']
        retained()
        # Metadata is valid; absent Playwright forces actual launch verification
        # to fail before the old environment may be replaced.
        invalid = base / 'failed-launch.tar.gz'
        with tarfile.open(invalid, 'w:gz') as archive:
            for item in ['venv', 'venv/bin', 'display']:
                entry = tarfile.TarInfo(item)
                entry.type = tarfile.DIRTYPE
                entry.mode = 0o755
                archive.addfile(entry)
            metadata = {**facts, 'version': '1.64.1', 'revision': 5, 'native_input': True}
            for item, content in [('portable.json', json.dumps(metadata)), ('display/runtime.py', '# fixture')]:
                entry = tarfile.TarInfo(item)
                data = content.encode()
                entry.size = len(data)
                entry.mode = 0o644
                archive.addfile(entry, io.BytesIO(data))
        assert operation('install', invalid, success=False)['code'] == 'browser_launch_failed'
        assert operation('status')['data']['graphical']
        retained()
        print('PASS corrupt archive and failed browser verification preserve old runtime', flush=True)

        job_id = str(uuid.uuid4())
        child = subprocess.Popen(command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        child.stdin.write((json.dumps({'action': 'install', 'job_id': job_id, 'target': facts}) + '\n').encode())
        child.stdin.flush()
        marker = f'/tmp/kin-mailbox-maintenance-10005/{job_id}.json'
        for _ in range(100):
            if docker('exec', name, 'python3', '-c', f'from pathlib import Path;print(Path({marker!r}).exists())').strip() == 'True':
                break
            time.sleep(0.05)
        operation('cancel', job_id=job_id)
        child.stdin.close()
        child.stdin = None
        out, _ = child.communicate(timeout=25)
        assert child.returncode != 0 and json.loads(out)['code'] == 'login_cancelled'
        retained()
        assert operation('status')['data']['graphical']
        print('PASS cancellation leaves previous environment intact', flush=True)

        assert not operation('uninstall')['data']['installed']
        assert not (runtime / 'display').exists()
        retained()
        assert operation('install', bundle)['data']['verified']
        retained()
        assert home.stat().st_mode & 0o777 == 0o700
        inspect = json.loads(docker('inspect', name))[0]
        assert inspect['HostConfig']['ReadonlyRootfs'] and inspect['HostConfig']['NetworkMode'] == 'none'
        assert inspect['HostConfig']['CapDrop'] == ['ALL']
        print('PASS uninstall removes display; clean reinstall preserves data and isolation', flush=True)
        print('ALL PASS ' + facts['os'] + ' ' + facts['os_version'] + ' ' + facts['arch'], flush=True)
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(base)


if __name__ == '__main__':
    main()
