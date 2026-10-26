import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { encryptString, decryptString, encryptionEnabled } from '../db/secure.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { mailboxError } from './codex-mailbox-store.mjs'

// Keep a recovery copy before submitting a generated password. Registration is
// an external side effect and cannot be rolled back if the browser disconnects.
export function createRegistrationStore(projectRoot) {
  const directory = path.join(projectRoot, 'data', 'codex-registration')
  const fileOf = (id) => {
    if (!isValidVmId(id)) throw mailboxError('invalid_vm_id')
    return path.join(directory, `${id}.json`)
  }
  const read = (id, owner) => {
    let value
    try {
      value = JSON.parse(decryptString(JSON.parse(fs.readFileSync(fileOf(id), 'utf8')).sealed))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw mailboxError('registration_store_unavailable', 503)
    }
    if (owner && owner.admin !== true && value.owner !== owner.id)
      throw mailboxError('registration_owner_mismatch', 403)
    return value
  }
  return {
    read,
    save(id, value) {
      if (!encryptionEnabled()) throw mailboxError('mailbox_encryption_required', 503)
      const file = fileOf(id)
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      fs.chmodSync(directory, 0o700)
      const tmp = `${file}.${crypto.randomUUID()}.tmp`
      try {
        fs.writeFileSync(tmp, JSON.stringify({ sealed: encryptString(JSON.stringify(value)) }), {
          flag: 'wx',
          mode: 0o600,
        })
        fs.renameSync(tmp, file)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
      return value
    },
    summary(id) {
      const value = read(id)
      return value
        ? {
            email: value.email,
            phase: value.phase,
            credential_id: value.credential_id || null,
            password_verified: value.password_verified === true,
            mfa_verified: value.password_verified === true && ['mfa_verified', 'pooled'].includes(value.phase),
          }
        : null
    },
  }
}
