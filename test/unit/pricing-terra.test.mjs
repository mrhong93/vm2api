import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'
import { setPriceCatalogTestHooks } from '../../src/lib/admin/price-catalog.mjs'

test.before(() => {
  setPriceCatalogTestHooks({ settings: { get: (_key, fallback) => fallback }, backgroundRefresh: false })
})
test.after(() => setPriceCatalogTestHooks(null))

test('Terra bills uncached input, cached input, default cache writes and output independently', () => {
  const cost = calculateCost(
    {
      input_tokens: 250_000,
      output_tokens: 100_000,
      input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 50_000 },
    },
    'gpt-6.1-terra',
  )
  assert.equal(cost.known, true)
  assert.equal(cost.pricing_key, 'gpt-6.1-terra')
  assert.equal(cost.long_context, false)
  assert.equal(cost.input_cost, 0.1)
  assert.equal(cost.cache_read_cost, 0.005)
  assert.equal(cost.cache_creation_cost, 0.0625)
  assert.equal(cost.output_cost, 0.5)
  assert.equal(cost.total_cost, 0.6675)
})

test('Terra respects the strict 272K boundary and all supported service tiers', () => {
  for (const [service_tier, multiplier] of [
    ['default', 1],
    ['flex', 0.5],
    ['priority', 2],
    ['fast', 2],
  ]) {
    const at = calculateCost({ input_tokens: 272_000, output_tokens: 100_000, service_tier }, 'gpt-6.1-terra')
    assert.equal(at.known, true)
    assert.equal(at.long_context, false)
    assert.equal(at.total_cost, 0.772 * multiplier)
    const above = calculateCost({ input_tokens: 272_001, output_tokens: 100_000, service_tier }, 'gpt-6.1-terra')
    assert.equal(above.long_context, true)
    assert.equal(above.total_cost, 1.294002 * multiplier)
    const cached = calculateCost(
      {
        input_tokens: 300_000,
        output_tokens: 100_000,
        input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 50_000 },
        service_tier,
      },
      'gpt-6.1-terra',
    )
    assert.equal(cached.long_context, true)
    assert.equal(cached.total_cost, 1.185 * multiplier)
  }
  assert.equal(calculateCost({ input_tokens: 100, service_tier: 'unknown' }, 'gpt-6.1-terra').known, false)
})
