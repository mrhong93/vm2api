import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { encryptString, decryptString } from '../db/secure.mjs'

export const DEFAULT_STORAGE = {
  enabled: false,
  provider: 'cos',
  endpoint: '',
  region: '',
  bucket: '',
  prefix: 'vm2api/',
  force_path_style: false,
  local_retention_hours: 24,
}

const bad = (message) => Object.assign(new Error(message), { code: 'invalid_storage_config' })
const recordName = /^kin-backup-[\dTZ.-]+-bak_[a-f0-9]+\.json$/

export class BackupStorageConfig {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'backup-storage.json')
    this.keyFile = path.join(dataDir, 'backup-storage.key')
  }

  _key() {
    try {
      return fs.readFileSync(this.keyFile, 'utf8').trim()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 })
      try {
        fs.writeFileSync(this.keyFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      return fs.readFileSync(this.keyFile, 'utf8').trim()
    }
  }

  read() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return { ...DEFAULT_STORAGE, ...JSON.parse(decryptString(saved.sealed, this._key())) }
    } catch (error) {
      if (error.code === 'ENOENT') return { ...DEFAULT_STORAGE }
      throw Object.assign(new Error('存储桶配置无法解密，请恢复原配置密钥或重新配置'), {
        code: 'storage_config_unreadable',
      })
    }
  }

  public() {
    const { access_key, secret_key, encryption_password, ...config } = this.read()
    return {
      ...config,
      has_access_key: !!access_key,
      has_secret_key: !!secret_key,
      has_encryption_password: !!encryption_password,
    }
  }

  merge(patch) {
    const config = this.read()
    for (const key of Object.keys(DEFAULT_STORAGE))
      if (!['access_key', 'secret_key', 'encryption_password'].includes(key) && Object.hasOwn(patch, key))
        config[key] = patch[key]
    for (const key of ['access_key', 'secret_key', 'encryption_password']) {
      if (typeof patch[key] === 'string' && patch[key]) config[key] = patch[key]
    }
    config.enabled = config.enabled === true
    config.force_path_style = config.force_path_style === true
    if (!['cos', 'oss', 's3'].includes(config.provider)) throw bad('请选择 COS、OSS 或 S3 兼容存储')
    for (const key of ['endpoint', 'region', 'bucket', 'prefix']) {
      if (typeof config[key] !== 'string' || config[key].length > 1024) throw bad(`invalid ${key}`)
      config[key] = config[key].trim()
    }
    config.prefix = config.prefix.replace(/^\/+|\/+$/g, '') + '/'
    if (config.prefix === '/' || config.prefix.split('/').some((part) => part === '..' || part === '.'))
      throw bad('请为本实例设置独立的存储桶目录，例如 vm2api/')
    if (/[\\\x00-\x1f]/.test(config.prefix)) throw bad('存储目录不能包含反斜线或控制字符')
    if (![0, 24].includes(Number(config.local_retention_hours))) throw bad('本地保留时间只能是 0 或 24 小时')
    config.local_retention_hours = Number(config.local_retention_hours)
    if (config.endpoint) {
      let url
      try {
        url = new URL(config.endpoint)
      } catch {
        throw bad('Endpoint 格式错误')
      }
      // Plain HTTP is limited to loopback fixtures / local S3 emulators.
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      )
        throw bad('存储桶 Endpoint 必须使用 HTTPS')
      if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
        throw bad('Endpoint 只填写服务地址，不包含桶名、密钥或路径')
      config.endpoint = url.origin
    }
    if (config.provider === 'oss' && config.force_path_style) throw bad('OSS 仅支持虚拟主机寻址，请关闭路径寻址')
    if (config.enabled) {
      if (!config.endpoint || !config.region || !config.bucket || !config.access_key || !config.secret_key)
        throw bad('请填写 Endpoint、地域、桶名、Access Key 和 Secret Key')
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw bad('存储桶名称格式错误')
      if ((config.encryption_password || '').length < 12) throw bad('请设置至少 12 位的备份加密密码，并在异地单独保存')
    }
    return config
  }

  save(patch) {
    const config = this.merge(patch)
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ sealed: encryptString(JSON.stringify(config), this._key()) }), {
        mode: 0o600,
        flag: 'wx',
      })
      fs.renameSync(tmp, this.file)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
    return this.public()
  }
}

export function storageIdentity(config) {
  return { endpoint: config.endpoint, region: config.region, bucket: config.bucket, prefix: config.prefix }
}

export function sameStorage(a, b) {
  return JSON.stringify(storageIdentity(a)) === JSON.stringify(storageIdentity(b))
}

export class BackupObjectStore {
  constructor(config) {
    this.config = config
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.access_key, secretAccessKey: config.secret_key },
      forcePathStyle: config.force_path_style,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 15_000, requestTimeout: 15 * 60_000 },
    })
  }

  close() {
    this.client.destroy()
  }
  send(Command, params) {
    return this.client.send(new Command({ Bucket: this.config.bucket, ...params }))
  }

  validateKey(key) {
    const relative =
      typeof key === 'string' && key.startsWith(this.config.prefix) ? key.slice(this.config.prefix.length) : ''
    if (!recordName.test(relative)) throw bad('只能选择当前目录内的 vm2api 备份索引')
    return key
  }

  async test() {
    // Test actual prefix-scoped write/read/delete permissions, not ListBuckets.
    const Key = `${this.config.prefix}.connection-test-${crypto.randomUUID()}`
    const data = crypto.randomBytes(32)
    try {
      await this.send(PutObjectCommand, { Key, Body: data, ContentLength: data.length })
      const response = await this.send(GetObjectCommand, { Key })
      if (!Buffer.from(await response.Body.transformToByteArray()).equals(data)) throw new Error('存储桶读写校验失败')
      await this.send(ListObjectsV2Command, { Prefix: this.config.prefix, MaxKeys: 1 })
    } finally {
      await this.send(DeleteObjectCommand, { Key })
    }
    return { ok: true }
  }

  async upload(rec) {
    const key = `${this.config.prefix}${rec.file_name}`
    const descriptor = {
      version: 2,
      tool: 'vm2api',
      id: rec.id,
      created_at: rec.created_at,
      kind: rec.kind,
      file_name: rec.file_name,
      object_key: key,
      sha256: rec.sha256,
      size_bytes: rec.size_bytes,
      includes: rec.includes,
      encrypted: true,
    }
    const body = fs.createReadStream(rec.file_path)
    try {
      await new Upload({
        client: this.client,
        params: {
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentLength: rec.size_bytes,
          ContentType: 'application/octet-stream',
          Metadata: { sha256: rec.sha256, 'backup-id': rec.id },
        },
        queueSize: 2,
        partSize: 16 * 1024 * 1024,
        leavePartsOnError: false,
      }).done()
    } finally {
      body.destroy()
    }
    const head = await this.send(HeadObjectCommand, { Key: key })
    if (head.ContentLength !== rec.size_bytes || head.Metadata?.sha256 !== rec.sha256)
      throw new Error('存储桶上传后的大小或校验标识不一致，已保留本地备份')
    const indexKey = key.replace(/\.tar\.gz\.enc$/, '.json')
    this.validateKey(indexKey)
    const index = Buffer.from(JSON.stringify(descriptor))
    await this.send(PutObjectCommand, {
      Key: indexKey,
      Body: index,
      ContentLength: index.length,
      ContentType: 'application/json',
    })
    // Read the committed index before considering the remote copy discoverable.
    const committed = await this.read(indexKey)
    if (committed.sha256 !== rec.sha256) throw new Error('远端备份索引校验失败')
    return { ...storageIdentity(this.config), index_key: indexKey, ...descriptor }
  }

  async read(indexKey) {
    this.validateKey(indexKey)
    const response = await this.send(GetObjectCommand, { Key: indexKey })
    if (!Number.isFinite(response.ContentLength) || response.ContentLength > 64 * 1024) {
      response.Body?.destroy()
      throw new Error('备份索引大小异常')
    }
    const rec = JSON.parse(await response.Body.transformToString())
    const expected = indexKey.replace(/\.json$/, '.tar.gz.enc')
    if (
      rec.version !== 2 ||
      rec.tool !== 'vm2api' ||
      !/^bak_[a-f0-9]+$/.test(rec.id || '') ||
      rec.object_key !== expected ||
      rec.file_name !== expected.slice(this.config.prefix.length) ||
      !expected.endsWith(`-${rec.id}.tar.gz.enc`) ||
      !/^[a-f0-9]{64}$/.test(rec.sha256 || '') ||
      !['manual', 'scheduled', 'pre_restore'].includes(rec.kind) ||
      !rec.includes ||
      rec.includes.db !== true ||
      Object.entries(rec.includes).some(
        ([key, value]) =>
          key !== 'db' && (!['vms', 'config', 'data'].includes(key) || !Number.isSafeInteger(value) || value < 0),
      ) ||
      !Number.isSafeInteger(rec.size_bytes) ||
      rec.size_bytes <= 0 ||
      !Number.isFinite(Date.parse(rec.created_at)) ||
      rec.encrypted !== true
    )
      throw new Error('不受支持或损坏的 vm2api 备份索引')
    return rec
  }

  async list(cursor) {
    if (cursor && (typeof cursor !== 'string' || cursor.length > 4096)) throw bad('invalid scan cursor')
    const page = await this.send(ListObjectsV2Command, {
      Prefix: this.config.prefix,
      MaxKeys: 200,
      ContinuationToken: cursor || undefined,
    })
    const keys = (page.Contents || [])
      .map((entry) => entry.Key)
      .filter((key) => recordName.test(key.slice(this.config.prefix.length)))
    const items = [],
      errors = []
    // Bound concurrent requests while scanning a large bucket.
    for (let offset = 0; offset < keys.length; offset += 8) {
      const results = await Promise.allSettled(
        keys.slice(offset, offset + 8).map(async (key) => {
          const rec = await this.read(key)
          const head = await this.send(HeadObjectCommand, { Key: rec.object_key })
          if (head.ContentLength !== rec.size_bytes || head.Metadata?.sha256 !== rec.sha256)
            throw new Error('archive missing or inconsistent')
          return { ...rec, index_key: key }
        }),
      )
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.status === 'fulfilled') items.push(result.value)
        else errors.push({ index_key: keys[offset + i], error: '索引不可读取或格式不受支持' })
      }
    }
    return {
      items: items.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      errors,
      next_cursor: page.IsTruncated ? page.NextContinuationToken : null,
    }
  }

  async download(indexKey, destination) {
    const rec = await this.read(indexKey)
    const response = await this.send(GetObjectCommand, { Key: rec.object_key })
    if (response.ContentLength !== rec.size_bytes) {
      response.Body?.destroy()
      throw new Error('远端文件大小与备份索引不一致')
    }
    const hash = crypto.createHash('sha256')
    let bytes = 0
    const verify = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length
        if (bytes > rec.size_bytes) return callback(new Error('远端文件超出索引记录大小'))
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(response.Body, verify, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
      if (bytes !== rec.size_bytes || hash.digest('hex') !== rec.sha256) throw new Error('远端备份 SHA256 校验失败')
    } catch (error) {
      fs.rmSync(destination, { force: true })
      throw Object.assign(error, { code: 'backup_corrupt' })
    }
    return rec
  }

  async remove(indexKey) {
    const rec = await this.read(indexKey)
    // Remove the discoverable index only after deleting the archive.
    await this.send(DeleteObjectCommand, { Key: rec.object_key })
    await this.send(DeleteObjectCommand, { Key: indexKey })
  }
}
