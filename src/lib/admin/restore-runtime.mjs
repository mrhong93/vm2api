/** A restore must not replace files/DB underneath active writers or streams. */
export function createRestoreRuntime({ slots = () => [], busy = () => false, pause, resume } = {}) {
  const active = new Set()
  let paused = false
  return {
    trackHttp(req, res) {
      const p = (req.url || '').split('?')[0]
      const restore = req.method === 'POST' && /^\/api\/panel\/backups\/(?:remote|[^/]+)\/restore$/.test(p)
      const polling =
        req.method === 'GET' &&
        (p === '/api/panel/backups' ||
          p === '/api/panel/backups/config' ||
          p === '/api/panel/backups/storage' ||
          p === '/api/panel/backups/remote' ||
          /\/(stream|events)$/.test(p))
      const dynamic =
        p.startsWith('/api/panel/') ||
        p.startsWith('/admin') ||
        p.startsWith('/v1/') ||
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      if (!dynamic || restore || polling) return () => {}
      const token = {}
      active.add(token)
      let handlerDone = false,
        responseDone = false
      const clean = () => {
        if (handlerDone && responseDone) active.delete(token)
      }
      const finish = () => {
        responseDone = true
        clean()
      }
      res.once('finish', finish)
      res.once('close', finish)
      return () => {
        handlerDone = true
        clean()
      }
    },
    trackSocket(socket) {
      active.add(socket)
      socket.once('close', () => active.delete(socket))
    },
    async before() {
      if (
        slots().some(
          (vm) => ['running', 'ok', 'paused', 'starting'].includes(vm.status) && vm.runtime?.stopped !== true,
        )
      )
        throw Object.assign(new Error('请先关闭全部槽位，再执行恢复；关闭调度不能代替关机'), {
          code: 'restore_slots_running',
        })
      if (active.size || busy())
        throw Object.assign(new Error('仍有请求、浏览器或后台任务正在执行，请等待任务结束后重试恢复'), {
          code: 'restore_in_progress',
        })
      // Set this before awaiting pause so partial pause failure also resumes safely.
      paused = true
      await pause()
    },
    async after() {
      if (!paused) return
      await resume()
      paused = false
    },
  }
}
