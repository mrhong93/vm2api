import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMailboxStore, mailboxError } from '../../src/lib/oauth/codex-mailbox-store.mjs'
import { createRegistrationStore } from '../../src/lib/oauth/codex-registration-store.mjs'
import { createCodexMailboxService } from '../../src/lib/oauth/codex-mailbox-service.mjs'

process.env.VM2API_DB_SECRET = 'registration-fixture-key-not-production'
const owner = { id: 'registration-user' },
  email = 'registration@example.com',
  secret = 'JBSWY3DPEHPK3PXP'
const jwt = `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.x`
function harness(t, options = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'registration-test-'))
  const store = createMailboxStore(projectRoot),
    registrations = createRegistrationStore(projectRoot)
  const vm = {
    id: 'vm-01',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    proxy: { id: 'px-fixture', host: '127.0.0.1', port: 1080 },
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
  }
  const calls = [],
    account = {}
  const service = createCodexMailboxService({
    projectRoot,
    store,
    registrations,
    getSlot: () => vm,
    accountFor: () => account,
    checkNetwork: async () => calls.push('network'),
    generate: () => ({ session_id: 'fixture', auth_url: 'https://auth.openai.com/oauth/authorize?state=fixture' }),
    exchange: async () => ({ access_token: jwt, refresh_token: 'fixture-refresh', id_token: jwt }),
    commit: async () => {
      calls.push('commit')
      assert.equal(store.summary(vm.id).login_armed, false)
    },
    runSlot: async (args) => {
      calls.push(args.action)
      if (args.action === 'register') {
        assert.equal(args.vm, vm)
        assert.match(args.payload.password, /^Aa9![a-f0-9]{48}$/)
        args.onCheckpoint({ email, phase: 'submitted' })
        args.onCheckpoint({ email, phase: 'account_created' })
        args.onCheckpoint({ email, phase: 'password_set', password_verified: true })
        args.onCheckpoint({ email, phase: 'totp_pending', totp_secret: secret })
        return { email, password_verified: true, totp_secret: secret, totp_verified: true }
      }
      return { callback: 'http://localhost:1455/auth/callback?code=fixture&state=fixture' }
    },
    ...options,
  })
  t.after(async () => {
    service.stop()
    await service.settle()
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })
  return { projectRoot, store, registrations, vm, account, calls, service }
}

test('registration confirms MFA before encrypted pool insertion and binding, then arms only after OAuth', async (t) => {
  const h = harness(t)
  const initial = h.service.register('vm-01', email.toUpperCase(), owner)
  assert.equal(initial.configured, false)
  assert.equal(initial.registration.phase, 'draft')
  const draft = h.registrations.read('vm-01', owner)
  assert.equal(draft.email, email)
  assert.equal(h.store.pool.list(owner).length, 0)
  await h.service.settle()
  const status = h.service.status('vm-01')
  assert.equal(status.state.status, 'succeeded')
  assert.equal(status.login_armed, true)
  assert.equal(status.registration.mfa_verified, true)
  assert.equal(status.registration.password_verified, true)
  assert.equal(h.store.pool.list(owner).length, 1)
  assert.equal(h.store.read('vm-01').password, draft.password)
  assert.equal(h.store.read('vm-01').totp_secret, secret)
  assert.deepEqual(
    h.calls.filter((c) => c !== 'network'),
    ['prepare', 'register', 'prepare', 'login', 'commit'],
  )
  assert.ok(!JSON.stringify(status).includes(draft.password))
  assert.ok(!JSON.stringify(status).includes(secret))
  for (const directory of ['codex-registration', 'codex-login-pool', 'codex-mailbox']) {
    for (const file of fs.readdirSync(path.join(h.projectRoot, 'data', directory))) {
      const text = fs.readFileSync(path.join(h.projectRoot, 'data', directory, file), 'utf8')
      assert.ok(!text.includes(draft.password) && !text.includes(secret))
    }
  }
  assert.throws(() => h.service.registrationReveal('vm-01', { id: 'other' }), /registration_owner_mismatch/)
  assert.equal(h.service.registrationReveal('vm-01', owner).password, draft.password)
})

test('occupied, stopped, duplicate-email and unproxied slots do not start registration', (t) => {
  const h = harness(t)
  h.vm.status = 'stopped'
  assert.throws(() => h.service.register('vm-01', email, owner), /slot_not_running/)
  h.vm.status = 'running'
  h.account.access_token = 'existing'
  assert.throws(() => h.service.register('vm-01', email, owner), /registration_empty_slot_required/)
  delete h.account.access_token
  const proxy = h.vm.proxy
  delete h.vm.proxy
  assert.throws(() => h.service.register('vm-01', email, owner), /proxy_required/)
  h.vm.proxy = proxy
  h.store.pool.import(`${email}----existing-password----${secret}`, owner)
  assert.throws(() => h.service.register('vm-01', email, owner), /registration_email_exists/)
  h.store.save('vm-01', {
    mode: 'password_totp',
    email: 'another@example.com',
    password: 'bound-password',
    totp_secret: secret,
  })
  assert.throws(() => h.service.register('vm-01', 'fresh@example.com', owner), /registration_empty_slot_required/)
  assert.equal(h.registrations.read('vm-01'), null)
  assert.deepEqual(h.calls, [])
})

test('an empty soft-paused resting slot can register and authorize without enabling scheduling or automatic retries', async (t) => {
  const h = harness(t)
  h.vm.schedulable = false
  h.vm.schedule_off = true
  h.vm.status = 'paused'
  h.service.register('vm-01', email, owner)
  await h.service.settle()
  assert.equal(h.service.status('vm-01').state.status, 'succeeded')
  assert.equal(h.service.status('vm-01').login_armed, true)
  assert.equal(h.store.pool.list(owner).length, 1)
  assert.equal(h.vm.schedulable, false)
  h.calls.length = 0
  await h.service.tick()
  assert.deepEqual(h.calls, [])
})

test('failed or unconfirmed registration retains the same recovery password without binding or autoretry', async (t) => {
  let savedPassword
  const h = harness(t, {
    runSlot: async ({ action, payload, onCheckpoint }) => {
      if (action !== 'register') return {}
      if (savedPassword) assert.equal(payload.password, savedPassword)
      savedPassword = payload.password
      if (payload.registration_phase === 'draft') onCheckpoint({ email, phase: 'submitted' })
      return { email, totp_secret: secret, totp_verified: false }
    },
  })
  for (let i = 0; i < 2; i++) {
    h.service.register('vm-01', email, owner)
    await h.service.settle()
    assert.equal(h.service.status('vm-01').state.error_code, 'registration_password_unconfirmed')
    assert.equal(h.service.status('vm-01').configured, false)
    assert.equal(h.store.pool.list(owner).length, 0)
    await h.service.tick()
    assert.equal(h.service.registrationReveal('vm-01', owner).password, savedPassword)
  }
  assert.throws(() => h.service.register('vm-01', 'different@example.com', owner), /registration_recovery_pending/)
})

test('registration email mismatch and result without durable TOTP confirmation cannot enter the pool', async (t) => {
  for (const mismatch of [true, false]) {
    const h = harness(t, {
      runSlot: async ({ action }) =>
        action === 'register'
          ? { email: mismatch ? 'different@example.com' : email, totp_secret: secret, totp_verified: true }
          : {},
    })
    h.service.register('vm-01', email, owner)
    await h.service.settle()
    assert.equal(
      h.service.status('vm-01').state.error_code,
      mismatch ? 'authorized_email_mismatch' : 'registration_password_unconfirmed',
    )
    assert.equal(h.store.pool.list(owner).length, 0)
  }
})

test('OAuth failure keeps confirmed pool credentials bound but never arms automatic login', async (t) => {
  const h = harness(t, {
    exchange: async () => {
      throw mailboxError('oauth_denied')
    },
  })
  h.service.register('vm-01', email, owner)
  await h.service.settle()
  const status = h.service.status('vm-01')
  assert.equal(status.configured, true)
  assert.equal(status.login_armed, false)
  assert.equal(status.registration.mfa_verified, true)
  assert.equal(status.state.error_code, 'oauth_denied')
  const previous = [...h.calls]
  await h.service.tick()
  assert.deepEqual(h.calls, previous)
})

test('password checkpoint and result confirmation are both required before entering the pool', async (t) => {
  for (const missing of ['checkpoint', 'result', 'mfa']) {
    const h = harness(t, {
      runSlot: async ({ action, onCheckpoint }) => {
        if (action !== 'register') return {}
        onCheckpoint({ email, phase: 'submitted' })
        onCheckpoint({ email, phase: 'account_created' })
        if (missing !== 'checkpoint') {
          onCheckpoint({ email, phase: 'password_submitted' })
          onCheckpoint({ email, phase: 'password_set', password_verified: true })
          onCheckpoint({ email, phase: 'totp_pending', totp_secret: secret })
        }
        return { email, password_verified: missing !== 'result', totp_secret: secret, totp_verified: missing !== 'mfa' }
      },
    })
    h.service.register('vm-01', email, owner)
    await h.service.settle()
    assert.equal(
      h.service.status('vm-01').state.error_code,
      missing === 'mfa' ? 'registration_mfa_unconfirmed' : 'registration_password_unconfirmed',
    )
    assert.equal(h.store.pool.list(owner).length, 0)
    assert.equal(h.service.status('vm-01').configured, false)
  }
})

test('MFA checkpoints cannot skip password confirmation, including legacy drafts', async (t) => {
  const h = harness(t, {
    runSlot: async ({ action, onCheckpoint }) => {
      if (action !== 'register') return {}
      onCheckpoint({ email, phase: 'submitted' })
      onCheckpoint({ email, phase: 'account_created' })
      onCheckpoint({ email, phase: 'totp_pending', totp_secret: secret })
    },
  })
  h.service.register('vm-01', email, owner)
  await h.service.settle()
  assert.equal(h.service.status('vm-01').state.error_code, 'registration_checkpoint_failed')
  assert.equal(h.store.pool.list(owner).length, 0)
  h.registrations.save('vm-01', { ...h.registrations.read('vm-01'), phase: 'mfa_verified', totp_secret: secret })
  assert.equal(h.registrations.summary('vm-01').mfa_verified, false)
  h.service.register('vm-01', email, owner)
  await h.service.settle()
  assert.equal(h.service.status('vm-01').state.error_code, 'registration_password_unconfirmed')
  assert.equal(h.store.pool.list(owner).length, 0)
})

test('registration shares all job locks; email verification works before a credential binding exists; resting aborts it', async (t) => {
  let ready,
    messages = [],
    setStage
  const started = new Promise((resolve) => {
    ready = resolve
  })
  const h = harness(t, {
    runSlot: async ({ action, onControl, onStage, signal }) => {
      if (action !== 'register') return {}
      onControl((value) => messages.push(value))
      setStage = onStage
      onStage('registration_email_code')
      ready()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(mailboxError('login_cancelled')), { once: true }),
      )
    },
  })
  h.service.register('vm-01', email, owner)
  await started
  assert.throws(() => h.service.register('vm-01', email, owner), /mailbox_login_busy/)
  assert.throws(() => h.service.start('vm-01'), /mailbox_login_busy/)
  assert.throws(() => h.service.runtime('vm-01', 'uninstall'), /mailbox_login_busy/)
  assert.throws(() => h.service.verificationCode('vm-01', 'invalid!'), /invalid_verification_code/)
  h.service.verificationCode('vm-01', '123456')
  assert.deepEqual(messages, [{ verification_code: '123456' }])
  for (const stage of ['registration_password_email_code', 'registration_mfa_email_code']) {
    setStage(stage)
    h.service.verificationCode('vm-01', '234567')
    assert.deepEqual(messages.at(-1), { verification_code: '234567' })
  }
  assert.throws(
    () => h.service.control('vm-01', { op: 'frame', registration_checkpoint_saved: true }),
    /invalid_browser_operation/,
  )
  assert.equal(h.service.remote('vm-01').browser.remote, false)
  h.vm.schedulable = false
  h.service.guardJobs()
  await h.service.settle()
  assert.equal(h.service.status('vm-01').state.status, 'cancelled')
  assert.equal(h.store.pool.list(owner).length, 0)
})

test('resting manual registration supports codes and remote control, and later disabling scheduling cancels it', async (t) => {
  let started, emit, finishEvent
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const messages = []
  const h = harness(t, {
    runSlot: async ({ action, onControl, onStage, onEvent, signal }) => {
      if (action !== 'register') return {}
      emit = onEvent
      onControl((message) => {
        messages.push(message)
        finishEvent?.(message)
      })
      onStage('registration_email_code')
      started()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(mailboxError('login_cancelled')), { once: true }),
      )
    },
  })
  h.vm.schedulable = false
  h.service.register('vm-01', email, owner)
  await ready
  h.service.guardJobs()
  h.service.verificationCode('vm-01', '123456')
  assert.deepEqual(messages.at(-1), { verification_code: '123456' })
  assert.equal(h.service.remote('vm-01').browser.active, true)
  finishEvent = (message) => emit({ id: message.id, ok: true, data: { frame: 'fixture' } })
  assert.deepEqual(await h.service.control('vm-01', { op: 'frame' }), { frame: 'fixture' })
  assert.equal(h.vm.schedulable, false)
  h.vm.schedulable = true
  h.service.guardJobs()
  h.vm.schedulable = false
  h.service.guardJobs()
  await h.service.settle()
  assert.equal(h.service.status('vm-01').state.status, 'cancelled')
  assert.equal(h.store.pool.list(owner).length, 0)
})

test('registered insertion is idempotent after persistence failure, and never overwrites different credentials', (t) => {
  const h = harness(t),
    record = { email, password: 'fixture-Aa9!-password', totp_secret: secret }
  const a = h.store.pool.createRegistered(record, owner)
  assert.equal(h.store.pool.createRegistered(record, owner).id, a.id)
  assert.throws(
    () => h.store.pool.createRegistered({ ...record, password: 'different' }, owner),
    /registration_email_exists/,
  )
  assert.equal(h.store.pool.read(a.id, owner).password, record.password)
})
