import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { LoginStatus } from './codex-password-panel'
import { loginLabel } from './login-labels'

type Credentials = {
  email: string
  password: string
  totp_secret: string
  password_verified: boolean
  mfa_verified: boolean
}

export function CodexRegistrationControls({
  vm,
  status,
  locked,
}: {
  vm: Vm
  status?: LoginStatus
  locked: boolean
}) {
  const qc = useQueryClient()
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/login`
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<Credentials | null>(null)
  const registration = status?.registration
  const running = status?.state.running === true
  useEffect(() => setCode(''), [status?.state.stage])
  const occupied = status?.configured || vm.has_token || vm.has_refresh
  const unavailable =
    locked ||
    busy ||
    !(
      ['running', 'ok', 'paused'].includes(vm.status || '') &&
      vm.runtime?.stopped !== true
    ) ||
    vm.can_import_credential === false
  async function refresh() {
    await qc.invalidateQueries({ queryKey: ['codex-login', vm.id] })
    await qc.invalidateQueries({ queryKey: ['login-credentials'] })
  }
  async function perform(action: 'register' | 'verify' | 'cancel') {
    setBusy(true)
    try {
      await api(`${endpoint}/${action}`, {
        method: 'POST',
        body: JSON.stringify(
          action === 'register'
            ? { email }
            : action === 'verify'
              ? { code }
              : {}
        ),
      })
      setCode('')
      setRevealed(null)
      await refresh()
      if (action === 'register')
        toast.success('已开始使用当前槽位注册，请等待邮箱验证码')
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy(false)
    }
  }
  async function reveal() {
    setBusy(true)
    try {
      setRevealed(
        await api<Credentials>(`${endpoint}/registration-reveal`, {
          method: 'POST',
          body: '{}',
        })
      )
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy(false)
    }
  }
  async function copy(text: string) {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(text)
      else {
        // LAN panels may use HTTP, where the Clipboard API is unavailable.
        const input = document.createElement('textarea')
        input.value = text
        document.body.appendChild(input)
        try {
          input.select()
          if (!document.execCommand('copy'))
            throw new Error('clipboard_unavailable')
        } finally {
          input.remove()
        }
      }
      toast.success('已复制')
    } catch {
      toast.error('无法自动复制，请选择下方凭据手动复制')
    }
  }
  function changeOpen(value: boolean) {
    setOpen(value)
    setCode('')
    setRevealed(null)
    if (value) setEmail(registration?.email || '')
  }
  return (
    <>
      <Button
        size='sm'
        variant='outline'
        disabled={
          !status ||
          (!registration && (locked || busy || running || !!occupied))
        }
        onClick={() => changeOpen(true)}
      >
        {registration
          ? running && !status?.configured
            ? '注册进度'
            : '注册记录'
          : '注册账号'}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className='max-h-[90vh] overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>使用当前槽位注册账号</DialogTitle>
            <DialogDescription>
              使用槽位的语言、时区和代理。自动生成 GPT
              强密码。先输入邮箱验证码完成注册或登录，再设置密码并绑定 2FA；
              官网可能多次发送邮箱验证码。密码和 2FA
              均确认后才入池、绑定并授权。
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            <label className='block space-y-1 text-sm'>
              <span>注册邮箱</span>
              <Input
                aria-label='注册邮箱'
                type='email'
                value={email}
                autoComplete='off'
                disabled={
                  busy ||
                  running ||
                  !!occupied ||
                  (!!registration && registration.phase !== 'draft')
                }
                onChange={(e) => setEmail(e.target.value)}
                placeholder='填写你指定的邮箱'
              />
            </label>
            {!occupied && (
              <Button
                size='sm'
                disabled={unavailable || running || !email.trim()}
                onClick={() => void perform('register')}
              >
                {registration ? '继续注册流程' : '下一步：开始注册'}
              </Button>
            )}
            {occupied && !registration && (
              <p className='text-xs text-amber-600'>
                请选择没有账号授权和绑定凭据的空槽位。
              </p>
            )}
            {vm.schedulable === false && (
              <p className='text-xs text-muted-foreground'>
                调度关闭不影响手动注册；注册及授权完成后仍保持关闭，由你手动开启。
              </p>
            )}
            {!(
              ['running', 'ok', 'paused'].includes(vm.status || '') &&
              vm.runtime?.stopped !== true
            ) && (
              <p className='text-xs text-amber-600'>
                请先在槽位页面点击开机。空槽无需账号凭据即可开机。
              </p>
            )}
            {vm.can_import_credential === false && (
              <p className='text-xs text-amber-600'>
                当前槽位尚不满足授权条件，请先配置槽位代理并确认槽位可用。
              </p>
            )}
            <p aria-live='polite' className='text-sm'>
              {loginLabel(status?.state.stage || 'idle')}
              {status?.state.error_code && (
                <span className='block text-amber-600'>
                  {loginLabel(status.state.error_code)}
                </span>
              )}
            </p>
            {registration && (
              <p className='text-xs text-muted-foreground'>
                {registration.mfa_verified
                  ? '密码和 2FA 均已确认，凭据已加密保存。'
                  : registration.password_verified
                    ? '密码已设置，等待确认 2FA。关闭此窗口不会停止任务。'
                    : '密码尚未确认设置成功。生成的密码仅作为恢复草稿加密保留。'}
                {status?.configured &&
                  !status.login_armed &&
                  ' 当前账号已绑定；授权未完成时，可关闭窗口后点击登录重试。'}
              </p>
            )}
            {running &&
              [
                'registration_email_code',
                'registration_password_email_code',
                'registration_mfa_email_code',
              ].includes(status?.state.stage || '') && (
                <div className='space-y-2'>
                  <p className='text-xs text-muted-foreground'>
                    {loginLabel(status?.state.stage || '')}
                    。每一步请使用本次新收到的验证码。
                  </p>
                  <Input
                    aria-label='注册邮箱验证码'
                    value={code}
                    autoComplete='one-time-code'
                    onChange={(e) => setCode(e.target.value)}
                    placeholder='输入邮件中的验证码'
                    maxLength={12}
                  />
                  <Button
                    size='sm'
                    disabled={unavailable || !code.trim()}
                    onClick={() => void perform('verify')}
                  >
                    提交邮箱验证码
                  </Button>
                </div>
              )}
            <p className='text-xs text-muted-foreground'>
              若官网要求资料、生日、手机验证或验证码，请通过远程屏幕自行填写，然后继续自动流程。2FA
              密钥来自官网验证器设置，邮箱验证码不能代替它。
            </p>
            {running && (
              <div className='flex gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    changeOpen(false)
                    window.dispatchEvent(
                      new CustomEvent('codex-open-browser', { detail: vm.id })
                    )
                  }}
                >
                  查看远程屏幕
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  disabled={busy}
                  onClick={() => void perform('cancel')}
                >
                  停止任务
                </Button>
              </div>
            )}
            {registration && (
              <Button
                size='sm'
                variant='outline'
                disabled={busy}
                onClick={() => void reveal()}
              >
                {registration.mfa_verified
                  ? '查看并复制账号 / 2FA'
                  : '查看恢复凭据'}
              </Button>
            )}
            {revealed && (
              <div className='space-y-2'>
                {!revealed.mfa_verified && (
                  <p className='text-xs text-amber-600'>
                    未确认注册和 2FA
                    完成；下方仅为中断恢复凭据，不代表账号池已入库。
                  </p>
                )}
                <Textarea
                  aria-label='注册凭据'
                  readOnly
                  autoComplete='off'
                  spellCheck={false}
                  value={`${revealed.email}----${revealed.password}----${revealed.totp_secret}`}
                />
                <div className='flex gap-2'>
                  <Button
                    size='sm'
                    onClick={() =>
                      void copy(
                        `${revealed.email}----${revealed.password}----${revealed.totp_secret}`
                      )
                    }
                  >
                    复制完整凭据
                  </Button>
                  {revealed.mfa_verified && (
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => void copy(revealed.totp_secret)}
                    >
                      仅复制 2FA 密钥
                    </Button>
                  )}
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setRevealed(null)}
                  >
                    隐藏
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
