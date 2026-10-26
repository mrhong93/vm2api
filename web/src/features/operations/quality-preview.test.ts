import { describe, expect, it } from 'vitest'
import { judgeCandy } from './quality-preview'

describe('candy preview judging without a model', () => {
  it('accepts a single final answer with supported formatting', () => {
    for (const output of [
      '21',
      '**21**',
      '２１',
      '答案是 21 颗糖果。',
      '最少需要21颗糖果',
      '二十一颗糖果',
      'The answer is 21.',
    ]) {
      expect(judgeCandy(output, 'answer'), output).toBe(true)
    }
  })
  it('rejects other numbers, split numbers and contradictory answers', () => {
    for (const output of [
      '',
      '121',
      '210',
      '21.5',
      '-21',
      '2 1',
      '不是21，答案是20',
      '21或22',
      '先考虑21种情况，答案是22',
    ]) {
      expect(judgeCandy(output, 'answer'), output).toBe(false)
    }
  })
  it('accepts the full explanatory answer without a judge model', () => {
    expect(
      judgeCandy(
        '最少取出 21 个（利用手感区分形状，取 12 个五角星形、9 个圆形）。\n因此，20 个无法保证，答案是 **21** 个。\n若不允许按手感选择形状，则需要 29 个。',
        'contains'
      )
    ).toBe(true)
  })
  it('makes the relaxed numeric-token mode explicit', () => {
    for (const output of ['21', '21.', '答案是21颗糖果', '不是 21，答案是 20'])
      expect(judgeCandy(output, 'contains'), output).toBe(true)
    for (const output of [
      '121',
      '210',
      '21.5',
      '21,000',
      '1.21',
      'a21b',
      '-21',
    ])
      expect(judgeCandy(output, 'contains'), output).toBe(false)
  })
})
