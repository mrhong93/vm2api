// Destructive only to dedicated vm2api-browser-test-* fixtures. No account login.
// Run from repository root: node test/manual/mailbox-browser-environment.mjs ubuntu24|debian12
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { manageMailboxBrowserRuntime, runBrowserDocker } from '../../src/lib/oauth/mailbox-browser-environment.mjs'
import { runMailboxSlotProcess } from '../../src/lib/oauth/codex-mailbox-runtime.mjs'
const distro = process.argv[2] || 'ubuntu24'
if (!['ubuntu24', 'debian12'].includes(distro)) throw Error('test slots only')
const container = 'vm2api-browser-test-' + distro
const vm = {
  id: distro === 'ubuntu24' ? 'vm-91' : 'vm-92',
  platform: 'openai',
  status: 'running',
  schedulable: true,
  runtime: { container },
}
const root = '/home/kincli/.local/share/kin-mailbox'
const manage = (action) =>
  manageMailboxBrowserRuntime({
    projectRoot: process.cwd(),
    vm,
    action,
    onStage: (stage) => console.log(distro + ': ' + stage),
  })
const shell = (code) =>
  execFileSync('docker', ['exec', '-u', '0', container, 'python3', '-c', code], { encoding: 'utf8' })
const runner = fs.readFileSync('scripts/mailbox-runtime-slot.py', 'utf8')
const command = ['exec', '-i', '-u', '0', container, 'python3', '-u', '-c', runner]
let info = await manage('install')
assert.equal(info.verified, true)
const prepare = () => runMailboxSlotProcess({ projectRoot: process.cwd(), vm, action: 'prepare' })
assert.equal((await prepare()).ok, true)
console.log('PASS normal preparation uses installed runtime without account login')
for (const dir of ['profiles', 'cache', 'config'])
  shell(
    `from pathlib import Path; p=Path('${root}/${dir}');p.mkdir(parents=True,exist_ok=True);(p/'test-preserved').write_text('fixture-only')`,
  )
const preserved = () => {
  for (const dir of ['profiles', 'cache', 'config'])
    assert.equal(
      shell(`from pathlib import Path; print(Path('${root}/${dir}/test-preserved').read_text(),end='')`),
      'fixture-only',
    )
}
info = await manage('install')
assert.equal(info.installed, true)
preserved()
console.log('PASS reinstall preserves session fixtures')
const bad = '/tmp/browser-invalid-' + crypto.randomUUID() + '.tar.gz'
fs.writeFileSync(bad, 'invalid archive')
await assert.rejects(
  runBrowserDocker({
    argv: command,
    archive: bad,
    input: JSON.stringify({ action: 'install', target: info, job_id: crypto.randomUUID() }) + '\n',
  }),
)
fs.unlinkSync(bad)
assert.equal((await manage('status')).installed, true)
preserved()
console.log('PASS invalid bundle retains existing runtime')
const job = crypto.randomUUID()
const child = spawn('docker', command, { stdio: ['pipe', 'ignore', 'ignore'] })
const exited = new Promise((resolve) => child.on('close', resolve))
child.stdin.on('error', () => {})
child.stdin.write(JSON.stringify({ action: 'install', target: info, job_id: job }) + '\n')
for (let n = 0; n < 100; n++) {
  if (
    shell(`from pathlib import Path; print(Path('/tmp/kin-mailbox-maintenance/${job}.json').exists())`).trim() ===
    'True'
  )
    break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
await runBrowserDocker({ argv: command, input: JSON.stringify({ action: 'cancel', job_id: job }) + '\n' })
child.stdin.end()
assert.notEqual(await exited, 0)
preserved()
assert.equal((await manage('status')).installed, true)
console.log('PASS guest cancellation rolls back and exits')
info = await manage('uninstall')
assert.equal(info.installed, false)
preserved()
await assert.rejects(prepare(), { code: 'browser_runtime_unavailable' })
assert.equal((await manage('status')).installed, false)
console.log('PASS uninstall removes binaries and retains profiles/cache/config')
await manage('install')
preserved()
console.log('PASS clean reinstall after removal; browser launched only on inline page')
console.log('ALL PASS ' + distro)
