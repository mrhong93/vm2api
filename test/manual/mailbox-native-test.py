"""Native X11 integration on an offline disposable slot, never real accounts."""
import base64
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import time
import uuid

source = Path(sys.argv[1])
runtime = Path(os.environ['KIN_MAILBOX_ROOT'])
html = runtime / 'tmp/native-fixture.html'
html.write_text('''<!doctype html><meta charset="utf-8"><style>body{margin:0}
button{display:block;width:500px;height:200px}textarea{width:600px;height:100px}</style>
<button onclick="field.value='clicked fixture';field.focus();field.select()">Native input fixture</button>
<textarea id="field" autofocus></textarea><script>
field.value=JSON.stringify({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
language:navigator.language,webdriver:navigator.webdriver});field.focus();field.select();
</script>''')

def start(payload):
    child = subprocess.Popen([sys.executable, '-u', str(source / 'scripts/mailbox-native-browser.py')],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    inbox = queue.Queue()
    def read():
        for line in child.stdout:
            inbox.put(json.loads(line))
    threading.Thread(target=read, daemon=True).start()
    child.stdin.write(json.dumps(payload) + '\n')
    child.stdin.flush()
    event = inbox.get(timeout=20)
    if event.get('stage') != 'native_manual_login':
        child.wait(timeout=15)
        raise AssertionError((event, child.stderr.read()))
    return child, inbox

def control(child, inbox, op, **fields):
    request_id = str(uuid.uuid4())
    child.stdin.write(json.dumps({'id': request_id, 'op': op, **fields}) + '\n')
    child.stdin.flush()
    reply = inbox.get(timeout=15)
    assert reply.get('id') == request_id and reply.get('ok'), {k:v for k,v in reply.items() if k != 'data'}
    return reply['data']

def navigate(child, inbox, url):
    control(child, inbox, 'key', key='Control+l')
    time.sleep(.15)
    control(child, inbox, 'key', key='Control+a')
    control(child, inbox, 'text', text=url)
    time.sleep(.15)
    control(child, inbox, 'key', key='Enter')

payload = {'remote': True, 'profile_id': 'fictional-native-slot', 'slot_environment': {
    'locale': 'ja_JP.UTF-8', 'timezone': 'Asia/Tokyo', 'proxy_mode': 'slot_network'}}
child, inbox = start(payload)
try:
    time.sleep(3)
    navigate(child, inbox, html.as_uri())
    time.sleep(2)
    control(child, inbox, 'key', key='Control+a')
    control(child, inbox, 'key', key='Control+c')
    time.sleep(.2)
    text = control(child, inbox, 'clipboard')['text']
    if not text.startswith('{'):
        frame = control(child, inbox, 'frame')
        (runtime / 'tmp/native-startup.png').write_bytes(base64.b64decode(frame['image']))
        raise AssertionError('Fictional page clipboard: ' + repr(text))
    identity = json.loads(text)
    assert identity == {'timezone': 'Asia/Tokyo', 'language': 'ja-JP', 'webdriver': False}, identity
    control(child, inbox, 'click', x=150, y=300)
    control(child, inbox, 'key', key='Control+c')
    time.sleep(.2)
    assert control(child, inbox, 'clipboard')['text'] == 'clicked fixture'
    control(child, inbox, 'text', text='原生输入 fixture 123')
    control(child, inbox, 'key', key='Control+a')
    control(child, inbox, 'key', key='Control+c')
    time.sleep(.2)
    assert control(child, inbox, 'clipboard')['text'] == '原生输入 fixture 123'
    frame = control(child, inbox, 'frame')
    assert frame['mime'] == 'image/png' and frame['width'] == 1365 and frame['height'] == 900
    assert len(frame['image']) > 1000
    print(json.dumps({'native_desktop': 'passed', 'real_x11_pointer_keyboard_clipboard': True,
        'identity': identity, 'frame_bytes_base64': len(frame['image'])}), flush=True)
finally:
    child.stdin.write('{"cancel":true}\n')
    child.stdin.flush()
    child.wait(timeout=15)

# Exercise a complete native browser callback. The code is fictional and never exchanged.
payload = {**payload, 'remote': False, 'auth_url': 'https://auth.openai.com/oauth/authorize?state=offline-fixture',
           'state': 'offline-fixture'}
child, inbox = start(payload)
try:
    time.sleep(3)
    with socket.create_connection(('127.0.0.1', 1455), timeout=2):
        before = time.monotonic()
        control(child, inbox, 'key', key='Escape')
        assert time.monotonic() - before < 1.5, 'Idle callback socket blocked remote input'
    navigate(child, inbox, 'http://localhost:1455/auth/callback?state=wrong-state&code=fictional')
    time.sleep(.3)
    assert child.poll() is None
    navigate(child, inbox, 'http://localhost:1455/auth/callback?state=offline-fixture&code=fictional')
    event = inbox.get(timeout=15)
    assert event.get('event') == 'callback' and 'code=fictional' in event['callback_url'], event
    assert child.wait(timeout=15) == 0
    print(json.dumps({'native_oauth_callback': 'passed', 'invalid_state_rejected': True,
        'real_accounts_used': False, 'network': 'none'}), flush=True)
finally:
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=15)
memory = Path('/sys/fs/cgroup/memory.peak')
if memory.exists():
    print(json.dumps({'offline_peak_mib': round(int(memory.read_text()) / 1024**2, 1)}), flush=True)
