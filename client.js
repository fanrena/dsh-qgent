/**
 * dsh-qgent — settings panel for the QQ channel.
 *
 * Rendered by the host's `settings.section` slot. Every value is served by the
 * plugin's own `/qgent/*` routes; saving writes qgent's row into the profile
 * patch, which the Loader hot-reloads.
 */
window.__ModuleLoader__.load({
  id: 'dsh-qgent',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', fontSize: '13px', lineHeight: 1.6, color: 'inherit' },
      status: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', border: '1px solid rgba(127,127,127,0.25)', borderRadius: '10px' },
      dot: on => ({ width: '9px', height: '9px', borderRadius: '50%', background: on ? '#22c55e' : '#ef4444', flex: 'none' }),
      statusText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      title: { fontWeight: 600 },
      muted: { opacity: 0.62, fontSize: '12px', wordBreak: 'break-all' },
      groupTitle: { fontWeight: 600, marginBottom: '8px', marginTop: '4px' },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr', alignItems: 'center', gap: '10px 14px' },
      label: { opacity: 0.82 },
      input: { width: '100%', padding: '7px 9px', fontSize: '13px', color: 'inherit', background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.28)', borderRadius: '8px', outline: 'none', boxSizing: 'border-box' },
      textarea: { width: '100%', minHeight: '84px', padding: '8px 9px', fontSize: '13px', fontFamily: 'inherit', color: 'inherit', background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.28)', borderRadius: '8px', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px', flexWrap: 'wrap' },
      primary: { padding: '7px 16px', fontSize: '13px', fontWeight: 500, color: '#fff', background: '#1677ff', border: 'none', borderRadius: '8px', cursor: 'pointer' },
      secondary: { padding: '7px 14px', fontSize: '13px', color: 'inherit', background: 'rgba(127,127,127,0.10)', border: '1px solid rgba(127,127,127,0.28)', borderRadius: '8px', cursor: 'pointer' },
      danger: { padding: '7px 14px', fontSize: '13px', color: '#ef4444', background: 'transparent', border: '1px solid rgba(239,68,68,0.45)', borderRadius: '8px', cursor: 'pointer' },
      notice: ok => ({ fontSize: '12px', color: ok ? '#16a34a' : '#ef4444' }),
    }

    async function api(path, options) {
      const response = await fetch(path, { cache: 'no-store', ...(options ?? {}) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    const CHANGE = event => event.target.value

    function Field(props) {
      return h('label', { style: styles.label }, props.children)
    }

    function QgentSettings() {
      const [status, setStatus] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [appId, setAppId] = React.useState('')
      const [secret, setSecret] = React.useState('')

      const reload = React.useCallback(async () => {
        try {
          const [nextStatus, nextConfig] = await Promise.all([api('/qgent/status'), api('/qgent/config')])
          setStatus(nextStatus)
          setForm(nextConfig.config)
          setAppId(nextConfig.config.appId ?? '')
          setError('')
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      }, [])

      React.useEffect(() => {
        void reload()
      }, [reload])

      const set = (key, value) => setForm(current => (current === null ? current : { ...current, [key]: value }))
      const setAccess = (key, value) => setForm(current => (current === null ? current : { ...current, access: { ...current.access, [key]: value } }))

      const run = async (kind, operation) => {
        setBusy(kind)
        setNotice(null)
        try {
          const result = await operation()
          setNotice({ ok: true, text: result?.message ?? '已保存' })
          await reload()
        } catch (actionError) {
          setNotice({ ok: false, text: actionError instanceof Error ? actionError.message : String(actionError) })
        } finally {
          setBusy('')
        }
      }

      const save = () => run('save', () => api('/qgent/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requireMention: form.requireMention,
          mode: form.mode,
          fallbackReply: form.fallbackReply,
          debug: form.debug,
          provider: form.provider,
          model: form.model,
          preset: form.preset,
          groupPrompt: form.groupPrompt,
          directPrompt: form.directPrompt,
          access: form.access,
        }),
      }))

      const bind = () => run('bind', () => api('/qgent/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, appSecret: secret }),
      }))

      const unbind = () => run('unbind', () => api('/qgent/unbind', { method: 'POST' }))

      if (error !== '') return h('div', { style: styles.root }, h('p', { style: styles.notice(false) }, `状态读取失败：${error}`))

      if (form === null) return h('div', { style: styles.root }, h('p', { style: styles.muted }, '正在加载…'))

      const access = form.access ?? { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] }
      const connected = status !== null && status.connected === true

      return h('div', { style: styles.root },
        h('div', { style: styles.status },
          h('span', { style: styles.dot(connected) }),
          h('div', { style: styles.statusText },
            h('span', { style: styles.title }, connected ? 'QQ 通道已连接' : 'QQ 通道未连接'),
            h('span', { style: styles.muted },
              status === null ? '' : `AppID ${status.appId || '(未绑定)'}${status.error ? ` · ${status.error}` : ''}`),
          ),
        ),

        h('div', null,
          h('div', { style: styles.groupTitle }, '行为'),
          h('div', { style: styles.grid },
            h(Field, null, '群里只回 @ 机器人的消息'),
            h('input', {
              type: 'checkbox', checked: form.requireMention === true,
              onChange: event => set('requireMention', event.target.checked),
            }),
            h(Field, null, '新消息投递方式'),
            h('select', { style: styles.input, value: form.mode ?? 'steer', onChange: event => set('mode', CHANGE(event)) },
              h('option', { value: 'steer' }, 'steer — 干活途中插话（下一步读到）'),
              h('option', { value: 'queue' }, 'queue — 这轮干完再排队处理'),
            ),
            h(Field, null, '没调用 qq_send 时补发最后一条'),
            h('input', {
              type: 'checkbox', checked: form.fallbackReply === true,
              onChange: event => set('fallbackReply', event.target.checked),
            }),
            h(Field, null, '调试日志'),
            h('input', {
              type: 'checkbox', checked: form.debug === true,
              onChange: event => set('debug', event.target.checked),
            }),
          ),
        ),

        h('div', null,
          h('div', { style: styles.groupTitle }, '模型与 preset'),
          h('div', { style: styles.grid },
            h(Field, null, 'provider'),
            h('input', { style: styles.input, type: 'text', value: form.provider ?? '', placeholder: '留空 = 宿主默认模型', onChange: event => set('provider', CHANGE(event)) }),
            h(Field, null, 'model'),
            h('input', { style: styles.input, type: 'text', value: form.model ?? '', placeholder: '留空 = 宿主默认模型', onChange: event => set('model', CHANGE(event)) }),
            h(Field, null, 'agent preset'),
            h('input', { style: styles.input, type: 'text', value: form.preset ?? '', placeholder: '留空 = 默认 preset', onChange: event => set('preset', CHANGE(event)) }),
          ),
        ),

        h('div', null,
          h('div', { style: styles.groupTitle }, '人设 / 额外提示词'),
          h('div', { style: styles.grid },
            h(Field, null, '群聊'),
            h('textarea', { style: styles.textarea, value: form.groupPrompt ?? '', placeholder: '群里额外的人设和说话规则', onChange: event => set('groupPrompt', CHANGE(event)) }),
            h(Field, null, '私聊'),
            h('textarea', { style: styles.textarea, value: form.directPrompt ?? '', placeholder: '私聊额外的人设和说话规则', onChange: event => set('directPrompt', CHANGE(event)) }),
          ),
        ),

        h('div', null,
          h('div', { style: styles.groupTitle }, '服务范围'),
          h('div', { style: styles.grid },
            h(Field, null, '私聊'),
            h('select', { style: styles.input, value: access.c2cMode, onChange: event => setAccess('c2cMode', CHANGE(event)) },
              h('option', { value: 'open' }, '开放'),
              h('option', { value: 'allowlist' }, '仅白名单'),
              h('option', { value: 'disabled' }, '禁用'),
            ),
            h(Field, null, '私聊白名单'),
            h('input', {
              style: styles.input, type: 'text', value: (access.c2cAllow ?? []).join(', '),
              placeholder: 'openid，逗号分隔；留空 = 不限',
              onChange: event => setAccess('c2cAllow', event.target.value.split(',').map(item => item.trim()).filter(Boolean)),
            }),
            h(Field, null, '群聊'),
            h('select', { style: styles.input, value: access.groupMode, onChange: event => setAccess('groupMode', CHANGE(event)) },
              h('option', { value: 'open' }, '开放'),
              h('option', { value: 'allowlist' }, '仅白名单'),
              h('option', { value: 'disabled' }, '禁用'),
            ),
            h(Field, null, '群聊白名单'),
            h('input', {
              style: styles.input, type: 'text', value: (access.groupAllow ?? []).join(', '),
              placeholder: 'group_openid，逗号分隔；留空 = 不限',
              onChange: event => setAccess('groupAllow', event.target.value.split(',').map(item => item.trim()).filter(Boolean)),
            }),
          ),
        ),

        h('div', { style: styles.actions },
          h('button', { type: 'button', style: styles.primary, disabled: busy !== '', onClick: save }, busy === 'save' ? '保存中…' : '保存配置'),
          notice !== null ? h('span', { style: styles.notice(notice.ok) }, notice.text) : null,
        ),

        h('div', null,
          h('div', { style: styles.groupTitle }, '凭据'),
          h('div', { style: styles.muted }, '留空则沿用 profile 里 dsh-qqbot（im-qqbot）行的凭据；手填会写入 qgent 自己的配置行。同一个 AppID 只能有一个进程连 QQ。'),
          h('div', { style: styles.grid },
            h(Field, null, 'AppID'),
            h('input', { style: styles.input, type: 'text', value: appId, onChange: event => setAppId(CHANGE(event)) }),
            h(Field, null, 'AppSecret'),
            h('input', { style: styles.input, type: 'password', value: secret, placeholder: '不回显；留空表示不改', onChange: event => setSecret(CHANGE(event)) }),
          ),
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.secondary, disabled: busy !== '', onClick: bind }, busy === 'bind' ? '保存中…' : '保存凭据并重连'),
            h('button', { type: 'button', style: styles.danger, disabled: busy !== '', onClick: unbind }, busy === 'unbind' ? '解绑中…' : '解绑'),
            h('button', { type: 'button', style: styles.secondary, disabled: busy !== '', onClick: () => void reload() }, '刷新状态'),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        if (ctx.slots === undefined) return
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qgent',
          order: 7,
          label: 'QQ 机器人',
        }, QgentSettings))
      },
    }
  },
})
