"""Real Chromium, entirely offline: every provider request is intercepted."""
import contextlib
import importlib.util
import io
import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse

spec = importlib.util.spec_from_file_location('registration_browser', Path(__file__).resolve().parents[1] / 'scripts/codex-mailbox-browser.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
EMAIL = 'fixture@example.com'
PASSWORD = 'Aa9!offline-fixture-generated-password'
SECRET = 'JBSWY3DPEHPK3PXP'


class ProvisioningTests(unittest.TestCase):
    def test_only_standard_matching_provisioning_data(self):
        self.assertEqual(mod.provisioning_secret('JBSW Y3DP EHPK 3PXP', EMAIL), SECRET)
        self.assertEqual(mod.provisioning_secret(f'otpauth://totp/OpenAI:{EMAIL}?secret={SECRET}&issuer=OpenAI', EMAIL), SECRET)
        self.assertIsNone(mod.provisioning_secret('ordinary text', EMAIL))
        for value in [f'otpauth://hotp/OpenAI:{EMAIL}?secret={SECRET}',
                      f'otpauth://totp/OpenAI:other@example.com?secret={SECRET}',
                      f'otpauth://totp/OpenAI:{EMAIL}?secret={SECRET}&digits=8',
                      f'otpauth://totp/OpenAI:{EMAIL}?secret={SECRET}&algorithm=SHA256']:
            with self.assertRaises(mod.FlowError):
                mod.provisioning_secret(value, EMAIL)


class RegistrationBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context(locale='ja-JP', timezone_id='Asia/Tokyo')
        self.context.set_default_timeout(2000)
        self.context.route('**/*', self.route)
        self.logged = False
        self.enabled = False
        self.mode = 'success'
        self.passwordless = False
        self.extra_email = False
        self.mfa_multistep = False
        self.password_popup = False
        self.password_confirmed = False
        self.email_codes = {}
        self.password_confirm_received = None
        self.password_received = None
        self.totp_received = None
        self.checkpoints = []
        self.stages = []
        self.requests = []
        self.flow = mod.BrowserLogin({'operation': 'register', 'email': EMAIL, 'password': PASSWORD})
        self.flow.pause = lambda page, milliseconds=750: (self.flow.check(), page.wait_for_timeout(30))
        self.flow.registration_attention = self.attention

    def tearDown(self):
        self.context.close()

    def attention(self, stage):
        raise mod.FlowError('fixture_manual_' + stage)

    def output(self, value, **kwargs):
        value = json.loads(value)
        if value.get('event') == 'registration_checkpoint':
            self.checkpoints.append(value['data'])
            self.flow.controls.put({'registration_checkpoint_saved': True})
        if value.get('event') == 'stage':
            self.stages.append(value['stage'])
            code = {'registration_email_code': '123456', 'registration_password_email_code': '111111', 'registration_mfa_email_code': '222222'}.get(value['stage'])
            if code:
                self.flow.controls.put({'verification_code': code})

    def route(self, route):
        req = route.request
        url = urlparse(req.url)
        self.requests.append((url.hostname, url.path))
        if url.hostname not in {'chatgpt.com', 'auth.openai.com'}:
            return route.abort()
        path = url.path
        if path == '/api/auth/session':
            email = 'other@example.com' if self.mode == 'wrong_identity' else EMAIL
            return route.fulfill(json={'accessToken': 'offline-token', 'user': {'email': email}} if self.logged else {})
        if path == '/fixture-password':
            self.password_received = req.post_data_json['password']
            return route.fulfill(json={})
        if path in {'/fixture-password-email', '/fixture-mfa-email'}:
            self.email_codes[path] = req.post_data_json['code']
            return route.fulfill(json={})
        if path == '/fixture-set-password':
            self.password_received = req.post_data_json['password']
            self.password_confirm_received = req.post_data_json['confirm']
            self.password_confirmed = self.password_received == PASSWORD and self.password_confirm_received == PASSWORD and self.mode != 'password_unconfirmed'
            return route.fulfill(json={})
        if path == '/fixture-verify':
            if req.post_data_json['code'] == '123456':
                self.logged = True
            return route.fulfill(json={})
        if path == '/fixture-totp':
            self.totp_received = req.post_data_json['code']
            self.enabled = self.totp_received == mod.totp_code(SECRET) and self.mode != 'unconfirmed'
            return route.fulfill(json={})
        body = ''
        if url.hostname == 'chatgpt.com' and self.logged:
            if self.mode == 'profile':
                body = '<h1>Tell us about yourself</h1><input name="birthday">'
            elif self.enabled:
                body = '<div role="dialog">Multi-factor authentication <button>Disable</button></div>'
            else:
                mfa_target = '/settings/mfa-email' if self.extra_email else '/mfa-enroll'
                if self.mode == 'unknown_mfa':
                    mfa_target = '/mfa-unknown'
                settings = f'<div role="dialog"><div>Multi-factor authentication <button onclick="location.href=\'https://auth.openai.com{mfa_target}\'">Enable</button></div></div>'
                password_target = '/settings/password-email' if self.extra_email else '/settings/new-password'
                password_action = f"window.open('https://auth.openai.com{password_target}')" if self.password_popup else f"location.href='https://auth.openai.com{password_target}'"
                account = f'<div role="dialog"><div>Password <button onclick="{password_action}">Change</button></div></div>'
                body = '<main></main><script>const render=()=>document.querySelector("main").innerHTML=location.hash.includes("Account")?' + json.dumps(account) + ':location.hash?' + json.dumps(settings) + ':"ChatGPT authenticated home";render();addEventListener("hashchange",render)</script>'
        elif path == '/' and url.hostname == 'chatgpt.com':
            target = '/log-in/password' if self.mode == 'existing' else '/log-in' if self.passwordless else '/create-account'
            label = 'Log in' if self.passwordless else 'Sign up for free'
            body = f'<button onclick="location.href=\'https://auth.openai.com{target}\'">{label}</button>'
        elif path == '/log-in':
            body = '<h1>Welcome</h1><form action="/email-verification"><input type="email" name="email"><button type="submit">Continue</button></form>'
        elif path in {'/settings/password-email', '/settings/mfa-email'}:
            is_password = 'password' in path
            api = '/fixture-password-email' if is_password else '/fixture-mfa-email'
            target = '/settings/new-password' if is_password else '/mfa-enroll'
            if not is_password and self.mfa_multistep:
                target = '/mfa-code'
            body = f'''<h1>Verify your email</h1><p>We sent a code to your email</p><form onsubmit="event.preventDefault();fetch('{api}',{{method:'POST',body:JSON.stringify({{code:document.querySelector('input').value}})}}).then(()=>location.href='{target}')">
                <input autocomplete="one-time-code"><button type="submit">Verify</button></form>'''
        elif path == '/settings/new-password':
            current = '<label>Current password<input type="password" autocomplete="current-password"></label>' if self.mode == 'current_password' else ''
            body = current + '''<h1>Set new password</h1><form onsubmit="event.preventDefault();fetch('/fixture-set-password',{method:'POST',body:JSON.stringify({password:document.querySelector('[name=password]').value,confirm:document.querySelector('[name=confirm]').value})}).then(()=>location.href='/settings/password-complete')">
                <input type="password" name="password" autocomplete="new-password"><input type="password" name="confirm" autocomplete="new-password"><button type="submit">Save</button></form>'''
        elif path == '/settings/password-complete':
            body = '<h1>Password successfully updated</h1>' if self.password_confirmed else '<h1>Unable to update password</h1>'
        elif path == '/create-account':
            body = '<h1>Create account</h1><form action="/create-account/password"><input type="email" name="email"><button type="submit">Continue</button></form>'
        elif path in ['/create-account/password', '/log-in/password']:
            body = ('<h1>Create account</h1>' if 'create-account' in path else '<h1>Log in</h1>') + '''
                <form onsubmit="event.preventDefault();fetch('/fixture-password',{method:'POST',body:JSON.stringify({password:document.querySelector('input').value})}).then(()=>location.href='/email-verification')">
                <input type="password"><button type="submit">Continue</button></form>'''
        elif path == '/email-verification':
            body = '''<h1>Verify email</h1><form onsubmit="event.preventDefault();fetch('/fixture-verify',{method:'POST',body:JSON.stringify({code:document.querySelector('input').value})}).then(()=>location.href='https://chatgpt.com/')">
                <input autocomplete="one-time-code"><button type="submit">Verify</button></form>'''
        elif path == '/mfa-enroll' and self.mfa_multistep:
            body = f'''<div role="dialog"><h1>Scan QR code</h1><p>Setup key</p><code>{SECRET}</code><button onclick="location.href='/settings/mfa-email'">Next</button></div>'''
        elif path in {'/mfa-enroll', '/mfa-code', '/mfa-unknown'}:
            body = f'''<div role="dialog"><h1>Scan QR code</h1><p>Setup key</p><code>{SECRET}</code>
                <form onsubmit="event.preventDefault();fetch('/fixture-totp',{{method:'POST',body:JSON.stringify({{code:document.querySelector('input').value}})}}).then(()=>location.href='https://chatgpt.com/#settings/Security')">
                <input autocomplete="one-time-code"><button type="submit">Verify</button></form></div>'''
            if path != '/mfa-enroll':
                body = body.replace(f'<h1>Scan QR code</h1><p>Setup key</p><code>{SECRET}</code>', '<h1>Authenticator app code</h1>' if path == '/mfa-code' else '<h1>Verification code</h1>')
        else:
            return route.fulfill(status=404, body='Offline fixture missing page')
        route.fulfill(content_type='text/html', body='<!doctype html><html><body>' + body + '</body></html>')

    def run_flow(self):
        with patch('builtins.print', self.output):
            return self.flow.register_account(self.context)

    def test_signup_email_code_password_totp_and_identity_confirmation(self):
        result = self.run_flow()
        self.assertEqual(result, {'email': EMAIL, 'password_verified': True, 'totp_secret': SECRET, 'totp_verified': True})
        self.assertEqual(self.password_received, PASSWORD)
        self.assertTrue(re.fullmatch(r'\d{6}', self.totp_received))
        self.assertEqual([c['phase'] for c in self.checkpoints], ['submitted', 'account_created', 'password_set', 'totp_pending'])
        self.assertIn('registration_email_code', self.stages)
        self.assertTrue(all(host in {'chatgpt.com', 'auth.openai.com'} for host, path in self.requests))

    def test_passwordless_entry_then_password_and_mfa_with_separate_email_challenges(self):
        self.passwordless = self.extra_email = True
        result = self.run_flow()
        self.assertTrue(result['password_verified'] and result['totp_verified'])
        self.assertEqual(self.password_received, PASSWORD)
        self.assertEqual(self.password_confirm_received, PASSWORD)
        self.assertEqual(self.email_codes, {'/fixture-password-email': '111111', '/fixture-mfa-email': '222222'})
        self.assertEqual([c['phase'] for c in self.checkpoints], ['submitted', 'account_created', 'password_submitted', 'password_set', 'totp_pending'])
        self.assertLess(self.stages.index('registration_password_email_code'), self.stages.index('registration_mfa_email_code'))
        self.assertLess(self.stages.index('registration_mfa_email_code'), self.stages.index('registration_verifying_totp'))

    def test_unconfirmed_password_never_starts_mfa_or_reports_success(self):
        self.passwordless = True
        self.mode = 'password_unconfirmed'
        with self.assertRaisesRegex(mod.FlowError, 'fixture_manual_registration_password_attention'):
            self.run_flow()
        self.assertEqual(self.password_received, PASSWORD)
        self.assertIsNone(self.totp_received)
        self.assertNotIn('password_set', [c['phase'] for c in self.checkpoints])

    def test_password_settings_can_open_an_official_popup(self):
        self.passwordless = self.password_popup = True
        result = self.run_flow()
        self.assertTrue(result['password_verified'] and result['totp_verified'])
        self.assertEqual(self.password_received, PASSWORD)

    def test_email_challenge_after_key_capture_is_still_not_a_totp_challenge(self):
        self.mfa_multistep = True
        result = self.run_flow()
        self.assertTrue(result['totp_verified'])
        self.assertEqual(self.email_codes, {'/fixture-mfa-email': '222222'})
        self.assertTrue(self.enabled)

    def test_unknown_otp_prompt_never_receives_a_stored_totp(self):
        self.logged = True
        self.mode = 'unknown_mfa'
        self.flow.payload.update(registration_phase='totp_pending', password_verified=True, totp_secret=SECRET)
        with self.assertRaisesRegex(mod.FlowError, 'fixture_manual_registration_security_attention'):
            self.run_flow()
        self.assertIsNone(self.totp_received)
        self.assertEqual(self.email_codes, {})

    def test_current_password_is_not_guessed_or_overwritten(self):
        self.passwordless = True
        self.mode = 'current_password'
        with self.assertRaisesRegex(mod.FlowError, 'fixture_manual_registration_password_attention'):
            self.run_flow()
        self.assertIsNone(self.password_received)
        self.assertIsNone(self.totp_received)

    def test_resume_confirmed_password_does_not_change_it_again_and_never_sends_totp_to_email(self):
        self.logged = self.extra_email = True
        self.flow.payload.update(registration_phase='totp_pending', password_verified=True, totp_secret=SECRET)
        result = self.run_flow()
        self.assertTrue(result['totp_verified'])
        self.assertIsNone(self.password_received)
        self.assertEqual(self.email_codes, {'/fixture-mfa-email': '222222'})
        self.assertNotIn('registration_opening_password', self.stages)

    def test_old_unconfirmed_totp_draft_must_set_password_first(self):
        self.logged = True
        self.flow.payload.update(registration_phase='totp_pending', totp_secret=SECRET)
        result = self.run_flow()
        self.assertTrue(result['password_verified'])
        self.assertEqual(self.password_received, PASSWORD)
        self.assertEqual(self.checkpoints[0]['phase'], 'password_submitted')

    def test_existing_account_login_page_never_receives_generated_password(self):
        self.mode = 'existing'
        with self.assertRaisesRegex(mod.FlowError, 'registration_existing_account'):
            self.run_flow()
        self.assertIsNone(self.password_received)
        self.assertEqual(self.checkpoints, [])

    def test_takeover_resume_preserves_email_code_stage(self):
        original_output = self.output
        injected = False

        def output(value, **kwargs):
            nonlocal injected
            event = json.loads(value)
            if event.get('stage') == 'registration_email_code' and not injected:
                injected = True
                self.flow.controls.put({'id': 'take', 'op': 'takeover'})
                self.flow.controls.put({'id': 'resume', 'op': 'resume'})
            original_output(value, **kwargs)

        with patch('builtins.print', output):
            result = self.flow.register_account(self.context)
        self.assertTrue(result['totp_verified'])
        manual_index = self.stages.index('manual_control')
        self.assertEqual(self.stages[manual_index + 1], 'registration_email_code')
        self.assertIsNone(self.flow.waiting_code_stage)

    def test_existing_session_cannot_be_claimed_as_a_new_registration(self):
        self.logged = True
        with self.assertRaisesRegex(mod.FlowError, 'registration_existing_session'):
            self.run_flow()
        self.assertIsNone(self.password_received)

    def test_wrong_identity_never_enters_security_settings(self):
        self.mode = 'wrong_identity'
        with self.assertRaisesRegex(mod.FlowError, 'authorized_email_mismatch'):
            self.run_flow()
        self.assertFalse(any(path == '/mfa-enroll' for host, path in self.requests))

    def test_missing_provider_confirmation_does_not_return_a_completed_account(self):
        self.mode = 'unconfirmed'
        with self.assertRaisesRegex(mod.FlowError, 'fixture_manual_registration_security_attention'):
            self.run_flow()
        self.assertEqual(self.checkpoints[-1]['totp_secret'], SECRET)
        self.assertFalse(self.enabled)

    def test_unexpected_origin_is_rejected_before_any_password_input(self):
        page = self.context.new_page()
        self.context.route('https://chatgpt.com.evil.example/**', lambda route: route.fulfill(body='<p>not a provider</p>'))
        page.goto('https://chatgpt.com.evil.example/')
        with self.assertRaisesRegex(mod.FlowError, 'unexpected_authorization_origin'):
            self.flow.registration_origin(page)


if __name__ == '__main__':
    unittest.main()
