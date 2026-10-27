import fs from 'node:fs'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'

const scrypt = promisify(crypto.scrypt)
const MAGIC = Buffer.from('VM2BAK02')
const HEADER_SIZE = MAGIC.length + 16 + 12
const TAG_SIZE = 16

export async function encryptArchive(input, output, password) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = await scrypt(password, salt, 32)
  const header = Buffer.concat([MAGIC, salt, iv])
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(header)
  try {
    fs.writeFileSync(output, header, { mode: 0o600, flag: 'wx' })
    await pipeline(fs.createReadStream(input), cipher, fs.createWriteStream(output, { flags: 'a', mode: 0o600 }))
    fs.appendFileSync(output, cipher.getAuthTag())
  } catch (error) {
    fs.rmSync(output, { force: true })
    throw error
  } finally {
    key.fill(0)
  }
}

export async function decryptArchive(input, output, password) {
  if (!password) throw Object.assign(new Error('请输入此备份的加密密码'), { code: 'backup_password_required' })
  const fd = fs.openSync(input, 'r')
  const size = fs.fstatSync(fd).size
  const header = Buffer.alloc(HEADER_SIZE)
  const tag = Buffer.alloc(TAG_SIZE)
  try {
    if (size <= HEADER_SIZE + TAG_SIZE)
      throw Object.assign(new Error('加密备份文件不完整'), { code: 'backup_decryption_failed' })
    fs.readSync(fd, header, 0, header.length, 0)
    fs.readSync(fd, tag, 0, tag.length, size - TAG_SIZE)
  } finally {
    fs.closeSync(fd)
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC))
    throw Object.assign(new Error('备份加密格式不受支持'), { code: 'backup_decryption_failed' })
  const key = await scrypt(password, header.subarray(MAGIC.length, MAGIC.length + 16), 32)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(-12))
  decipher.setAAD(header)
  decipher.setAuthTag(tag)
  try {
    await pipeline(
      fs.createReadStream(input, { start: HEADER_SIZE, end: size - TAG_SIZE - 1 }),
      decipher,
      fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }),
    )
  } catch {
    fs.rmSync(output, { force: true })
    throw Object.assign(new Error('备份密码错误或加密文件已损坏'), { code: 'backup_decryption_failed' })
  } finally {
    key.fill(0)
  }
}
