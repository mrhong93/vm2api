// Explicit /24 allocation: Docker's implicit pools can capture physical LANs.
export const DEFAULT_EGRESS_POOL = '10.253.0.0/16'

function cidr(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/.exec(String(value))
  if (!match) throw new Error(`invalid IPv4 subnet: ${value}`)
  const octets = match.slice(1, 5).map(Number)
  const prefix = Number(match[5] ?? 32)
  if (octets.some((n) => n > 255) || prefix > 32) throw new Error(`invalid IPv4 subnet: ${value}`)
  const address = octets.reduce((n, b) => n * 256 + b, 0)
  const size = 2 ** (32 - prefix)
  const start = Math.floor(address / size) * size
  return { start, end: start + size - 1, prefix }
}

function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end
}

// Site-specific reservations stay in deployment configuration, not public code.
export function assertEgressSubnet(subnet, reserved = process.env.KIN_EGRESS_RESERVED_CIDRS || '') {
  const net = cidr(subnet)
  for (const value of String(reserved)
    .split(/[\s,]+/)
    .filter(Boolean)) {
    if (overlaps(net, cidr(value))) {
      throw Object.assign(
        new Error(`egress subnet ${subnet} overlaps a configured reservation; migrate this network first`),
        { code: 'egress_subnet_reserved' },
      )
    }
  }
  return net
}

export function allocateEgressSubnet({
  networks,
  routes,
  pool = process.env.KIN_EGRESS_ADDRESS_POOL || DEFAULT_EGRESS_POOL,
}) {
  const range = assertEgressSubnet(pool)
  const privateRanges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map(cidr)
  if (
    range.prefix < 16 ||
    range.prefix > 24 ||
    !privateRanges.some((r) => range.start >= r.start && range.end <= r.end)
  ) {
    throw new Error('egress address pool must be a private IPv4 /16 through /24')
  }
  if (!Array.isArray(networks) || !Array.isArray(routes)) throw new Error('egress subnet inventory unavailable')
  const occupied = []
  for (const network of networks) {
    for (const config of network.IPAM?.Config || []) {
      if (config.Subnet && !config.Subnet.includes(':')) occupied.push(cidr(config.Subnet))
    }
  }
  for (const route of routes) {
    if (route.dst && route.dst !== 'default' && route.dst !== '0.0.0.0/0' && !route.dst.includes(':'))
      occupied.push(cidr(route.dst))
  }
  for (let start = range.start; start <= range.end; start += 256) {
    if (occupied.some((r) => overlaps({ start, end: start + 255 }, r))) continue
    const address = [24, 16, 8, 0].map((shift) => Math.floor(start / 2 ** shift) % 256).join('.')
    return `${address}/24`
  }
  throw Object.assign(new Error(`egress address pool ${pool} is exhausted or conflicts with host routes`), {
    code: 'egress_subnet_exhausted',
  })
}
