const labels: Record<string, string> = {
  registration_opening: '正在打开官网注册',
  registration_email_submitted: '已提交注册邮箱',
  registration_password_submitted: '已提交随机强密码',
  registration_email_code: '注册或登录：请输入邮箱验证码',
  registration_opening_password: '正在打开账号设置并设置随机强密码',
  registration_password_email_code: '设置密码：请输入本次邮箱验证码',
  registration_mfa_email_code: '绑定 2FA：请输入本次邮箱验证码',
  registration_password_attention:
    '密码设置需要人工操作，请打开远程屏幕检查。未确认密码成功前不会入池',
  registration_password_unconfirmed: '未确认随机密码设置成功，未加入账号池',
  registration_profile_required:
    '官网需要资料或手机验证，请接管远程屏幕填写后继续',
  registration_page_attention: '官网页面需要人工操作，请接管远程屏幕后继续',
  registration_resuming: '继续自动注册流程',
  registration_opening_security: '正在打开官网安全设置',
  registration_enabling_totp: '正在启用身份验证器',
  registration_verifying_totp: '正在确认 2FA 密钥',
  registration_security_attention:
    '请在远程屏幕打开安全设置并启用身份验证器，再继续自动流程',
  registration_mfa_recovery:
    '2FA 状态需要确认，请在远程屏幕检查；必要时重新设置验证器后继续',
  registration_authorizing: '已入库并绑定，正在授权当前槽位',
  registration_empty_slot_required: '注册需要没有绑定凭据和账号授权的空槽位',
  registration_email_exists: '该邮箱已有账号或池内凭据，请使用登录功能',
  registration_existing_account: '官网进入了已有账号登录流程，已停止注册',
  registration_existing_session:
    '浏览器已有登录会话，无法确认为本次注册，请先检查远程屏幕',
  registration_recovery_pending: '此槽位有尚未完成的注册，请先恢复原邮箱流程',
  registration_checkpoint_failed: '注册恢复凭据未能安全保存，流程已停止',
  registration_store_unavailable: '注册恢复凭据不可读取，请检查加密密钥和存储',
  registration_mfa_unconfirmed: '未能确认官网 2FA 设置完成，未加入账号池',
  registration_not_found: '该槽位没有注册记录',
  registration_owner_mismatch: '无权读取此注册记录',
  browser_registration_failed: '注册流程中断，已保留恢复凭据，请查看远程屏幕',
  web_session_ready: 'ChatGPT 网页会话已登录，继续授权 Codex',
  waiting_manual_login: '已绑定，等待点击登录',
  credential_bound_elsewhere: '该凭据已绑定其他槽位，请先解除绑定',
  credential_bound: '请先解除槽位绑定再删除',
  invalid_login_email: '邮箱格式无效',
  credential_not_found: '凭据不存在或无权访问',
  idle: '等待操作',
  queued: '等待登录',
  running: '进行中',
  preparing_browser: '检查槽内浏览器环境',
  detecting_browser_os: '正在识别槽位系统',
  building_browser_runtime:
    '正在下载并编译浏览器图形环境，首次准备需要较长时间',
  installing_browser_runtime: '正在安装并检查浏览器启动',
  uninstalling_browser: '正在卸载浏览器环境',
  browser_runtime_installed: '浏览器环境已安装，启动检查通过',
  browser_runtime_removed: '浏览器环境已卸载',
  browser_os_unsupported: '当前槽位的系统版本、架构或 Python 版本暂不支持安装',
  browser_uninstall_failed: '卸载失败，请检查浏览器目录是否可写',
  browser_runtime_operation_failed:
    '浏览器环境操作失败，请重试并检查 Docker 和存储空间',
  opening_browser: '启动浏览器',
  openai_login: '登录 GPT',
  openai_password: '验证 GPT 密码',
  openai_account_selected: '已选择与绑定邮箱一致的账号',
  openai_account_selection_required:
    '请接管远程屏幕，选择与绑定邮箱一致的账号后继续',
  openai_phone_required: '官网要求验证手机号，请在远程屏幕完成后继续',
  openai_profile_required: '官网要求补充账号资料，请在远程屏幕完成后继续',
  existing_account_or_phone_required:
    '官网要求补充账号资料或验证手机号，请查看远程屏幕',
  totp_submitted: '验证 TOTP',
  waiting_mfa: '需要手动输入邮件或身份验证码',
  oauth_consent: '确认授权',
  exchanging_code: '保存授权',
  completed: '已完成',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  skipped_existing: '已存在，跳过',
  manual_control: '已由人工接管',
  native_manual_login: '原生浏览器已就绪，请在远程屏幕手动登录授权',
  browser_native_failed:
    '原生浏览器启动或远程桌面连接失败，请重新安装运行环境后重试',
  browser_native_input_unavailable: '原生鼠标键盘组件不可用，请升级浏览器环境',
  browser_native_operation_unavailable:
    '此操作需先关闭原生浏览器窗口，再单独执行',
  browser_resources_busy: '上一个浏览器仍在退出，请稍后重试',
  browser_resources_failed: '临时调整浏览器资源失败，请检查槽位资源配置',
  oauth_callback_unavailable: '槽内授权回调端口不可用，请先关闭遗留登录任务',
  captcha_required: '需要人工验证，请打开远程屏幕处理',
  remote_ready: '远程浏览器已就绪',
  insufficient_enabled_empty_slots:
    '可用空槽位不足，请先准备已开启调度、绑定出口的空 GPT 槽位',
  duplicate_login_email: '批量内容包含重复邮箱',
  invalid_totp_secret:
    '2FA 格式无效，请填写 TOTP 密钥、otpauth 链接或 https://2fa.run/2fa/密钥，不能填写六位验证码',
  mailbox_login_busy: '已有浏览器任务，请等待完成或先停止',
  slot_resting: '槽位已关闭调度，请先开启调度',
  authorized_email_mismatch: '登录返回的账号不一致，未覆盖授权',
  openai_password_rejected: 'GPT 密码未通过',
  totp_rejected: 'TOTP 验证未通过',
  batch_requires_email_password_totp:
    '每行填写微软邮箱---邮箱密码，或邮箱----GPT密码----2FA密钥/链接',
  microsoft_email_required:
    '两列格式仅支持 Outlook / Hotmail / Live / MSN 微软邮箱',
  mailbox_not_configured: '请先绑定邮箱凭据或导入带邮箱信息的账号授权',
  exporting_session: '正在导出当前槽位 ChatGPT Session',
  browser_prepare_failed:
    '浏览器环境准备失败，请重试；若持续失败请检查槽位浏览器运行环境',
  browser_runtime_unavailable:
    '槽位浏览器运行环境不可用，请先点击安装浏览器环境',
  browser_graphical_runtime_missing:
    '缺少图形浏览器组件，请点击升级或重新安装浏览器环境；会话资料会保留',
  browser_display_unavailable:
    '图形显示组件启动失败，请升级或重新安装浏览器环境',
  browser_memory_insufficient:
    '浏览器登录需要槽位内存上限至少 1 GiB，请在槽位概览中提升内存后重试',
  browser_control_busy:
    '浏览器控制请求较多，请稍后再操作，避免多个页面同时接管',
  browser_login_failed: '浏览器登录中断，请检查远程屏幕及槽位资源后重试',
  browser_runtime_invalid: '浏览器运行包校验失败，请重新安装匹配版本',
  browser_launch_failed: '浏览器无法启动，请检查槽位运行依赖和可写目录',
  browser_submit_unavailable:
    '当前登录表单没有可用的提交按钮，请打开远程屏幕检查',
  browser_locale_invalid: '槽位语言配置无效，请检查槽位语言设置',
  browser_timezone_invalid: '槽位时区配置或时区数据无效，请检查槽位时区设置',
  slot_egress_mismatch: '槽位实际网络与绑定出口不一致，已停止登录',
  browser_packages_failed:
    '浏览器依赖下载或构建失败，请检查节点下载网络及存储空间',
  checking_subscription: '正在读取官网自动续订状态',
  opening_subscription: '正在打开官网订阅管理',
  updating_subscription: '正在修改官网自动续订',
  subscription_paid_plan_required: '需要已有的 ChatGPT 付费订阅',
  subscription_needs_attention: '订阅或付款需要处理，请通过远程屏幕查看官网',
  subscription_period_ended: '当前订阅已到期，请先在官网处理套餐',
  subscription_status_unrecognized: '无法识别官网续订状态，请通过远程屏幕查看',
  subscription_portal_unavailable:
    '无法自动打开官网订阅管理，请通过远程屏幕查看',
  subscription_action_unavailable:
    '官网未提供对应的续订操作，请通过远程屏幕查看',
  subscription_confirmation_required: '官网需要额外确认，请通过远程屏幕处理',
  subscription_verification_failed:
    '未能确认官网续订结果，请读取官网状态后核对',
  batch_limit_one_to_hundred: '每批支持 1–100 个账号',
  browser_not_ready: '浏览器正在准备，请稍后重试',
  session_not_authenticated:
    '此槽位尚未登录 ChatGPT 网页。请先绑定凭据并点击登录，或在远程浏览器登录后重试；API 授权不能代替网页会话',
  takeover_required: '请先点击接管，再操作屏幕',
  browser_closed: '浏览器已关闭',
  browser_clipboard_empty: '远程剪贴板为空，请先在远程网页点击复制',
  browser_clipboard_unavailable:
    '无法读取远程剪贴板，请重新打开远程浏览器后再复制',
  browser_clipboard_too_large: '远程剪贴板文字超过 16 KiB，请减少复制内容',
}
export const loginLabel = (code: string) => labels[code] || code
