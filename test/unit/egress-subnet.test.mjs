import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateEgressSubnet, assertEgressSubnet } from '../../src/lib/vm/egress-subnet.mjs'
import { ensureEgressNetwork, ensureLocalProxyEgress } from '../../src/lib/vm/egress.mjs'

test('configured reservations reject subnet and supernet overlaps', () => {
  const old = process.env.KIN_EGRESS_RESERVED_CIDRS
  process.env.KIN_EGRESS_RESERVED_CIDRS = '10.42.16.0/20,10.42.48.0/24'
  try {
    for (const subnet of ['10.42.16.0/24', '10.42.31.0/24', '10.42.0.0/16', '10.42.48.0/20']) {
      assert.throws(() => assertEgressSubnet(subnet), { code: 'egress_subnet_reserved' })
      const run = () => ({ ok: true, stdout: `${subnet}|10.42.16.1` })
      assert.equal(ensureEgressNetwork('px-test', run).ok, false)
      assert.equal(ensureLocalProxyEgress({ id: 'px-local' }, { runDocker: run }).ok, false)
    }
    for (const subnet of ['10.42.15.0/24', '10.42.32.0/24', '10.253.240.0/24'])
      assert.doesNotThrow(() => assertEgressSubnet(subnet))
    assert.throws(() => assertEgressSubnet('10.42.1.0/24', 'invalid'))
    assert.doesNotThrow(() => assertEgressSubnet('10.42.16.0/24', ''))
  } finally {
    if (old === undefined) delete process.env.KIN_EGRESS_RESERVED_CIDRS
    else process.env.KIN_EGRESS_RESERVED_CIDRS = old
  }
})

test('allocation skips Docker networks and all host routing tables', () => {
  const networks = [{ IPAM: { Config: [{ Subnet: '10.253.0.0/24' }] } }]
  const routes = [{ dst: 'default' }, { dst: '10.253.1.128/25' }, { dst: '10.253.2.7', table: 200 }]
  assert.equal(allocateEgressSubnet({ networks, routes, pool: '10.253.0.0/16' }), '10.253.3.0/24')
})

test('bad inventory, unsafe overrides and exhausted pools fail without implicit allocation', () => {
  for (const pool of ['8.8.0.0/16', '10.0.0.0/8', 'garbage']) {
    assert.throws(() => allocateEgressSubnet({ networks: [], routes: [], pool }))
  }
  assert.throws(
    () => allocateEgressSubnet({ networks: [], routes: [{ dst: '10.253.0.0/16' }], pool: '10.253.0.0/16' }),
    { code: 'egress_subnet_exhausted' },
  )
  assert.throws(() => allocateEgressSubnet({ networks: null, routes: [] }))
})
