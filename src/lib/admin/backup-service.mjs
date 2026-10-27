/** Snapshot orchestration; expensive work stays off the gateway event loop. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { getDb, getDbPath, closeDatabase, openDatabase } from '../db/database.mjs'
import { dbSecret, initializeCredentialSecret } from '../db/secure.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { BackupRepo } from '../db/repos/backup-repo.mjs'
import { reconcileVms } from '../vm/vm-db-sync.mjs'
import { migrateScheduleFields, repairSlotSmbios, repairVmProxyCliEnabled } from '../vm/vm-registry.mjs'
import { invalidateReadCache } from '../vm/vm-file.mjs'
import { installState, rollbackState } from './backup-layout.mjs'
import { BackupStorageConfig, BackupObjectStore, sameStorage, storageIdentity } from './backup-storage.mjs'
import { stamp } from './backup-core.mjs'

export { tarAvailable } from './backup-core.mjs'
export const DEFAULT_SCHEDULE = { enabled: true, interval_hours: 24, retention: 7 }
const fail = (message, code) => Object.assign(new Error(message), { code })
const genericStorageError = (e) =>
  fail(
    `存储桶操作失败，请检查地址、网络及读写权限${e?.$metadata?.httpStatusCode ? `（HTTP ${e.$metadata.httpStatusCode}）` : ''}`,
    'storage_failed',
  )

export class BackupService {
  constructor({ dataDir, projectRoot, configDir, backupDir, tmpDir, checkIntervalMs = 10 * 60_000 } = {}) {
    Object.assign(this, { dataDir, projectRoot, configDir, checkIntervalMs })
    this.backupDir = backupDir || path.join(dataDir, 'backups')
    this.tmpDir = process.env.KIN_BACKUP_TMPDIR || tmpDir || path.join(dataDir, 'tmp')
    this.storage = new BackupStorageConfig(dataDir)
    this.isRestoring = false
    this._running = false
    this._restoring = false
    this._timer = this._bootTimer = null
  }
  _repo() {
    return new BackupRepo(getDb())
  }
  _settings() {
    return new SettingsRepo(getDb())
  }
  _ctx() {
    return {
      dataDir: this.dataDir,
      projectRoot: this.projectRoot,
      configDir: this.configDir,
      backupDir: this.backupDir,
      tmpDir: this.tmpDir,
    }
  }
  _mkdtemp(prefix) {
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 })
    return fs.mkdtempSync(path.join(this.tmpDir, prefix))
  }
  _idle() {
    if (this.recoveryRequired)
      throw fail('恢复回滚未完成，服务已保持维护状态，请先检查保留的回滚资料', 'restore_recovery_required')
    if (this._running || this._restoring) throw fail('备份或恢复正在执行，请稍后重试', 'backup_in_progress')
  }
  onRestored(fn) {
    this._rebindStores = fn
  }
  onBeforeRestore(fn) {
    this._beforeRestore = fn
  }
  onAfterRestore(fn) {
    this._afterRestore = fn
  }
  onBeforeSnapshot(fn) {
    this._beforeSnapshot = fn
  }
  onAfterSnapshot(fn) {
    this._afterSnapshot = fn
  }
  get busy() {
    return this._running || this._restoring || !!this.recoveryRequired
  }

  getSchedule() {
    const cfg = { ...DEFAULT_SCHEDULE, ...this._settings().get('backup_schedule', {}) }
    if (process.env.KIN_BACKUP_DISABLED === '1') cfg.enabled = false
    for (const [key, env] of [
      ['interval_hours', 'KIN_BACKUP_INTERVAL_HOURS'],
      ['retention', 'KIN_BACKUP_RETENTION'],
    ]) {
      const n = Number(process.env[env])
      if (n > 0 && Number.isFinite(n)) cfg[key] = n
    }
    return cfg
  }
  updateSchedule(patch = {}) {
    this._idle()
    const cfg = { ...DEFAULT_SCHEDULE, ...this._settings().get('backup_schedule', {}) }
    if (patch.enabled != null) cfg.enabled = !!patch.enabled
    for (const [key, max] of [
      ['interval_hours', 720],
      ['retention', 100],
    ]) {
      if (patch[key] == null) continue
      const n = Number(patch[key])
      if (!Number.isInteger(n) || n < 1 || n > max)
        throw fail(`${key} must be 1..${max}`, `invalid_${key === 'interval_hours' ? 'interval' : 'retention'}`)
      cfg[key] = n
    }
    this._settings().set('backup_schedule', cfg)
    return this.getSchedule()
  }
  nextAutoAt() {
    const cfg = this.getSchedule()
    if (!cfg.enabled) return null
    const last = this._repo().lastSuccessful({ kinds: ['manual', 'scheduled'] })
    return new Date(
      Math.max(Date.now(), (last ? Date.parse(last.created_at) : 0) + cfg.interval_hours * 3600_000),
    ).toISOString()
  }
  getStorage() {
    return this.storage.public()
  }
  updateStorage(patch) {
    this._idle()
    return this.storage.save(patch)
  }
  async testStorage(patch = {}) {
    const cfg = this.storage.merge({ ...patch, enabled: true })
    const store = new BackupObjectStore(cfg)
    try {
      return await store.test()
    } catch (e) {
      throw genericStorageError(e)
    } finally {
      store.close()
    }
  }
  _cloudConfig() {
    const config = this.storage.read()
    if (!config.enabled) throw fail('请先启用并保存存储桶配置', 'storage_disabled')
    return config
  }
  async scanRemote(cursor) {
    const store = new BackupObjectStore(this._cloudConfig())
    try {
      return await store.list(cursor)
    } catch (e) {
      throw genericStorageError(e)
    } finally {
      store.close()
    }
  }
  _worker(mode, job) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
        workerData: {
          mode,
          dataDir: this.dataDir,
          dbPath: getDbPath(),
          ctx: this._ctx(),
          job,
        },
      })
      let settled = false
      const finish = (fn, arg) => {
        if (!settled) {
          settled = true
          fn(arg)
        }
      }
      worker.once('message', (msg) =>
        msg?.ok
          ? finish(resolve, msg.result)
          : finish(reject, fail(msg?.error?.message || '备份任务失败', msg?.error?.code || 'backup_failed')),
      )
      worker.once('error', (e) => finish(reject, e))
      worker.once('exit', (code) => {
        if (!settled) finish(reject, fail(`备份工作进程退出（${code}）`, 'backup_failed'))
      })
    })
  }

  async createBackup({ kind = 'manual', note = null } = {}) {
    this._idle()
    this._running = true
    try {
      return await this._create({ kind, note })
    } finally {
      this._running = false
    }
  }
  async _create({ kind, note }) {
    const cfg = this.storage.read(),
      id = 'bak_' + crypto.randomBytes(6).toString('hex'),
      createdAt = new Date().toISOString()
    let rec
    try {
      try {
        if (this._beforeSnapshot) await this._beforeSnapshot()
        this.isSnapshotting = true
        rec = await this._worker('backup', {
          id,
          createdAt,
          kind,
          note,
          secret: dbSecret(),
          encryptionPassword: cfg.enabled ? cfg.encryption_password : null,
        })
      } finally {
        this.isSnapshotting = false
        if (this._afterSnapshot) await this._afterSnapshot()
      }
    } catch (e) {
      if (!this._repo().get(id))
        this._repo().insert({ id, created_at: createdAt, kind, status: 'failed', error: '备份工作进程失败', note })
      throw e
    }
    if (cfg.enabled) rec = await this._upload(rec, cfg)
    await this._prune(cfg)
    return this._repo().get(rec.id) || rec
  }
  async _upload(rec, cfg) {
    const store = new BackupObjectStore(cfg)
    // Persist the destination before any network I/O so retries cannot silently
    // send a failed backup to a different bucket after a config change.
    this._repo().update(rec.id, { upload_status: 'uploading', remote: { ...storageIdentity(cfg) }, upload_error: null })
    try {
      const remote = await store.upload(rec),
        now = new Date()
      rec = this._repo().update(rec.id, {
        remote,
        upload_status: 'uploaded',
        uploaded_at: now.toISOString(),
        upload_error: null,
        local_expires_at: new Date(now.getTime() + cfg.local_retention_hours * 3600_000).toISOString(),
      })
    } catch (e) {
      rec = this._repo().update(rec.id, {
        upload_status: 'failed',
        local_expires_at: null,
        upload_error: genericStorageError(e).message,
      })
    } finally {
      store.close()
    }
    if (rec.upload_status === 'uploaded') this.cleanupLocal()
    return rec
  }
  async uploadBackup(id) {
    this._idle()
    this._running = true
    try {
      const cfg = this._cloudConfig()
      let rec = this._repo().get(id)
      if (!rec || rec.status !== 'ok' || !rec.file_path || !fs.existsSync(rec.file_path))
        throw fail('本地备份不存在', 'backup_file_missing')
      if (rec.remote && !sameStorage(rec.remote, cfg))
        throw fail('此备份的原存储桶与当前配置不同，请先切回原配置', 'storage_changed')
      if (!rec.file_name.endsWith('.tar.gz.enc')) {
        if (!rec.file_name.endsWith('.tar.gz'))
          throw fail('旧版数据库单文件备份请先恢复，再重新创建完整备份', 'backup_not_ok')
        const fileName = `kin-backup-${stamp(new Date(rec.created_at))}-${rec.id}.tar.gz.enc`,
          output = path.join(this.backupDir, fileName)
        const info = await this._worker('encrypt', { input: rec.file_path, output, password: cfg.encryption_password })
        const old = rec.file_path
        rec = this._repo().update(id, { file_path: output, file_name: fileName, ...info })
        fs.rmSync(old, { force: true })
      }
      rec = await this._upload(rec, cfg)
      await this._prune(cfg)
      return rec
    } finally {
      this._running = false
    }
  }
  cleanupLocal(now = Date.now()) {
    for (const rec of this._repo().all()) {
      if (
        rec.upload_status !== 'uploaded' ||
        !rec.remote?.index_key ||
        !rec.local_expires_at ||
        Date.parse(rec.local_expires_at) > now
      )
        continue
      if (rec.file_path) {
        try {
          fs.rmSync(rec.file_path, { force: true })
          this._repo().update(rec.id, { file_path: null, upload_error: null })
        } catch {
          this._repo().update(rec.id, { upload_error: '已上传；本地副本暂未清理，将在下次维护时重试' })
        }
      }
    }
  }
  async _prune(cfg) {
    this.cleanupLocal()
    const rows = this._repo()
      .all()
      .filter((r) => r.status === 'ok' && !r.upload_status)
    // Never prune pending/failed uploads, including when cloud mode is disabled.
    for (const pre of [false, true]) {
      for (const rec of rows
        .filter((r) => (r.kind === 'pre_restore') === pre)
        .slice(pre ? 3 : this.getSchedule().retention)) {
        if (rec.file_path) fs.rmSync(rec.file_path, { force: true })
        this._repo().remove(rec.id)
      }
    }
    if (!cfg.enabled) return
    const store = new BackupObjectStore(cfg)
    try {
      const all = []
      let cursor
      do {
        const page = await store.list(cursor)
        all.push(...page.items)
        cursor = page.next_cursor
      } while (cursor)
      all.sort((a, b) => b.created_at.localeCompare(a.created_at))
      for (const pre of [false, true]) {
        for (const rec of all
          .filter((r) => (r.kind === 'pre_restore') === pre)
          .slice(pre ? 3 : this.getSchedule().retention)) {
          // Count-based retention removes the remote archive and its local cache;
          // otherwise local caches expire no later than the configured 24 hours.
          await store.remove(rec.index_key)
          const local = this._repo().get(rec.id)
          if (local?.remote && sameStorage(local.remote, cfg)) {
            if (local.file_path) fs.rmSync(local.file_path, { force: true })
            this._repo().remove(rec.id)
          }
        }
      }
    } catch {
      /* Failure to prune must never discard a recoverable local copy. */
    } finally {
      store.close()
    }
  }
  list({ limit = 100 } = {}) {
    return this._repo()
      .list({ limit })
      .map((r) => ({ ...r, file_exists: !!r.file_path && fs.existsSync(r.file_path) }))
  }
  get(id) {
    return this._repo().get(id)
  }
  remove(id) {
    this._idle()
    const rec = this._repo().get(id)
    if (!rec) return false
    if (rec.file_path) fs.rmSync(rec.file_path, { force: true })
    if (rec.remote?.index_key) this._repo().update(id, { file_path: null })
    else this._repo().remove(id)
    return true
  }

  async restoreBackup(id, { password } = {}) {
    this._idle()
    const rec = this._repo().get(id)
    if (!rec) throw fail('backup not found', 'backup_not_found')
    if (rec.status !== 'ok') throw fail('备份不可恢复', 'backup_not_ok')
    if (!rec.file_path || !fs.existsSync(rec.file_path)) {
      const cfg = this._cloudConfig()
      if (!rec.remote?.index_key || !sameStorage(rec.remote, cfg))
        throw fail('本地备份已清理，请切换原存储桶后扫描恢复', 'backup_file_missing')
      return this.restoreRemote(rec.remote.index_key, { password })
    }
    return this._restore(rec, { password })
  }
  async restoreRemote(indexKey, { password } = {}) {
    this._idle()
    const cfg = this._cloudConfig(),
      store = new BackupObjectStore(cfg),
      temp = this._mkdtemp('kin-download-')
    this._restoring = true
    try {
      let descriptor, file
      try {
        descriptor = await store.read(indexKey)
        file = path.join(temp, descriptor.file_name)
        await store.download(indexKey, file)
      } catch (e) {
        throw e.code === 'backup_corrupt' || e.code === 'invalid_storage_config' ? e : genericStorageError(e)
      }
      const rec = {
        ...descriptor,
        status: 'ok',
        file_path: file,
        remote: { ...storageIdentity(cfg), ...descriptor, index_key: indexKey },
        upload_status: 'uploaded',
      }
      return await this._restore(rec, { password: password || cfg.encryption_password, downloaded: true })
    } finally {
      this._restoring = false
      store.close()
      fs.rmSync(temp, { recursive: true, force: true })
    }
  }
  async _restore(rec, { password, downloaded = false }) {
    this._restoring = true
    const temp = this._mkdtemp('kin-restore-'),
      staging = path.join(temp, 'state'),
      rollback = path.join(temp, 'rollback')
    fs.mkdirSync(staging, { mode: 0o700 })
    const targetSecret = dbSecret() || crypto.randomBytes(32).toString('hex')
    let journal = [],
      committed = false,
      hookEntered = false,
      savedDb,
      keyCreated = false
    const dbPath = getDbPath(),
      keyFile = path.join(this.dataDir, 'credential-secret.key')
    const marker = path.join(this.dataDir, 'backup-restore-pending.json')
    let markerCreated = false
    try {
      // All download/decrypt/path/hash/SQLite/key checks happen before maintenance.
      const manifest = await this._worker('prepareRestore', {
        file: rec.file_path,
        sha256: rec.sha256,
        staging,
        password: password || this.storage.read().encryption_password,
        targetSecret,
      })
      this.isRestoring = true
      if (this._beforeRestore) {
        hookEntered = true
        await this._beforeRestore()
      }
      const pre = await this._create({ kind: 'pre_restore', note: `before restore of ${rec.id}` })
      const known = this._repo().all()
      const dbSave = `${dbPath}.restore-${crypto.randomUUID()}`
      fs.writeFileSync(
        marker,
        JSON.stringify({
          version: 1,
          directory: temp,
          database: dbPath,
          saved_database: dbSave,
          rollback_directory: rollback,
          pre_restore: pre.id,
          key_created: !dbSecret(),
        }),
        { mode: 0o600, flag: 'wx' },
      )
      markerCreated = true
      try {
        closeDatabase()
        fs.renameSync(dbPath, dbSave)
        savedDb = dbSave
        for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
        fs.copyFileSync(path.join(staging, 'db/kin.db'), dbPath)
        fs.chmodSync(dbPath, 0o600)
        journal = installState(this._ctx(), staging, manifest, rollback)
        if (!dbSecret()) {
          fs.writeFileSync(keyFile, targetSecret, { mode: 0o600, flag: 'wx' })
          keyCreated = true
        }
        const db = openDatabase({ dataDir: this.dataDir, dbPath, allowRestore: true })
        invalidateReadCache()
        if (this.projectRoot) {
          reconcileVms(this.projectRoot)
          repairVmProxyCliEnabled(this.projectRoot)
          repairSlotSmbios(this.projectRoot)
          migrateScheduleFields(this.projectRoot)
        }
        // Foreign ledger paths belong to the source host; never operate on them.
        db.exec('DELETE FROM backup_records')
        const localRecord = known.find((r) => r.id === rec.id)
        // A bucket restore must not orphan a local archive already in our ledger.
        const restoredRecord = {
          ...rec,
          file_path: downloaded ? localRecord?.file_path || null : rec.file_path,
          local_expires_at: localRecord?.local_expires_at || null,
        }
        for (const record of [...known, pre, restoredRecord]) {
          if (!this._repo().get(record.id)) this._repo().insert(record)
          else this._repo().update(record.id, record)
        }
        if (this._rebindStores) await this._rebindStores(db)
        // Deployment files are references only; do not overwrite a live .env or
        // host network/volume paths. They may contain secrets: directory is 0700.
        if (fs.existsSync(path.join(staging, 'deployment'))) {
          const reference = path.join(this.dataDir, 'restored-deployment', rec.id)
          fs.mkdirSync(reference, { recursive: true, mode: 0o700 })
          fs.cpSync(path.join(staging, 'deployment'), reference, { recursive: true })
        }
        committed = true
      } catch (e) {
        journal = e.restoreJournal || journal
        closeDatabase()
        try {
          rollbackState(journal)
          for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
          // Keep the old DB and file journal until reopening and rebinding succeed.
          if (savedDb) {
            fs.rmSync(dbPath, { force: true })
            fs.copyFileSync(savedDb, dbPath)
          }
          if (keyCreated) fs.rmSync(keyFile, { force: true })
          initializeCredentialSecret(this.dataDir)
          const db = openDatabase({ dataDir: this.dataDir, dbPath, allowRestore: true })
          invalidateReadCache()
          if (this._rebindStores) await this._rebindStores(db)
          if (savedDb) fs.rmSync(savedDb, { force: true })
          savedDb = null
        } catch {
          this.recoveryRequired = { directory: temp, database: savedDb }
          throw fail('恢复回滚未完成，已保留旧数据库和文件回滚资料，并保持服务维护状态', 'restore_recovery_required')
        }
        throw e
      }
      return { ok: true, restored: rec.id, pre_restore: pre.id }
    } finally {
      try {
        if (hookEntered && !this.recoveryRequired && this._afterRestore) {
          try {
            await this._afterRestore()
          } catch {
            this.recoveryRequired = { directory: temp, database: savedDb || dbPath }
            throw fail('备份数据已处理，但后台服务未能恢复，已保持维护状态并保留回滚资料', 'restore_recovery_required')
          }
        }
        if (committed && savedDb) {
          try {
            fs.rmSync(savedDb, { force: true })
          } catch {
            console.warn('[backup] old database cleanup deferred; inspect restore temporary files')
          }
        }
        if (markerCreated && !this.recoveryRequired) fs.rmSync(marker, { force: true })
      } finally {
        this.isRestoring = !!this.recoveryRequired
        this._restoring = false
        // On rollback failure preserve the journal and old DB for recovery.
        if (!this.recoveryRequired && (committed || !savedDb)) fs.rmSync(temp, { recursive: true, force: true })
      }
    }
  }
  shouldRunScheduled(now = Date.now()) {
    const cfg = this.getSchedule()
    if (!cfg.enabled || this.busy || this.isRestoring) return false
    const last = this._repo().lastSuccessful({ kinds: ['manual', 'scheduled'] })
    return !last || now - Date.parse(last.created_at) >= cfg.interval_hours * 3600_000
  }
  async maintenance() {
    if (this.busy) return
    // Plaintext staging is disposable. Only remove our abandoned, old temporary
    // entries; archives and any failed-recovery journal are never swept here.
    if (fs.existsSync(this.tmpDir))
      for (const name of fs.readdirSync(this.tmpDir)) {
        if (!/^kin-(backup|download|restore)-[A-Za-z0-9]+$/.test(name) && !/^bak_[a-f0-9]+\.tar\.gz$/.test(name))
          continue
        const file = path.join(this.tmpDir, name),
          stat = fs.lstatSync(file)
        if (!stat.isSymbolicLink() && stat.mtimeMs < Date.now() - 24 * 3600_000)
          fs.rmSync(file, { recursive: stat.isDirectory(), force: true })
      }
    this.cleanupLocal()
    const cfg = this.storage.read()
    if (cfg.enabled) {
      const retry = this._repo()
        .all()
        .find(
          (r) =>
            ['pending', 'failed', 'uploading'].includes(r.upload_status) &&
            r.file_path &&
            (!r.remote || sameStorage(r.remote, cfg)),
        )
      if (retry) await this.uploadBackup(retry.id)
    }
  }
  startScheduler() {
    this.stopScheduler()
    const check = async () => {
      try {
        await this.maintenance()
        if (this.shouldRunScheduled()) await this.createBackup({ kind: 'scheduled' })
      } catch {
        console.warn('[backup] automatic backup/maintenance failed; see backup panel')
      }
    }
    this._timer = setInterval(check, this.checkIntervalMs)
    this._timer.unref?.()
    this._bootTimer = setTimeout(check, 5000)
    this._bootTimer.unref?.()
  }
  stopScheduler() {
    clearInterval(this._timer)
    clearTimeout(this._bootTimer)
    this._timer = this._bootTimer = null
  }
}
