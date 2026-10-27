import { parentPort, workerData } from 'node:worker_threads'
import { openDatabase, closeDatabase } from '../db/database.mjs'
import { runBackupJob, prepareRestore, encryptExisting, sha256File } from './backup-core.mjs'

try {
  let result
  if (workerData.mode === 'prepareRestore') result = await prepareRestore(workerData.job)
  else if (workerData.mode === 'encrypt') result = await encryptExisting(workerData.job)
  else if (workerData.mode === 'hash') result = sha256File(workerData.job.file)
  else {
    openDatabase({ dataDir: workerData.dataDir, dbPath: workerData.dbPath })
    result = await runBackupJob(workerData.ctx, workerData.job)
  }
  parentPort.postMessage({ ok: true, result })
} catch (e) {
  parentPort.postMessage({ ok: false, error: { message: String(e?.message || e), code: e?.code || null } })
} finally {
  closeDatabase()
}
