/** Heavy snapshot, hashing, archive and restore validation work runs in a worker. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import * as tar from 'tar'
import { getDb, vacuumInto, prepareRestoreDatabase } from '../db/database.mjs'
import { BackupRepo } from '../db/repos/backup-repo.mjs'
import { encryptArchive, decryptArchive } from './backup-crypto.mjs'
import { stageState, stageDeployment, validateManifest, rekeyStagedState } from './backup-layout.mjs'

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-')
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256'),
    fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
    let bytes
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

// Historical export. New archives use the bundled tar implementation on all OSes.
export function tarAvailable() {
  try {
    return spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

export async function runBackupJob(ctx, { id, createdAt, kind = 'manual', note = null, encryptionPassword, secret }) {
  const repo = new BackupRepo(getDb())
  fs.mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(ctx.tmpDir, { recursive: true, mode: 0o700 })
  const tmp = fs.mkdtempSync(path.join(ctx.tmpDir, 'kin-backup-'))
  let filePath
  try {
    const dbFile = path.join(tmp, 'db', 'kin.db')
    vacuumInto(getDb(), dbFile)
    const staged = stageState(ctx, tmp, sha256File)
    const recovery = path.join(tmp, 'recovery.json')
    fs.writeFileSync(recovery, JSON.stringify({ db_secret: secret || null }), { mode: 0o600 })
    const manifest = {
      version: 2,
      tool: 'vm2api',
      created_at: createdAt,
      kind,
      ...staged,
      sha256s: {
        ...staged.sha256s,
        ...stageDeployment(ctx, tmp, sha256File),
        'db/kin.db': sha256File(dbFile),
        'recovery.json': sha256File(recovery),
      },
      excluded: ['browser-runtime', 'caches', 'logs', 'panel-sessions', 'remote-unmounted-state', 'vm-disks'],
    }
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
    const fileName = `kin-backup-${stamp(new Date(createdAt))}-${id}.tar.gz${encryptionPassword ? '.enc' : ''}`
    filePath = path.join(ctx.backupDir, fileName)
    const packed = encryptionPassword ? path.join(ctx.tmpDir, `${id}.tar.gz`) : filePath
    try {
      // Restrict access before tar starts writing sensitive plaintext, including
      // when an existing backup/tmp parent directory has broader permissions.
      fs.writeFileSync(packed, '', { flag: 'wx', mode: 0o600 })
      await tar.c({ gzip: true, file: packed, cwd: tmp, portable: true, strict: true }, ['.'])
      fs.chmodSync(packed, 0o600)
      if (encryptionPassword) await encryptArchive(packed, filePath, encryptionPassword)
    } finally {
      if (packed !== filePath) fs.rmSync(packed, { force: true })
    }
    return repo.insert({
      id,
      created_at: createdAt,
      kind,
      status: 'ok',
      file_path: filePath,
      file_name: fileName,
      size_bytes: fs.statSync(filePath).size,
      sha256: sha256File(filePath),
      db_bytes: fs.statSync(dbFile).size,
      includes: staged.includes,
      note,
      upload_status: encryptionPassword ? 'pending' : null,
    })
  } catch (e) {
    if (filePath) fs.rmSync(filePath, { force: true })
    repo.insert({
      id,
      created_at: createdAt,
      kind,
      status: 'failed',
      error: '备份快照或打包失败，未清理已有备份',
      note,
    })
    throw e
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function validateEntry(entry, seen) {
  const original = entry.path
  const name = original.replace(/^\.\//, '').replace(/\/$/, '')
  if (name === '.' || name === '') {
    if (entry.type !== 'Directory') throw new Error('invalid archive root')
    return
  }
  if (
    original.includes('\\') ||
    original.startsWith('/') ||
    /^[a-z]:/i.test(original) ||
    name
      .split('/')
      .some(
        (p) =>
          !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
      ) ||
    /[\x00-\x1f:]/.test(name)
  )
    throw new Error('unsafe archive path')
  if (!['File', 'OldFile', 'Directory'].includes(entry.type))
    throw new Error('archive links and special files are not supported')
  const canonical = process.platform === 'win32' ? name.toLowerCase() : name
  if (seen.has(canonical)) throw new Error('duplicate archive entry')
  seen.add(canonical)
  if (seen.size > 1_000_000) throw new Error('too many archive entries')
}

export async function prepareRestore({ file, sha256, staging, password, targetSecret }) {
  if (sha256 && sha256File(file) !== sha256)
    throw Object.assign(new Error('backup archive sha256 mismatch'), { code: 'backup_corrupt' })
  const decoded = staging + '.decoded.tar.gz'
  let archive = file
  try {
    if (file.endsWith('.enc')) {
      await decryptArchive(file, decoded, password)
      archive = decoded
    }
    if (file.endsWith('.db.gz')) {
      fs.mkdirSync(path.join(staging, 'db'), { recursive: true })
      await pipeline(
        fs.createReadStream(file),
        zlib.createGunzip(),
        fs.createWriteStream(path.join(staging, 'db/kin.db'), { mode: 0o600 }),
      )
      fs.writeFileSync(
        path.join(staging, 'manifest.json'),
        JSON.stringify({ version: 1, sha256s: { 'db/kin.db': sha256File(path.join(staging, 'db/kin.db')) } }),
      )
    } else {
      const seen = new Set()
      let failure,
        bytes = 0
      const disk = fs.statfsSync(staging)
      const available = Number(disk.bavail) * Number(disk.bsize)
      await tar.t({
        file: archive,
        strict: true,
        onReadEntry(entry) {
          try {
            validateEntry(entry, seen)
            bytes += entry.size || 0
            if (bytes > available || !Number.isSafeInteger(bytes)) throw new Error('insufficient restore staging space')
          } catch (e) {
            failure ||= e
          }
        },
      })
      if (failure) throw Object.assign(new Error('备份包含不安全路径、链接或超出可用空间'), { code: 'backup_corrupt' })
      await tar.x({ file: archive, cwd: staging, strict: true, preserveOwner: false, noChmod: true })
    }
  } catch (e) {
    if (e.code === 'backup_decryption_failed' || e.code === 'backup_password_required' || e.code === 'backup_corrupt')
      throw e
    throw Object.assign(new Error('备份文件损坏或归档格式不受支持'), { code: 'backup_corrupt' })
  } finally {
    fs.rmSync(decoded, { force: true })
  }
  const manifest = validateManifest(staging, sha256File)
  prepareRestoreDatabase(path.join(staging, 'db/kin.db'))
  rekeyStagedState(staging, manifest, targetSecret)
  return manifest
}

export async function encryptExisting({ input, output, password }) {
  await encryptArchive(input, output, password)
  return { size_bytes: fs.statSync(output).size, sha256: sha256File(output) }
}
