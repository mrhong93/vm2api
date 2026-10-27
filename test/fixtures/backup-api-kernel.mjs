/** Offline API-kernel IPC responder. It never forwards to an external model. */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export async function startBackupApiKernel(t) {
  const id = crypto.randomUUID()
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\backup-${id}` : path.join(os.tmpdir(), `backup-${id}.sock`)
  const requests = []
  const server = http.createServer(async (req, res) => {
    if (req.url === '/internal/health') { res.end('{}'); return }
    if (req.url !== '/internal/forward') { res.writeHead(404); res.end(); return }
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const envelope = JSON.parse(Buffer.concat(chunks))
      const body = JSON.parse(envelope.body)
      requests.push({ ...envelope, body })
      if (body.stream) {
        const events = [
          { type: 'message_start', message: { id: 'msg_backup_fixture', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'offline backup fixture' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
          { type: 'message_stop' },
        ]
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_backup_fixture', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'offline backup fixture' }], stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4 },
      }))
    } catch { res.writeHead(400); res.end('{}') }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { socket, requests }
}
