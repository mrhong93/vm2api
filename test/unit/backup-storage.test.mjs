import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { BackupStorageConfig, BackupObjectStore } from '../../src/lib/admin/backup-storage.mjs'
import { startBackupS3 } from '../fixtures/backup-s3.mjs'

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function archive(dir, bytes = 100, id = 'bak_ab12') {
  const fileName = `kin-backup-2026-10-27T00-00-00-000Z-${id}.tar.gz.enc`
  const body = crypto.randomBytes(bytes),
    file = path.join(dir, fileName)
  fs.writeFileSync(file, body)
  return {
    id,
    created_at: '2026-10-27T00:00:00.000Z',
    kind: 'manual',
    file_path: file,
    file_name: fileName,
    size_bytes: bytes,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    includes: { db: true },
  }
}

test('COS/OSS config seals secrets, preserves blank fields and rejects unsafe destinations', async (t) => {
  const fixture = await startBackupS3(t),
    dir = directory(t),
    config = new BackupStorageConfig(dir)
  const publicConfig = config.save(fixture.config)
  assert.equal(publicConfig.has_encryption_password, true)
  assert.equal(publicConfig.secret_key, undefined)
  assert.equal(config.save({ secret_key: '', encryption_password: '' }).has_secret_key, true)
  assert.equal(config.read().encryption_password, fixture.config.encryption_password)
  const saved = fs.readFileSync(config.file, 'utf8')
  for (const key of ['access_key', 'secret_key', 'encryption_password']) assert.ok(!saved.includes(fixture.config[key]))
  assert.throws(() => config.save({ endpoint: 'http://example.invalid' }), /HTTPS/)
  assert.throws(() => config.save({ prefix: '../outside/' }), /独立/)
  assert.throws(() => config.save({ provider: 'oss', force_path_style: true }), /虚拟主机/)
  assert.throws(() => config.save({ local_retention_hours: 48 }), /24/)
  assert.throws(() => config.save({ encryption_password: 'short' }), /12/)
})

test('real SDK signs write/read/list/delete, paginates recoverable indexes and detects damaged downloads', async (t) => {
  const fixture = await startBackupS3(t, { pageSize: 2 }),
    dir = directory(t)
  const store = new BackupObjectStore(fixture.config)
  t.after(() => store.close())
  assert.deepEqual(await store.test(), { ok: true })
  assert.equal(fixture.objects.size, 0, 'connection test leaves no object')
  const rec = archive(dir),
    remote = await store.upload(rec)
  const second = await store.upload(archive(dir, 128, 'bak_ff13'))
  fixture.objects.set('fixture/kin-backup-2026-10-27T00-00-00-000Z-bak_aa99.json', {
    body: Buffer.from('{}'),
    metadata: {},
  })
  const items = [],
    errors = []
  let cursor
  do {
    const page = await store.list(cursor)
    items.push(...page.items)
    errors.push(...page.errors)
    cursor = page.next_cursor
  } while (cursor)
  assert.equal(items.length, 2)
  assert.equal(errors.length, 1)
  assert.ok(fixture.requests.every((r) => r.signed))
  const downloaded = path.join(dir, 'download.enc')
  await store.download(remote.index_key, downloaded)
  assert.deepEqual(fs.readFileSync(downloaded), fs.readFileSync(rec.file_path))
  fs.rmSync(downloaded)
  fixture.objects.get(remote.object_key).body[0] ^= 1
  await assert.rejects(store.download(remote.index_key, downloaded), { code: 'backup_corrupt' })
  assert.equal(fs.existsSync(downloaded), false)
  assert.throws(() => store.validateKey('other/kin-backup-2026-bak_ab12.json'), /当前目录/)
  await store.remove(second.index_key)
  assert.equal(fixture.objects.has(second.object_key), false)
  assert.equal(fixture.objects.has(second.index_key), false)
})

test('large archives use multipart and failed part uploads are aborted', async (t) => {
  const fixture = await startBackupS3(t),
    dir = directory(t),
    store = new BackupObjectStore(fixture.config)
  t.after(() => store.close())
  const rec = archive(dir, 17 * 1024 * 1024)
  await store.upload(rec)
  assert.equal(fixture.parts.size, 0)
  assert.ok(fixture.requests.some((r) => r.query.includes('partNumber=')))
  fixture.fail = ({ method, url }) => method === 'PUT' && url.searchParams.get('partNumber') === '2'
  await assert.rejects(store.upload(archive(dir, 17 * 1024 * 1024, 'bak_aa44')))
  assert.equal(fixture.parts.size, 0, 'failed multipart upload must not leak billable parts')
  assert.ok(fixture.requests.some((r) => r.method === 'DELETE' && r.query.includes('uploadId=')))
})
