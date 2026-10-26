/** Called only after panel authentication, role checks and VM ownership checks. */
import { codexMailboxService } from '../oauth/codex-mailbox-service.mjs'
import { listVms } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { filterVmsForPanel } from './resource-owner.mjs'
import { panelIdentity } from './panel-acl.mjs'

export async function handleLoginCredentials(req, res, pathname, { projectRoot, readBody, json, ok }) {
  const pool = pathname.match(/^\/api\/panel\/login-credentials(?:\/(import|cred-[a-f0-9-]{36})(?:\/(reveal))?)?$/)
  const login = pathname.match(
    /^\/api\/panel\/vms\/([^/]+)\/oauth\/(?:login|microsoft-mailbox)(?:\/(start|cancel|verify|remote|control|bind))?$/,
  )
  if (!pool && !login) return false
  res.setHeader('Cache-Control', 'no-store')
  const role = panelIdentity(req).role
  const owner = { id: req.panelUserId || 'master', admin: role === 'admin' }
  const service = codexMailboxService(projectRoot)
  try {
    if (role !== 'admin' && !req.panelUserId) {
      throw Object.assign(new Error('credential_owner_required'), { code: 'credential_owner_required', status: 403 })
    }
    if (pool) {
      const action = pool[1] || ''
      if (req.method === 'GET' && !action) {
        const visible = filterVmsForPanel(listVms(projectRoot), { role, userId: req.panelUserId })
        json(
          res,
          200,
          ok({
            credentials: service.poolList(
              owner,
              visible.map((vm) => vm.id),
            ),
          }),
        )
        return true
      }
      if (req.method === 'POST' && action === 'import' && !pool[2]) {
        const body = await readBody(req, 600_000)
        json(res, 200, ok(service.poolImport(body.text, owner)))
        return true
      }
      if (req.method === 'POST' && action.startsWith('cred-') && pool[2] === 'reveal') {
        json(res, 200, ok(service.poolReveal(action, owner)))
        return true
      }
      if (req.method === 'DELETE' && action.startsWith('cred-') && !pool[2]) {
        service.poolRemove(action, owner)
        json(res, 200, ok({ removed: true }))
        return true
      }
    } else {
      const [, id, action = ''] = login
      if (!isValidVmId(id)) throw Object.assign(new Error('invalid_vm_id'), { code: 'invalid_vm_id', status: 400 })
      if (req.method === 'GET' && !action) {
        json(res, 200, ok(service.status(id)))
        return true
      }
      if (req.method === 'POST') {
        if (!action) {
          const body = await readBody(req, 8192)
          json(res, 200, ok(service.save(id, body)))
          return true
        }
        if (action === 'bind') {
          const body = await readBody(req, 1024)
          json(res, 200, ok(service.bind(id, body.credential_id, owner)))
          return true
        }
        if (action === 'start') {
          const body = await readBody(req, 1024)
          json(res, 202, ok(service.start(id, { activateEmpty: body.activate_empty === true })))
          return true
        }
        if (action === 'cancel' || action === 'remote') {
          json(res, action === 'remote' ? 202 : 200, ok(service[action](id)))
          return true
        }
        if (action === 'verify') {
          const body = await readBody(req, 1024)
          json(res, 200, ok(service.verificationCode(id, body.code)))
          return true
        }
        if (action === 'control') {
          const body = await readBody(req, 16_384)
          if (body.op === 'session')
            throw Object.assign(new Error('invalid_browser_operation'), { code: 'invalid_browser_operation' })
          json(res, 200, ok(await service.control(id, body)))
          return true
        }
      }
      if (req.method === 'DELETE' && !action) {
        service.remove(id)
        json(res, 200, ok({ removed: true }))
        return true
      }
    }
    json(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'method_not_allowed' } })
  } catch (error) {
    const code = /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'login_credential_operation_failed'
    const status = Number(error.status)
    json(res, status >= 400 && status <= 599 ? status : 400, { ok: false, error: { code, message: code } })
  }
  return true
}
