import { qualityConfigStore, validateQualityTasks } from './quality-config-store.mjs'
import { panelIdentity } from './panel-acl.mjs'
import { filterVmsForPanel } from './resource-owner.mjs'
import { listVms } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { listTestableModels } from './vm-test-chat.mjs'

// Mounted after panel authentication and route ACL checks.
export async function handleQualityConfig(req, res, pathname, { projectRoot, readBody, json, ok, runner }) {
  const runPath = pathname.match(/^\/api\/panel\/quality-preview\/([^/]+)\/run$/)
  const recordPath = pathname === '/api/panel/quality-preview/records'
  if (pathname !== '/api/panel/quality-preview' && !runPath && !recordPath) return false
  res.setHeader('Cache-Control', 'no-store')
  try {
    const { role } = panelIdentity(req)
    const owner = req.panelUserId || (role === 'admin' ? 'master' : '')
    const store = qualityConfigStore(projectRoot, owner)
    if (recordPath && req.method === 'GET') {
      if (!runner) throw Object.assign(new Error('真实检测服务未启动'), { status: 503 })
      json(res, 200, ok({ items: runner.records(owner) }))
    } else if (runPath && req.method === 'POST') {
      if (!runner) throw Object.assign(new Error('真实检测服务未启动'), { status: 503 })
      const body = await readBody(req, 4096)
      if (body.revision !== store.read().revision)
        throw Object.assign(new Error('任务配置已更新，请刷新后重试'), { status: 409 })
      json(res, 202, ok({ record: runner.run(owner, decodeURIComponent(runPath[1])) }))
    } else if (recordPath || runPath) json(res, 405, { ok: false, error: { message: 'method_not_allowed' } })
    else if (req.method === 'GET')
      json(res, 200, ok({ ...store.read(), runtime: { manual: !!runner, scheduled: !!runner, probe: !!runner } }))
    else if (req.method === 'PUT') {
      const body = await readBody(req, 3_000_000)
      const tasks = validateQualityTasks(body.tasks)
      const old = store.read()
      const visible = filterVmsForPanel(listVms(projectRoot), { role, userId: req.panelUserId })
      for (const task of tasks) {
        // Allow pausing/deleting stale tasks; validate newly selected targets.
        const previous = old.tasks.find((t) => t.id === task.id)
        if (
          !task.enabled &&
          previous?.slot === task.slot &&
          previous?.model === task.model &&
          previous?.account === task.account &&
          previous?.kind === task.kind
        )
          continue
        const vm = visible.find((v) => v.id === task.slot)
        if (!vm || !listTestableModels(isCodexVm(vm) ? 'openai' : 'anthropic').some((m) => m.id === task.model)) {
          throw Object.assign(new Error('请选择可访问的槽位及受支持模型'), { status: 400 })
        }
        if (task.kind === 'probe' && !isCodexVm(vm))
          throw Object.assign(new Error('门票探针仅支持 GPT OAuth 槽位'), { status: 400 })
      }
      json(
        res,
        200,
        ok({
          ...store.save(tasks, body.revision),
          runtime: { manual: !!runner, scheduled: !!runner, probe: !!runner },
        }),
      )
    } else json(res, 405, { ok: false, error: { message: 'method_not_allowed' } })
  } catch (e) {
    json(res, e.status || 500, { ok: false, error: { message: e.status ? e.message : '质量配置读写失败，请稍后重试' } })
  }
  return true
}
