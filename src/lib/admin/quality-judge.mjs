// Same two deterministic rules as the original configuration preview. No judge model.
export function judgeCandy(output, mode) {
  const normalized = String(output).normalize('NFKC').trim()
  if (mode === 'contains') return /(^|[^A-Za-z0-9_.+-])21(?![A-Za-z0-9_]|[.,][0-9])/u.test(normalized)
  if (/[0-9][\s*_]+[0-9]/u.test(normalized)) return false
  const answer = normalized.replace(/[\s*_`"'“”]/gu, '').toLowerCase()
  return /^(?:(?:最终)?(?:答案|结果)(?:为|是)?[:：]?|(?:最少|至少)(?:需要)?(?:取出|抽取|摸出)?|(?:需要|取出|抽取|摸出))?(?:21|二十一)(?:个|颗|粒)?(?:糖果|糖)?(?:即可)?[。.!！]?$|^(?:(?:the)?answer(?:is|:)?|atleast)?21(?:candies)?[.!]?$/.test(
    answer,
  )
}

export function qualityAnswer(result) {
  const body = result?.body
  if (typeof body?.output_text === 'string') return body.output_text
  const blocks = body?.output?.flatMap((item) => item.content || []) || body?.content || []
  const text = blocks
    .filter((item) => ['text', 'output_text'].includes(item.type))
    .map((item) => item.text || '')
    .join('')
  return text || result?.text || ''
}
