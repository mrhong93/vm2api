export const CANDY_PROMPT = `在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）
苹果味 桃子味 西瓜味
圆形 7 9 8
五角星形 7 6 4`

export type CheckKind = 'candy' | 'probe'
export type JudgeMode = 'answer' | 'contains'
export type QualityTask = {
  id: string
  name: string
  account: string
  slot: string
  model: string
  prompt: string
  kind: CheckKind
  judge: JudgeMode
  interval: number
  enabled: boolean
  action: 'record' | 'pause'
}
export type QualityRecord = {
  id: string
  taskId: string
  taskName: string
  account: string
  slot: string
  model: string
  prompt: string
  kind: CheckKind
  judge: JudgeMode
  time: string
  result: 'passed' | 'failed' | 'error'
  output: string
  latency: string
  action: string
}

// These are deliberately fictional UI fixtures. No scheduler or provider API
// is connected to the preview workspace.
export const initialTasks: QualityTask[] = [
  {
    id: 'demo-01',
    name: 'GPT 推理质量巡检',
    account: 'gpt-primary@example.com',
    slot: '示例槽位 01',
    model: 'gpt-6.1-sol',
    prompt: CANDY_PROMPT,
    kind: 'candy',
    judge: 'answer',
    interval: 30,
    enabled: true,
    action: 'record',
  },
  {
    id: 'demo-02',
    name: 'Claude 可用性探针',
    account: 'claude-team@example.com',
    slot: '示例槽位 02',
    model: 'claude-sonnet-4-5',
    prompt: CANDY_PROMPT,
    kind: 'probe',
    judge: 'answer',
    interval: 10,
    enabled: true,
    action: 'pause',
  },
  {
    id: 'demo-03',
    name: '备用账号质量检测',
    account: 'gpt-backup@example.com',
    slot: '示例槽位 03',
    model: 'gpt-6-astra',
    prompt: CANDY_PROMPT,
    kind: 'candy',
    judge: 'contains',
    interval: 60,
    enabled: true,
    action: 'pause',
  },
  {
    id: 'demo-04',
    name: '低频连通性检查',
    account: 'gpt-night@example.com',
    slot: '示例槽位 04',
    model: 'gpt-6.1-sol',
    prompt: CANDY_PROMPT,
    kind: 'probe',
    judge: 'answer',
    interval: 120,
    enabled: false,
    action: 'record',
  },
]

export function seedRecords(): QualityRecord[] {
  return Array.from({ length: 14 }, (_, index) => {
    const task = initialTasks[index % 4]
    const result =
      index === 2 || index === 6 ? 'failed' : index === 5 ? 'error' : 'passed'
    return {
      id: `preview-record-${index + 1}`,
      taskId: task.id,
      taskName: task.name,
      account: task.account,
      slot: task.slot,
      model: task.model,
      prompt: task.prompt,
      kind: task.kind,
      judge: task.judge,
      time: new Date(
        Date.UTC(2026, 9, 26, 14, 0) - index * 300_000
      ).toISOString(),
      result,
      output:
        result === 'error'
          ? '请求超时：未收到响应（示例）'
          : result === 'failed'
            ? '最少需要 20 颗糖果。'
            : task.kind === 'candy'
              ? '21'
              : 'OK',
      latency:
        result === 'error'
          ? '30.00 s'
          : `${(1.24 + (index % 5) * 0.43).toFixed(2)} s`,
      action:
        result === 'passed'
          ? '保持现状'
          : task.action === 'pause'
            ? '拟关闭调度'
            : '仅记录异常',
    }
  })
}

export function judgeCandy(output: string, mode: JudgeMode): boolean {
  const normalized = output.normalize('NFKC').trim()
  if (mode === 'contains')
    return /(^|[^A-Za-z0-9_.+-])21(?![A-Za-z0-9_]|[.,][0-9])/u.test(normalized)
  if (/[0-9][\s*_]+[0-9]/u.test(normalized)) return false
  const answer = normalized.replace(/[\s*_`"'“”]/gu, '').toLowerCase()
  return /^(?:(?:最终)?(?:答案|结果)(?:为|是)?[:：]?|(?:最少|至少)(?:需要)?(?:取出|抽取|摸出)?|(?:需要|取出|抽取|摸出))?(?:21|二十一)(?:个|颗|粒)?(?:糖果|糖)?(?:即可)?[。.!！]?$|^(?:(?:the)?answer(?:is|:)?|atleast)?21(?:candies)?[.!]?$/.test(
    answer
  )
}

export function formatRecordTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}
export function formatRecordDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}
