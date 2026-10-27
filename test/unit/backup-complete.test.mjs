/** Complete restore and object-storage lifecycle, using only fictitious local state. */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import * as tar from 'tar'
import { openDatabase, closeDatabase, getDb } from '../../src/lib/db/database.mjs'
import { dbSecret, encryptString, decryptString } from '../../src/lib/db/secure.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { BackupService } from '../../src/lib/admin/backup-service.mjs'
import { BackupRepo } from '../../src/lib/db/repos/backup-repo.mjs'
import { sha256File } from '../../src/lib/admin/backup-core.mjs'
import { stopVmWatch } from '../../src/lib/vm/vm-db-sync.mjs'
import { setVmWriteHook } from '../../src/lib/vm/vm-file.mjs'
import { startBackupS3 } from '../fixtures/backup-s3.mjs'

let root, dataDir, service, savedEnv
const variables = ['VM2API_DB_SECRET', 'KIN_DB_SECRET', 'KIN_BACKUP_DISABLED', 'KIN_BACKUP_RETENTION']
const put = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}
const read = (file) => fs.readFileSync(file, 'utf8')
const settings = () => new SettingsRepo(getDb())

beforeEach(() => {
  savedEnv = Object.fromEntries(variables.map((key) => [key, process.env[key]]))
  for (const key of variables) delete process.env[key]
  process.env.VM2API_DB_SECRET = 'fictitious-source-key'
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-complete-'))
  dataDir = path.join(root, 'data')
  openDatabase({ dataDir })
  service = new BackupService({ dataDir, projectRoot: root, configDir: path.join(root, 'config') })
})
afterEach(() => {
  service.stopScheduler()
  stopVmWatch()
  setVmWriteHook(null)
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
  for (const key of variables) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

test('round trip includes accounts, nested CLI auth, browser WAL/LevelDB, quality and deployment references', async () => {
  const files = {
    'data/codex-login-pool.json': { accounts: [{ email: 'fixture@example.invalid', slot_id: 'vm-fixture' }] },
    'data/codex-mailbox/vm-fixture.credentials.json': { password: encryptString('fixture-password') },
    'data/codex-registration/vm-fixture.json': { stage: 'complete' },
    'data/quality-preview/owner.json': { prompt: 'fixture candy', frequency_minutes: 10 },
    'data/quality-records/owner.json': { answer: '21', healthy: true },
    'config/routing.json': { marker: 'before' },
    'vms/vm-fixture/cli-home/.codex/auth.json': { access_token: 'fictitious-access' },
    'vms/vm-fixture/cli-home/.claude/credentials.json': { refresh_token: 'fictitious-refresh' },
    'vms/vm-fixture/cli-home/.local/share/kin-mailbox/profiles/gpt/Local Storage/leveldb/000003.log':
      'committed-leveldb-log',
  }
  for (const [file, value] of Object.entries(files)) put(path.join(root, file), value)
  const profile = path.join(root, 'vms/vm-fixture/cli-home/.local/share/kin-mailbox/profiles/gpt')
  const browserDb = new DatabaseSync(put(path.join(profile, 'Cookies'), ''))
  browserDb.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE cookies (value TEXT); INSERT INTO cookies VALUES ('committed-in-wal')",
  )
  assert.ok(fs.statSync(path.join(profile, 'Cookies-wal')).size > 0)
  put(path.join(root, '.env'), 'DEPLOYMENT_REFERENCE=before')
  const cache = put(path.join(profile, 'Cache/keep'), 'cache-before')
  const runtime = put(path.join(root, 'vms/vm-fixture/cli-home/.local/share/kin-mailbox/runtime/bin'), 'runtime-before')
  put(path.join(root, 'data/panel-sessions.json'), { session: 'before' })
  settings().set('protected', 'before')
  let rec
  try {
    rec = await service.createBackup()
  } finally {
    browserDb.close()
  }
  const later = put(path.join(root, 'data/quality-preview/later.json'), { marker: 'delete-on-restore' })
  for (const file of Object.keys(files)) put(path.join(root, file), 'changed')
  put(path.join(profile, 'Cookies-wal'), 'stale wal must be removed')
  put(cache, 'cache-after')
  put(runtime, 'runtime-after')
  put(path.join(root, 'data/panel-sessions.json'), { session: 'after' })
  put(path.join(root, '.env'), 'DEPLOYMENT_REFERENCE=target')
  settings().set('protected', 'after')
  await service.restoreBackup(rec.id)
  assert.equal(settings().get('protected'), 'before')
  for (const [file, value] of Object.entries(files)) {
    if (file.includes('credentials.json') && file.startsWith('data/')) {
      assert.equal(decryptString(JSON.parse(read(path.join(root, file))).password), 'fixture-password')
    } else assert.equal(read(path.join(root, file)), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const restoredBrowser = new DatabaseSync(path.join(profile, 'Cookies'))
  assert.equal(restoredBrowser.prepare('SELECT value FROM cookies').get().value, 'committed-in-wal')
  restoredBrowser.close()
  assert.equal(fs.existsSync(later), false)
  assert.equal(read(cache), 'cache-after')
  assert.equal(read(runtime), 'runtime-after')
  assert.equal(JSON.parse(read(path.join(root, 'data/panel-sessions.json'))).session, 'after')
  assert.equal(read(path.join(root, '.env')), 'DEPLOYMENT_REFERENCE=target')
  assert.equal(read(path.join(dataDir, 'restored-deployment', rec.id, '.env')), 'DEPLOYMENT_REFERENCE=before')
})

test('separate data directory and empty scopes restore without leaving newer state', async () => {
  closeDatabase()
  dataDir = path.join(root, 'database-state')
  openDatabase({ dataDir })
  service = new BackupService({ dataDir, projectRoot: root, configDir: path.join(root, 'config') })
  put(path.join(root, 'data/codex-registration/old.json'), { registered: true })
  const rec = await service.createBackup()
  put(path.join(dataDir, 'quality-records/later.json'), [])
  put(path.join(root, 'config/later.json'), {})
  put(path.join(root, 'data/codex-registration/old.json'), {})
  await service.restoreBackup(rec.id)
  assert.equal(fs.existsSync(path.join(dataDir, 'quality-records/later.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'config/later.json')), false)
  assert.equal(JSON.parse(read(path.join(root, 'data/codex-registration/old.json'))).registered, true)
})

test('verified uploads delete local immediately or after 24 hours, independent of scheduler', async (t) => {
  const fixture = await startBackupS3(t)
  service.updateStorage(fixture.config)
  const immediate = await service.createBackup()
  assert.equal(immediate.upload_status, 'uploaded')
  assert.equal(immediate.file_path, null)
  assert.equal(fs.readdirSync(service.backupDir).length, 0)
  assert.equal((await service.scanRemote()).items[0].id, immediate.id)
  service.updateStorage({ local_retention_hours: 24 })
  const retained = await service.createBackup()
  assert.ok(fs.existsSync(retained.file_path))
  const expiration = Date.parse(retained.local_expires_at)
  service.cleanupLocal(expiration - 1)
  assert.ok(fs.existsSync(retained.file_path))
  service.cleanupLocal(expiration)
  assert.equal(fs.existsSync(retained.file_path), false)
  assert.equal(service.get(retained.id).file_path, null)
  assert.equal((await service.scanRemote()).items.length, 2)
})

test('failed uploads survive retention and restart, never retry into a changed destination', async (t) => {
  const fixture = await startBackupS3(t)
  service.updateSchedule({ enabled: false, retention: 1 })
  service.updateStorage(fixture.config)
  fixture.fail = ({ method }) => method === 'PUT'
  const rec = await service.createBackup()
  assert.equal(rec.upload_status, 'failed')
  assert.equal(rec.local_expires_at, null)
  assert.ok(fs.existsSync(rec.file_path))
  // A successful newer backup must not prune the failed archive.
  fixture.fail = null
  await service.createBackup()
  assert.ok(fs.existsSync(rec.file_path))
  service = new BackupService({ dataDir, projectRoot: root, configDir: path.join(root, 'config') })
  service.updateStorage({ prefix: 'different/' })
  await service.maintenance()
  assert.equal(service.get(rec.id).upload_status, 'failed')
  assert.equal(
    [...fixture.objects.keys()].some((key) => key.startsWith('different/')),
    false,
  )
  await assert.rejects(service.uploadBackup(rec.id), { code: 'storage_changed' })
  service.updateStorage({ prefix: fixture.config.prefix })
  service.updateSchedule({ retention: 2 })
  await service.maintenance()
  assert.equal(service.get(rec.id).upload_status, 'uploaded')
  assert.equal(fs.existsSync(rec.file_path), false)
  assert.equal(service.getSchedule().enabled, false)
})

for (const targetKey of ['fictitious-target-key', null]) {
  test(`fresh ledger scans bucket and restores cross-key credentials (${targetKey ? 'configured key' : 'persistent recovery key'})`, async (t) => {
    const fixture = await startBackupS3(t)
    const sourceRoot = root
    settings().set('secret-holder', { nested: [encryptString('fictitious-secret')] })
    put(path.join(root, 'data/codex-mailbox/vm-fixture.json'), { password: encryptString('fixture-password') })
    service.updateStorage(fixture.config)
    const rec = await service.createBackup()
    closeDatabase()
    if (targetKey) process.env.VM2API_DB_SECRET = targetKey
    else delete process.env.VM2API_DB_SECRET
    dataDir = path.join(root, 'new-machine/data')
    const targetRoot = path.dirname(dataDir)
    openDatabase({ dataDir })
    service = new BackupService({ dataDir, projectRoot: targetRoot, configDir: path.join(targetRoot, 'config') })
    service.updateStorage(fixture.config)
    assert.deepEqual(service.list(), [])
    const remote = (await service.scanRemote()).items.find((item) => item.id === rec.id)
    assert.ok(remote)
    const restored = await service.restoreRemote(remote.index_key)
    assert.equal(restored.restored, rec.id)
    assert.equal(decryptString(settings().get('secret-holder').nested[0]), 'fictitious-secret')
    assert.equal(
      decryptString(JSON.parse(read(path.join(dataDir, 'codex-mailbox/vm-fixture.json'))).password),
      'fixture-password',
    )
    assert.equal(service.get(rec.id).file_path, null)
    assert.equal(fs.readdirSync(service.backupDir).length, 0)
    assert.equal(fs.existsSync(path.join(sourceRoot, 'data/backup-storage.key')), true)
    assert.ok(dbSecret())
    if (!targetKey) assert.ok(fs.existsSync(path.join(dataDir, 'credential-secret.key')))
    closeDatabase()
    openDatabase({ dataDir })
    assert.equal(decryptString(settings().get('secret-holder').nested[0]), 'fictitious-secret')
  })
}

test('wrong password and byte corruption fail before maintenance or pre-restore mutation', async (t) => {
  const fixture = await startBackupS3(t)
  service.updateStorage({ ...fixture.config, local_retention_hours: 24 })
  const rec = await service.createBackup()
  settings().set('untouched', true)
  let maintenance = false
  service.onBeforeRestore(() => {
    maintenance = true
  })
  await assert.rejects(service.restoreBackup(rec.id, { password: 'incorrect-password' }), {
    code: 'backup_decryption_failed',
  })
  assert.equal(maintenance, false)
  assert.equal(settings().get('untouched'), true)
  assert.equal(
    service.list().some((row) => row.kind === 'pre_restore'),
    false,
  )
  fixture.objects.get(rec.remote.object_key).body[50] ^= 1
  await assert.rejects(service.restoreRemote(rec.remote.index_key), { code: 'backup_corrupt' })
  assert.equal(maintenance, false)
  assert.equal(service.isRestoring, false)
})

test('unsafe archive paths, links, duplicate entries and missing manifest fail before touching live files', async () => {
  const rec = await service.createBackup()
  settings().set('untouched', true)
  const variants = [
    [{ path: '../escaped', type: 'File', size: 0 }],
    [{ path: '/absolute', type: 'File', size: 0 }],
    [{ path: 'linked', type: 'SymbolicLink', linkpath: '../escaped', size: 0 }],
    [
      { path: 'same', type: 'File', size: 0 },
      { path: 'same', type: 'File', size: 0 },
    ],
    [{ path: 'no-manifest', type: 'File', size: 0 }],
  ]
  for (const entries of variants) {
    const chunks = entries.map((entry) => {
      const header = new tar.Header(entry)
      header.encode()
      return header.block
    })
    fs.writeFileSync(rec.file_path, zlib.gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)])))
    new BackupRepo(getDb()).update(rec.id, { sha256: sha256File(rec.file_path) })
    await assert.rejects(service.restoreBackup(rec.id), { code: 'backup_corrupt' })
    assert.equal(settings().get('untouched'), true)
    assert.equal(
      service.list().some((row) => row.kind === 'pre_restore'),
      false,
    )
  }
})

test('future database migrations fail preflight before maintenance or changes to live state', async () => {
  getDb()
    .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
    .run('9999', '9999_fictitious_future.sql', 'fictitious-checksum', new Date().toISOString())
  const rec = await service.createBackup()
  getDb().prepare('DELETE FROM schema_migrations WHERE version = ?').run('9999')
  settings().set('marker', 'current-live-state')
  let entered = false
  service.onBeforeRestore(() => {
    entered = true
  })
  await assert.rejects(service.restoreBackup(rec.id), { code: 'backup_version_incompatible' })
  assert.equal(entered, false)
  assert.equal(settings().get('marker'), 'current-live-state')
  assert.equal(
    service.list().some((row) => row.kind === 'pre_restore'),
    false,
  )
  assert.equal(fs.existsSync(path.join(dataDir, 'backup-restore-pending.json')), false)
  assert.equal(service.busy, false)
})

test('rebind failure rolls back database and files together and removes maintenance marker', async () => {
  const file = put(path.join(root, 'data/quality-records/owner.json'), { answer: 'before' })
  settings().set('marker', 'before')
  const rec = await service.createBackup()
  put(file, { answer: 'after' })
  const newFile = put(path.join(root, 'data/codex-registration/new.json'), { registered: 'after' })
  settings().set('marker', 'after')
  let calls = 0
  service.onRestored(() => {
    if (++calls === 1) throw new Error('fixture rebind fails once')
  })
  await assert.rejects(service.restoreBackup(rec.id), /rebind fails once/)
  assert.equal(settings().get('marker'), 'after')
  assert.equal(JSON.parse(read(file)).answer, 'after')
  assert.ok(fs.existsSync(newFile))
  assert.equal(service.isRestoring, false)
  assert.equal(fs.existsSync(path.join(dataDir, 'backup-restore-pending.json')), false)
})

test('resume failure after restore preserves the old database and journal and refuses restart', async () => {
  const file = put(path.join(root, 'data/quality-preview/owner.json'), { marker: 'before' })
  settings().set('marker', 'before')
  const rec = await service.createBackup()
  put(file, { marker: 'after' })
  settings().set('marker', 'after')
  service.onBeforeRestore(() => {})
  service.onAfterRestore(() => {
    throw new Error('fictitious monitor resume failure')
  })
  await assert.rejects(service.restoreBackup(rec.id), { code: 'restore_recovery_required' })
  assert.equal(settings().get('marker'), 'before')
  assert.equal(JSON.parse(read(file)).marker, 'before')
  assert.equal(service.isRestoring, true)
  assert.equal(service.busy, true)
  const marker = JSON.parse(read(path.join(dataDir, 'backup-restore-pending.json')))
  const saved = new DatabaseSync(marker.saved_database, { readOnly: true })
  try {
    assert.equal(new SettingsRepo(saved).get('marker'), 'after')
  } finally {
    saved.close()
  }
  const journal = JSON.parse(read(path.join(marker.rollback_directory, 'journal.json')))
  assert.ok(journal.some((entry) => entry.dest === file))
  await assert.rejects(service.createBackup(), { code: 'restore_recovery_required' })
  closeDatabase()
  assert.throws(() => openDatabase({ dataDir }), /未完成的备份恢复/)
})

test('unrecoverable rebind failure keeps journal and old DB, blocks writes and restart', async () => {
  put(path.join(root, 'data/quality-preview/owner.json'), { state: 'before' })
  const rec = await service.createBackup()
  service.onRestored(() => {
    throw new Error('fixture persistent rebind failure')
  })
  await assert.rejects(service.restoreBackup(rec.id), { code: 'restore_recovery_required' })
  assert.equal(service.isRestoring, true)
  assert.equal(service.busy, true)
  await assert.rejects(service.createBackup(), { code: 'restore_recovery_required' })
  const marker = JSON.parse(read(path.join(dataDir, 'backup-restore-pending.json')))
  assert.ok(fs.existsSync(marker.saved_database))
  assert.ok(fs.existsSync(path.join(marker.rollback_directory, 'journal.json')))
  closeDatabase()
  assert.throws(() => openDatabase({ dataDir }), /未完成的备份恢复/)
})
