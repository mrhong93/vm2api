import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { qualityConfigStore, qualityOwners, qualityTaskRevision } from './quality-config-store.mjs'
import { judgeCandy, qualityAnswer } from './quality-judge.mjs'
import { filterVmsForPanel } from './resource-owner.mjs'
import { listVms, setScheduleOff } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { summarizeCodexSlot } from '../vm/codex-slot.mjs'
import { listTestableModels } from './vm-test-chat.mjs'
import { runQualityStateProbe } from './quality-probe.mjs'

const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status })
}
const message = {
  no_credential: '槽位缺少可用授权',
  oauth_expired: '账号授权已失效',
  oauth_unauthorized: '账号授权被拒绝',
  model_not_allowed: '槽位不支持该模型',
  model_disabled: '模型已禁用',
  aborted: '检测超时',
}
const fingerprint = (vm, account) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        id: vm.id,
        owner: vm.owner_user_id,
        account,
        proxy: vm.proxy,
        runtime: vm.runtime?.container,
        uuid: vm.claude?.account_uuid || vm.codex?.chatgpt_account_id,
      }),
    )
    .digest('hex')

export function qualityRecordStore(projectRoot, owner) {
  const folder = path.join(projectRoot, 'data/quality-records')
  const file = path.join(folder, crypto.createHash('sha256').update(owner).digest('hex') + '.json')
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  return {
    read,
    put(record) {
      const records = [record, ...read().filter((item) => item.id !== record.id)]
        .sort((a, b) => b.time.localeCompare(a.time))
        .slice(0, 200)
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
      const temp = file + '.' + crypto.randomUUID() + '.tmp'
      try {
        fs.writeFileSync(temp, JSON.stringify(records), { mode: 0o600, flag: 'wx' })
        fs.renameSync(temp, file)
      } finally {
        fs.rmSync(temp, { force: true })
      }
    },
  }
}

export class QualityRunner {
  constructor({
    projectRoot,
    runChat,
    resolveOwner,
    list = () => listVms(projectRoot),
    models = listTestableModels,
    probe = runQualityStateProbe,
    now = Date.now,
    accountOf = (vm) =>
      isCodexVm(vm) ? summarizeCodexSlot(projectRoot, vm).email || '' : vm.claude?.email || vm.email || '',
    pause = (id) => setScheduleOff(projectRoot, id, true, { reason: 'quality_check_failed', preserveStatus: true }),
  }) {
    Object.assign(this, { projectRoot, runChat, resolveOwner, list, models, probe, now, accountOf, pause })
    this.running = new Map()
    this.accountLocks = new Set()
    this.due = new Map()
    this.stopped = false
  }

  actor(owner) {
    const actor = this.resolveOwner(owner)
    if (!actor || actor.enabled === false || !['admin', 'user'].includes(actor.role)) fail('无权执行此检测任务', 403)
    return actor
  }

  target(owner, task) {
    const actor = this.actor(owner)
    const vm = filterVmsForPanel(this.list(), { role: actor.role, userId: owner }).find((vm) => vm.id === task.slot)
    if (!vm) fail('任务槽位不存在或已无访问权限', 404)
    if (!this.models(isCodexVm(vm) ? 'openai' : 'anthropic').some((item) => item.id === task.model))
      fail('任务模型已不受支持', 400)
    if (task.kind === 'probe' && !isCodexVm(vm)) fail('门票探针仅支持 GPT OAuth 槽位', 400)
    const account = this.accountOf(vm)
    if (!account || account.toLowerCase() !== task.account.toLowerCase())
      fail('槽位当前账号与任务不一致，请重新选择账号与槽位')
    return { vm, account, fingerprint: fingerprint(vm, account) }
  }

  records(owner) {
    this.actor(owner)
    return qualityRecordStore(this.projectRoot, owner).read()
  }

  run(owner, id, source = 'manual') {
    if (this.stopped) fail('检测服务正在停止', 503)
    const task = qualityConfigStore(this.projectRoot, owner)
      .read()
      .tasks.find((task) => task.id === id)
    if (!task) fail('检测任务不存在', 404)
    if (source === 'scheduled' && !task.enabled) fail('任务已暂停')
    const target = this.target(owner, task)
    const key = owner + ':' + id
    const accountKey = target.account.toLowerCase()
    if (this.running.has(key) || this.accountLocks.has(accountKey)) fail('该账号已有检测正在执行，请稍后再试')
    if (this.running.size >= 4) fail('检测并发已满，请稍后重试', 429)
    const record = {
      id: crypto.randomUUID(),
      taskId: id,
      taskName: task.name,
      account: target.account,
      slot: task.slot,
      model: task.model,
      prompt: task.prompt,
      kind: task.kind,
      judge: task.judge,
      reasoningEffort: isCodexVm(target.vm) && task.kind === 'candy' ? task.reasoningEffort || 'medium' : null,
      taskRevision: qualityTaskRevision(task),
      time: new Date(this.now()).toISOString(),
      source,
      result: 'running',
      output: '',
      latency: '—',
      action: '等待检测完成',
      durationMs: null,
    }
    const entry = { record, controller: new AbortController() }
    qualityRecordStore(this.projectRoot, owner).put(record)
    this.due.set(key, { revision: record.taskRevision, time: this.now() + task.interval * 60000 })
    this.running.set(key, entry)
    this.accountLocks.add(accountKey)
    entry.promise = Promise.resolve()
      .then(() => this.execute(owner, task, target, entry))
      .finally(() => {
        this.running.delete(key)
        this.accountLocks.delete(accountKey)
      })
    // No detached rejection may leave an unhandled exception or a stuck lock.
    entry.promise.catch(() => {})
    return record
  }

  async execute(owner, task, target, entry) {
    const started = this.now()
    const record = { ...entry.record }
    try {
      if (!['running', 'ok', 'paused'].includes(target.vm.status) || target.vm.runtime?.stopped) {
        record.result = 'skipped'
        record.output = '槽位未开机，未发出检测请求'
      } else if (record.source === 'scheduled' && target.vm.schedulable === false) {
        record.result = 'skipped'
        record.output = '槽位调度已关闭，定时检测保持静置'
      } else if (task.kind === 'probe') {
        const result = await this.probe({
          projectRoot: this.projectRoot,
          vm: target.vm,
          model: task.model,
          signal: entry.controller.signal,
        })
        record.result = result.verdict === 'healthy' ? 'passed' : result.verdict === 'degraded' ? 'failed' : 'error'
        record.output = result.reason + (result.text ? '\n\n完整回复：\n' + result.text : '')
        record.probe = Object.fromEntries(
          [
            'verdict',
            'failure',
            'mint_status',
            'continue_status',
            'ticket_length',
            'continue_ticket_length',
            'minted',
            'new_ticket',
            'reported_model',
          ]
            .filter((key) => result[key] != null)
            .map((key) => [key, result[key]]),
        )
        record.usage = result.usage || null
      } else {
        const result = await this.runChat(task.slot, {
          model: task.model,
          prompt: task.prompt,
          preservePrompt: true,
          reasoning_effort: record.reasoningEffort,
          max_tokens: 16384,
          timeoutMs: 180000,
        })
        const fullAnswer = qualityAnswer(result)
        const complete = result?.ok && result.complete === true
        const hit = result?.debug?.hit_vm || result?.vm_id
        if (!complete || !fullAnswer.trim() || (hit && hit !== task.slot)) {
          record.result = 'error'
          record.output =
            fullAnswer || message[result?.error?.code] || '请求未完整返回有效文本，无法判断；请查看槽位请求日志'
        } else {
          record.result = judgeCandy(fullAnswer, task.judge) ? 'passed' : 'failed'
          record.output = fullAnswer
        }
        record.usage = result?.usage || null
      }
      record.action = record.result === 'passed' ? '保持现状' : record.result === 'skipped' ? '未发出请求' : '仅记录'
      if (record.result === 'failed' && task.action === 'pause') {
        try {
          // Recheck ownership, exact task, account and exit after the asynchronous
          // request. A deleted/edited/disabled task cannot pause a replacement.
          const current = qualityConfigStore(this.projectRoot, owner)
            .read()
            .tasks.find((item) => item.id === task.id)
          if (
            this.stopped ||
            !task.enabled ||
            !current?.enabled ||
            qualityTaskRevision(current) !== record.taskRevision
          ) {
            record.action = '任务已暂停或修改，未关闭调度'
          } else {
            const latest = this.target(owner, current)
            if (latest.fingerprint !== target.fingerprint) record.action = '账号或出口已变更，未关闭调度'
            else {
              await this.pause(task.slot)
              record.action = '已关闭槽位调度'
            }
          }
        } catch {
          record.action = '权限、目标或调度操作异常，未关闭调度；请检查槽位'
        }
      }
    } catch (error) {
      record.result = 'error'
      record.action = '未修改槽位调度'
      record.output = error.status ? error.message : '检测执行失败，未取得有效结果；请查看服务器日志'
    }
    if (this.stopped) return
    record.durationMs = Math.max(0, this.now() - started)
    record.latency = (record.durationMs / 1000).toFixed(2) + ' s'
    record.finishedAt = new Date(this.now()).toISOString()
    if (record.output.length > 262144) {
      record.output = record.output.slice(0, 262144)
      record.outputTruncated = true
    }
    qualityRecordStore(this.projectRoot, owner).put(record)
  }

  tick() {
    if (this.stopped) return
    const active = new Set()
    for (const owner of qualityOwners(this.projectRoot)) {
      try {
        this.actor(owner)
        const records = qualityRecordStore(this.projectRoot, owner).read()
        for (const task of qualityConfigStore(this.projectRoot, owner)
          .read()
          .tasks.filter((task) => task.enabled)) {
          const revision = qualityTaskRevision(task)
          const key = owner + ':' + task.id
          active.add(key)
          if (this.due.get(key)?.revision !== revision) {
            const previous = records.find((record) => record.taskId === task.id && record.taskRevision === revision)
            this.due.set(key, {
              revision,
              time:
                Math.max(Date.parse(task.activatedAt) || this.now(), previous ? Date.parse(previous.time) : 0) +
                task.interval * 60000,
            })
          }
          if (this.due.get(key).time > this.now()) continue
          // Busy accounts retry on the next tick, without overlapping requests.
          if (this.running.has(key) || this.accountLocks.has(task.account.toLowerCase()) || this.running.size >= 4)
            continue
          try {
            this.run(owner, task.id, 'scheduled')
          } catch (error) {
            this.due.set(key, { revision, time: this.now() + task.interval * 60000 })
            qualityRecordStore(this.projectRoot, owner).put({
              id: crypto.randomUUID(),
              taskId: task.id,
              taskName: task.name,
              account: task.account,
              slot: task.slot,
              model: task.model,
              prompt: task.prompt,
              kind: task.kind,
              judge: task.judge,
              taskRevision: revision,
              time: new Date(this.now()).toISOString(),
              source: 'scheduled',
              result: 'error',
              output: error.status ? error.message : '检测目标校验失败，未发出请求',
              latency: '—',
              action: '未发出请求，未修改槽位调度',
              durationMs: 0,
            })
          }
        }
      } catch {
        /* Disabled owners or unreadable configs must not dispatch. */
      }
    }
    for (const key of this.due.keys()) if (!active.has(key)) this.due.delete(key)
  }

  start() {
    if (this.timer) return
    this.stopped = false
    for (const owner of qualityOwners(this.projectRoot)) {
      try {
        const store = qualityRecordStore(this.projectRoot, owner)
        for (const record of store.read().filter((record) => record.result === 'running'))
          store.put({
            ...record,
            result: 'error',
            output: '服务重启，先前检测已中断，请重新执行',
            action: '未修改槽位调度',
          })
      } catch {
        /* A bad record file is isolated to its owner. */
      }
    }
    this.timer = setInterval(() => this.tick(), 5000)
    this.timer.unref?.()
    this.tick()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
    this.stopped = true
    for (const entry of this.running.values()) entry.controller.abort()
  }
}
