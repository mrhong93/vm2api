/** Offline S3 protocol fixture. Real AWS SDK requests stay on loopback. */
import http from 'node:http'
import crypto from 'node:crypto'

const xml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const etag = (b) => `"${crypto.createHash('md5').update(b).digest('hex')}"`

export async function startBackupS3(t, { pageSize = 200 } = {}) {
  const objects = new Map(), requests = [], parts = new Map()
  const fixture = { objects, requests, parts, fail: null }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'))
      requests.push({ method: req.method, key, query: url.search, signed: /^AWS4-HMAC-SHA256 /.test(req.headers.authorization || '') })
      const reply = (status, body = '', headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/xml', ...headers })
        res.end(body)
      }
      if (fixture.fail?.({ method: req.method, key, url })) return reply(403, '<Error><Code>AccessDenied</Code><Message>offline denied</Message></Error>')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const metadata = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-amz-meta-')))
      if (req.method === 'GET' && url.searchParams.has('list-type')) {
        const keys = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get('prefix') || '')).sort()
        const start = Number(url.searchParams.get('continuation-token') || 0)
        const end = Math.min(keys.length, start + Math.min(pageSize, Number(url.searchParams.get('max-keys')) || 200))
        return reply(200, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${end < keys.length}</IsTruncated>${end < keys.length ? `<NextContinuationToken>${end}</NextContinuationToken>` : ''}${keys.slice(start, end).map((k) => `<Contents><Key>${xml(k)}</Key><Size>${objects.get(k).body.length}</Size><LastModified>2026-10-27T00:00:00.000Z</LastModified></Contents>`).join('')}</ListBucketResult>`)
      }
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        const id = crypto.randomUUID()
        parts.set(id, { key, metadata, chunks: new Map() })
        return reply(200, `<InitiateMultipartUploadResult><Bucket>backup-fixture</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
      }
      if (url.searchParams.has('uploadId')) {
        const id = url.searchParams.get('uploadId'), upload = parts.get(id)
        if (req.method === 'DELETE') { parts.delete(id); return reply(204) }
        if (req.method === 'PUT') {
          upload.chunks.set(Number(url.searchParams.get('partNumber')), body)
          return reply(200, '', { etag: etag(body) })
        }
        if (req.method === 'POST') {
          const complete = Buffer.concat([...upload.chunks].sort(([a], [b]) => a - b).map(([, b]) => b))
          objects.set(key, { body: complete, metadata: upload.metadata })
          parts.delete(id)
          return reply(200, `<CompleteMultipartUploadResult><Key>${xml(key)}</Key><ETag>${xml(etag(complete))}</ETag></CompleteMultipartUploadResult>`)
        }
      }
      if (req.method === 'PUT') { objects.set(key, { body, metadata }); return reply(200, '', { etag: etag(body) }) }
      if (req.method === 'DELETE') { objects.delete(key); return reply(204) }
      const object = objects.get(key)
      if (!object) return reply(404, '<Error><Code>NoSuchKey</Code></Error>')
      return reply(200, req.method === 'HEAD' ? '' : object.body, { 'content-length': object.body.length, ...object.metadata, etag: etag(object.body) })
    } catch (error) {
      res.writeHead(500); res.end(String(error.message))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  fixture.config = {
    enabled: true, provider: 's3', endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1',
    bucket: 'backup-fixture', prefix: 'fixture/', force_path_style: true,
    access_key: 'offline-access-key', secret_key: 'offline-secret-key', encryption_password: 'offline-backup-password', local_retention_hours: 0,
  }
  return fixture
}
