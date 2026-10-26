import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
export function validateQualityTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > 200) fail('任务数量不得超过 200')
  const ids = new Set()
  return tasks.map((t) => {
    if (!t || typeof t !== 'object') fail('任务格式错误')
    const out = {}
    for (const [key, max] of Object.entries({
      id: 100,
      name: 160,
      account: 320,
      slot: 100,
      model: 160,
      prompt: 10000,
    })) {
      if (typeof t[key] !== 'string' || !t[key].trim() || t[key].length > max) fail(`任务字段无效：${key}`)
      out[key] = t[key]
    }
    if (ids.has(t.id)) fail('任务 ID 重复')
    ids.add(t.id)
    if (!Number.isSafeInteger(t.interval) || t.interval < 1 || t.interval > 525600)
      fail('检测频率须为 1–525600 的整数分钟')
    if (
      !['candy', 'probe'].includes(t.kind) ||
      !['answer', 'contains'].includes(t.judge) ||
      !['record', 'pause'].includes(t.action) ||
      typeof t.enabled !== 'boolean'
    )
      fail('任务选项无效')
    return { ...out, interval: t.interval, kind: t.kind, judge: t.judge, action: t.action, enabled: t.enabled }
  })
}

// Configuration only. This store never starts a scheduler or calls a model.
export function qualityConfigStore(projectRoot, owner) {
  if (!owner) fail('缺少配置所属用户', 403)
  const dir = path.join(projectRoot, 'data', 'quality-preview')
  const file = path.join(dir, crypto.createHash('sha256').update(owner).digest('hex') + '.json')
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      if (e.code === 'ENOENT') return { revision: 0, tasks: [] }
      throw e
    }
  }
  return {
    read,
    save(tasks, revision) {
      const clean = validateQualityTasks(tasks)
      const current = read()
      if (revision !== current.revision) fail('配置已被其他页面修改，请刷新后重试', 409)
      const next = { revision: current.revision + 1, tasks: clean }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${crypto.randomUUID()}.tmp`
      try {
        fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
        fs.renameSync(tmp, file)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
      return next
    },
  }
}
