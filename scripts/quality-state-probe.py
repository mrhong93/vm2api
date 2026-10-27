"""Slot-local two-shot Codex state probe adapted from sub2api v2.17.3.

Keep the original full request, fresh sessions, two routing cookies, completed
streams and changed-ticket verdict. Transport uses this slot's network and
system TLS, rather than sub2api's Go TLS profile. Secrets stay in stdin/memory.
"""
import json
import signal
import socket
import sys
import time
import uuid
from http.cookies import SimpleCookie
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

MAX_BODY = 1 << 20
URL = 'https://chatgpt.com/backend-api/codex/responses'


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def parse_stream(data):
    text, model, completed, failed = '', '', False, False
    usage = None
    payloads, lines = [], []
    for line in data.decode('utf-8', errors='replace').replace('\r\n', '\n').split('\n') + ['']:
        if not line:
            if lines:
                payloads.append('\n'.join(lines)); lines = []
        elif line.startswith('data:'):
            lines.append(line[5:].lstrip(' '))
    for payload in payloads:
        if payload.strip() == '[DONE]':
            continue
        try:
            event = json.loads(payload)
        except (ValueError, TypeError):
            failed = True
            continue
        kind = event.get('type')
        response = event.get('response') or {}
        if kind in ['error', 'response.failed', 'response.incomplete']:
            failed = True
        if kind == 'response.output_text.delta':
            text += str(event.get('delta') or '')
        if kind == 'response.created' and response.get('model'):
            model = response['model']
        if kind == 'response.completed':
            completed = response.get('status', 'completed') == 'completed'
            model = model or response.get('model', '')
            usage = response.get('usage')
            if not text:
                text = ''.join(str(c.get('text') or '') for item in response.get('output', [])
                               for c in item.get('content', []) if c.get('type') == 'output_text')
    return {'complete': completed and not failed, 'text': text, 'model': model, 'usage': usage}


def route_cookies(headers):
    values = {}
    for raw in headers.get_all('Set-Cookie', []):
        cookie = SimpleCookie()
        try:
            cookie.load(raw)
        except Exception:
            continue
        for name in ['__cflb', '__oailb']:
            if name in values or name not in cookie or not cookie[name].value:
                continue
            try:
                if cookie[name]['max-age'] and int(cookie[name]['max-age']) <= 0:
                    continue
                if cookie[name]['expires'] and parsedate_to_datetime(cookie[name]['expires']) <= datetime.now(timezone.utc):
                    continue
            except (ValueError, TypeError):
                continue
            values[name] = cookie[name].value
    return '; '.join(name + '=' + value for name, value in values.items())


def fire(payload, state, cookie):
    headers = {
        'Authorization': 'Bearer ' + payload['access_token'],
        'Accept': 'text/event-stream', 'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses=experimental', 'session_id': str(uuid.uuid4()),
        'User-Agent': payload['user_agent'], 'originator': payload['originator'],
        'version': payload['version'], 'Connection': 'close',
    }
    if payload.get('account_id'):
        headers['ChatGPT-Account-Id'] = payload['account_id']
    if state:
        headers['x-codex-turn-state'] = state
    if cookie:
        headers['Cookie'] = cookie
    body = {'model': payload['model'], 'instructions': 'Reply with OK.',
            'input': [{'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'Reply with OK.'}]}],
            'stream': True, 'store': False, 'parallel_tool_calls': True, 'include': ['reasoning.encrypted_content']}
    # No system proxy/host fallback. The bound transparent exit is in this slot.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(Request(URL, data=json.dumps(body).encode(), headers=headers), timeout=45)
    except HTTPError as error:
        response = error
    with response:
        data = response.read(MAX_BODY + 1)
        parsed = parse_stream(data) if len(data) <= MAX_BODY else {'complete': False}
        return {**parsed, 'status': response.status,
                'state': response.headers.get('x-codex-turn-state', '').strip(),
                'cookies': route_cookies(response.headers),
                'unsupported_model': response.status == 400 and b'not supported' in data.lower()}


def run_probe(fire_shot):
    result = {'verdict': 'inconclusive', 'mint_status': 0, 'continue_status': 0,
              'ticket_length': 0, 'continue_ticket_length': 0, 'minted': False, 'new_ticket': False,
              'text': '', 'reported_model': '', 'usage': []}
    state, cookie = '', ''
    for phase in ['mint', 'continue']:
        try:
            shot = fire_shot(state, cookie)
        except (TimeoutError, socket.timeout, URLError, OSError):
            return {**result, 'failure': 'network_error', 'reason': '槽位网络请求失败或超时，无法判断'}
        status = shot.get('status', 0)
        result[phase + '_status'] = status
        result['ticket_length' if phase == 'mint' else 'continue_ticket_length'] = len(shot.get('state', ''))
        if shot.get('usage'):
            result['usage'].append(shot['usage'])
        if status != 200:
            failure = 'account_error' if status in [401, 403] else 'rate_limited' if status == 429 else 'model_unsupported' if shot.get('unsupported_model') else 'upstream_error'
            return {**result, 'failure': failure, 'reason': '上游请求失败（HTTP ' + str(status) + '），无法判断'}
        if not shot.get('complete'):
            return {**result, 'failure': 'stream_error', 'reason': 'HTTP 200 但回复流未完整结束，无法判断'}
        result['text'] = shot.get('text', '')
        result['reported_model'] = shot.get('model') or result['reported_model']
        if phase == 'mint':
            state, cookie = shot.get('state', ''), shot.get('cookies', '')
            if not state:
                return {**result, 'failure': 'no_ticket', 'reason': '打票成功但没有门票头，无法判断'}
            result['minted'] = True
        else:
            result['new_ticket'] = bool(shot.get('state') and shot['state'] != state)
    result['verdict'] = 'degraded' if result['new_ticket'] else 'healthy'
    result['reason'] = '续接返回不同的新门票，符合 sub2 疑似降级判据' if result['new_ticket'] else '续接未返回不同的新门票，符合 sub2 正常判据'
    return result


def main():
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    started = time.monotonic()
    try:
        payload = json.loads(sys.stdin.readline())
        def timed_shot(state, cookie):
            signal.alarm(45)
            try:
                return fire(payload, state, cookie)
            finally:
                signal.alarm(0)
        result = run_probe(timed_shot)
    except Exception:
        result = {'verdict': 'inconclusive', 'failure': 'probe_failed', 'reason': '槽位探针未完成，无法判断'}
    result['duration_ms'] = round((time.monotonic() - started) * 1000)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
