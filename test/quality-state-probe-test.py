"""Offline fixtures for the two-shot state probe; no tokens or network required."""
import importlib.util
import json
from email.message import Message
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('probe', Path(__file__).resolve().parents[1] / 'scripts/quality-state-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def shot(state='ticket-a', **kwargs):
    return dict(status=200, complete=True, state=state, cookies='__cflb=lb; __oailb=route', text='OK', model='model-label', **kwargs)


class StateProbeTest(unittest.TestCase):
    def run_shots(self, first, second):
        calls = []

        def fire(state, cookie):
            calls.append((state, cookie))
            return first if len(calls) == 1 else second

        result = probe.run_probe(fire)
        self.assertEqual(calls[0], ('', ''))
        if len(calls) == 2:
            self.assertEqual(calls[1], (first['state'], first['cookies']))
        self.assertNotIn('ticket-a', json.dumps(result))
        self.assertNotIn('__cflb', json.dumps(result))
        return result

    def test_same_or_absent_continue_ticket_is_healthy(self):
        for state in ['ticket-a', '']:
            self.assertEqual(self.run_shots(shot(), shot(state))['verdict'], 'healthy')

    def test_changed_ticket_is_degraded(self):
        self.assertEqual(self.run_shots(shot(), shot('ticket-b'))['verdict'], 'degraded')

    def test_no_mint_ticket_is_inconclusive(self):
        result = self.run_shots(shot(''), shot())
        self.assertEqual(result['verdict'], 'inconclusive')
        self.assertEqual(result['failure'], 'no_ticket')
        self.assertEqual(result['continue_status'], 0)

    def test_errors_and_partial_streams_never_pass(self):
        for status in [400, 401, 403, 429, 500]:
            for phase in [0, 1]:
                shots = [shot(), shot()]
                shots[phase]['status'] = status
                result = self.run_shots(*shots)
                self.assertEqual(result['verdict'], 'inconclusive')
        for phase in [0, 1]:
            shots = [shot(), shot()]
            shots[phase]['complete'] = False
            self.assertEqual(self.run_shots(*shots)['failure'], 'stream_error')

    def test_network_error_is_inconclusive(self):
        def fire(*_):
            raise TimeoutError()
        self.assertEqual(probe.run_probe(fire)['failure'], 'network_error')

    def test_sse_requires_completed_and_rejects_failures(self):
        complete = b'data: {"type":"response.completed","response":{"status":"completed","model":"label","output":[{"content":[{"type":"output_text","text":"OK"}]}]}}\n\n'
        self.assertTrue(probe.parse_stream(complete)['complete'])
        self.assertEqual(probe.parse_stream(complete)['text'], 'OK')
        self.assertFalse(probe.parse_stream(b'data: {"type":"response.created"}\n\n')['complete'])
        for failed in [b'error', b'response.failed', b'response.incomplete']:
            self.assertFalse(probe.parse_stream(complete + b'data: {"type":"' + failed + b'"}\n\n')['complete'])
        self.assertFalse(probe.parse_stream(complete + b'data: not-json\n\n')['complete'])

    def test_only_two_live_routing_cookies_are_carried(self):
        headers = Message()
        for value in ['other=secret', '__cflb=lb; Secure', '__oailb=deleted; Max-Age=-1', '__oailb=route; HttpOnly']:
            headers.add_header('Set-Cookie', value)
        self.assertEqual(probe.route_cookies(headers), '__cflb=lb; __oailb=route')

    def test_full_body_fresh_sessions_and_exact_ticket_headers(self):
        class Response:
            status = 200
            headers = Message()
            def read(self, _):
                return b'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
        requests = []
        class Opener:
            def open(self, req, timeout):
                requests.append(req)
                return Response()
        payload = dict(access_token='private-token', model='gpt-test', account_id='private-account', user_agent='codex-agent', originator='codex_cli_rs', version='0.160.0')
        with patch.object(probe, 'build_opener', return_value=Opener()):
            probe.fire(payload, '', '')
            probe.fire(payload, 'ticket-a', '__cflb=lb')
        self.assertNotEqual(requests[0].get_header('Session_id'), requests[1].get_header('Session_id'))
        self.assertIsNone(requests[0].get_header('X-codex-turn-state'))
        self.assertEqual(requests[1].get_header('X-codex-turn-state'), 'ticket-a')
        self.assertEqual(requests[1].get_header('Cookie'), '__cflb=lb')
        body = json.loads(requests[0].data)
        self.assertEqual(body, dict(model='gpt-test', instructions='Reply with OK.',
            input=[dict(type='message', role='user', content=[dict(type='input_text', text='Reply with OK.')])],
            stream=True, store=False, parallel_tool_calls=True, include=['reasoning.encrypted_content']))


if __name__ == '__main__':
    unittest.main()
