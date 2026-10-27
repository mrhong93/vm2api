import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRestoreRuntime } from '../../src/lib/admin/restore-runtime.mjs'

test('restore requires stopped slots, no streams/sockets and no active background writers', async () => {
  let slots = [{ status: 'running', schedulable: false }],
    busy = false,
    paused = 0,
    resumed = 0
  const runtime = createRestoreRuntime({
    slots: () => slots,
    busy: () => busy,
    pause: async () => {
      paused++
    },
    resume: async () => {
      resumed++
    },
  })
  await assert.rejects(runtime.before(), { code: 'restore_slots_running' })
  assert.equal(paused, 0)
  slots = [{ status: 'stopped' }]
  busy = true
  await assert.rejects(runtime.before(), { code: 'restore_in_progress' })
  busy = false
  const res = new EventEmitter()
  const done = runtime.trackHttp({ method: 'POST', url: '/v1/messages' }, res)
  done() // the handler can return while SSE is still streaming
  await assert.rejects(runtime.before(), { code: 'restore_in_progress' })
  res.emit('close')
  const socket = new EventEmitter()
  runtime.trackSocket(socket)
  await assert.rejects(runtime.before(), { code: 'restore_in_progress' })
  socket.emit('close')
  await runtime.before()
  await runtime.after()
  assert.equal(paused, 1)
  assert.equal(resumed, 1)
})

test('HTTP response closing early still waits for the handler to finish; backup polling is exempt', async () => {
  const runtime = createRestoreRuntime({ pause: async () => {}, resume: async () => {} })
  const res = new EventEmitter()
  const done = runtime.trackHttp({ method: 'PUT', url: '/api/panel/routing' }, res)
  res.emit('close')
  await assert.rejects(runtime.before(), { code: 'restore_in_progress' })
  done()
  runtime.trackHttp({ method: 'POST', url: '/api/panel/backups/remote/restore' }, new EventEmitter())
  runtime.trackHttp({ method: 'GET', url: '/api/panel/backups' }, new EventEmitter())
  await runtime.before()
  await runtime.after()
})

test('partial pause failures resume; failed resume stays paused until successfully resumed', async () => {
  let failResume = true,
    resumes = 0
  const runtime = createRestoreRuntime({
    pause: async () => {
      throw new Error('partial pause failure')
    },
    resume: async () => {
      resumes++
      if (failResume) throw new Error('resume failed')
    },
  })
  await assert.rejects(runtime.before(), /partial pause/)
  await assert.rejects(runtime.after(), /resume failed/)
  failResume = false
  await runtime.after()
  await runtime.after()
  assert.equal(resumes, 2)
})
