/**
 * dsh-qgent — settings panel for the QQ channel.
 *
 * Rendered by the host's `settings.section` slot. Every value is served by the
 * plugin's own `/qgent/*` routes; saving writes qgent's row into the profile
 * patch, which the Loader hot-reloads.
 *
 * The control styling follows the shipped settings primitives (switch,
 * segmented control, field) the way the dsh-qqbot page did, so the panel sits
 * in the settings window instead of looking pasted on.
 */
window.__ModuleLoader__.load({
  id: 'dsh-qgent',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const STYLE_ID = 'qgent-settings-styles'

    const CSS = `
.qg-form { display: flex; flex-direction: column; width: 100%; }
.qg-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.qg-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.qg-field + .qg-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.qg-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.qg-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.qg-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.qg-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.qg-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); cursor: pointer; font: inherit;
}
.qg-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.qg-switch:disabled { cursor: default; opacity: 0.5; }
.qg-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff); transition: transform 120ms ease;
}
.qg-switch[aria-checked='true'] .qg-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff); transform: translateX(16px);
}
.qg-input {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); outline: none;
}
.qg-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.qg-textarea { height: auto; min-height: 68px; padding: 8px 12px; resize: vertical; line-height: 1.5; }
.qg-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover);
}
.qg-seg-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--qg-seg-count) - 1)) / var(--qg-seg-count));
  height: calc(100% - 8px); border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.08));
  transform: translateX(calc(var(--qg-seg-index) * (100% + 2px)));
  transition: transform 160ms ease; pointer-events: none;
}
.qg-seg-tab {
  box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 16px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px;
  font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease;
}
.qg-seg-tab:hover, .qg-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.qg-status { display: flex; flex-direction: column; text-align: left; font-size: 14px; }
.qg-status-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
.qg-status-icon { font-size: 22px; line-height: 1; flex: none; }
.qg-status-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.qg-status-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; }
.qg-status-sub { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.qg-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.qg-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.qg-note--error { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
.qg-save {
  appearance: none; flex: none; border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px); padding: 5px 14px;
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3);
}
.qg-save:disabled { opacity: 0.4; cursor: default; }
.qg-btn {
  appearance: none; flex: none; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  padding: 5px 14px; border-radius: var(--dsw-radius-md, 8px); color: inherit;
  border: 0.5px solid var(--dsw-alias-border-l4); background: transparent;
}
.qg-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.qg-btn:disabled { opacity: 0.4; cursor: default; }
.qg-btn--danger { color: var(--dsw-alias-state-error-primary, #f26d6d); border-color: currentColor; }
`

    function useStyles() {
      React.useEffect(() => {
        if (typeof document === 'undefined') return
        if (document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, [])
    }

    async function api(path, options) {
      const response = await fetch(path, { cache: 'no-store', ...(options ?? {}) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    function Switch({ checked, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        className: 'qg-switch',
        onClick: () => onChange(checked !== true),
      }, h('span', { className: 'qg-switch-thumb' }))
    }

    function Segmented({ value, options, onChange, label }) {
      const index = Math.max(0, options.findIndex(option => option.value === value))
      return h('div', {
        className: 'qg-seg',
        role: 'tablist',
        'aria-label': label,
        style: { '--qg-seg-count': options.length, '--qg-seg-index': index },
      },
      h('span', { className: 'qg-seg-indicator' }),
      ...options.map(option => h('button', {
        key: option.value,
        type: 'button',
        role: 'tab',
        'aria-selected': option.value === value,
        className: 'qg-seg-tab',
        onClick: () => onChange(option.value),
      }, option.label)))
    }

    function TextField({ label, help, value, placeholder, onChange, type = 'text' }) {
      return h('label', { className: 'qg-field' },
        h('span', { className: 'qg-label' }, label),
        h('input', {
          className: 'qg-input',
          type,
          value: value ?? '',
          placeholder: placeholder ?? '',
          onChange: event => onChange(event.target.value),
        }),
        help === undefined ? null : h('span', { className: 'qg-help' }, help),
      )
    }

    function TextAreaField({ label, help, value, placeholder, onChange }) {
      return h('label', { className: 'qg-field' },
        h('span', { className: 'qg-label' }, label),
        h('textarea', {
          className: 'qg-input qg-textarea',
          value: value ?? '',
          placeholder: placeholder ?? '',
          onChange: event => onChange(event.target.value),
        }),
        help === undefined ? null : h('span', { className: 'qg-help' }, help),
      )
    }

    function SwitchField({ label, help, checked, onChange }) {
      return h('div', { className: 'qg-field' },
        h('div', { className: 'qg-head' },
          h('span', { className: 'qg-label' }, label),
          h(Switch, { checked, label, onChange }),
        ),
        help === undefined ? null : h('p', { className: 'qg-help' }, help),
      )
    }

    function QgentSettings() {
      useStyles()
      const [status, setStatus] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [appId, setAppId] = React.useState('')
      const [secret, setSecret] = React.useState('')

      const reload = React.useCallback(async () => {
        const fetchAll = () => Promise.all([api('/qgent/status'), api('/qgent/config')])
        try {
          let result
          try {
            result = await fetchAll()
          } catch {
            // A plugin reload can briefly unregister the routes; one delayed
            // retry covers that window instead of showing a 404.
            await new Promise(resolve => setTimeout(resolve, 700))
            result = await fetchAll()
          }
          const [nextStatus, nextConfig] = result
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
          requireMention: form.requireMention === true,
          mode: form.mode ?? 'steer',
          fallbackReply: form.fallbackReply === true,
          debug: form.debug === true,
          provider: form.provider ?? '',
          model: form.model ?? '',
          preset: form.preset ?? '',
          cwd: form.cwd ?? '',
          groupPrompt: form.groupPrompt ?? '',
          directPrompt: form.directPrompt ?? '',
          access: form.access,
        }),
      }))

      const bind = () => run('bind', () => api('/qgent/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, appSecret: secret }),
      }))

      const unbind = () => run('unbind', () => api('/qgent/unbind', { method: 'POST' }))

      if (error !== '') return h('p', { className: 'qg-note qg-note--error' }, `状态读取失败：${error}`)
      if (form === null) return h('p', { className: 'qg-hint' }, '正在加载…')

      const access = form.access ?? { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] }
      const connected = status !== null && status.connected === true
      const modeOptions = [
        { value: 'open', label: '开放' },
        { value: 'allowlist', label: '仅白名单' },
        { value: 'disabled', label: '禁用' },
      ]

      return h('form', {
        className: 'qg-form',
        onSubmit: event => {
          event.preventDefault()
          save()
        },
      },
      h('div', { className: 'qg-status' },
        h('div', { className: 'qg-status-row' },
          h('span', { className: 'qg-status-icon', 'aria-hidden': true }, connected ? '🟢' : '🔴'),
          h('div', { className: 'qg-status-meta' },
            h('p', { className: 'qg-status-title' }, connected ? 'QQ 通道已连接' : 'QQ 通道未连接'),
            h('p', { className: 'qg-status-sub' },
              status === null
                ? ''
                : `AppID ${status.appId || '(未绑定)'}${status.error ? ` · ${status.error}` : ''}`),
          ),
          h('button', { type: 'button', className: 'qg-btn', onClick: () => void reload() }, '刷新'),
        ),
      ),

      h('div', { className: 'qg-group-title' }, '行为'),
      h(SwitchField, {
        label: '群里只回 @ 机器人的消息',
        help: '关闭时每条群消息都会进模型，由模型自己决定要不要回。',
        checked: form.requireMention === true,
        onChange: value => set('requireMention', value),
      }),
      h('div', { className: 'qg-field' },
        h('span', { className: 'qg-label' }, '新消息投递方式'),
        h(Segmented, {
          label: '新消息投递方式',
          value: form.mode ?? 'steer',
          options: [
            { value: 'steer', label: 'steer · 插话' },
            { value: 'queue', label: 'queue · 排队' },
          ],
          onChange: value => set('mode', value),
        }),
        h('p', { className: 'qg-help' }, 'steer 在当前回合的下一步插进来，边干边回；queue 等这轮干完再处理。对方也可以在消息前加 #steer / #queue 临时改这一条。'),
      ),
      h(SwitchField, {
        label: '没调用 qq_send 时补发最后一条',
        help: '兜底：模型一轮说完却一次都没调工具时，把最后一条回答发到 QQ。关掉就是严格的「只发工具」。',
        checked: form.fallbackReply === true,
        onChange: value => set('fallbackReply', value),
      }),
      h(SwitchField, {
        label: '调试日志',
        checked: form.debug === true,
        onChange: value => set('debug', value),
      }),

      h('div', { className: 'qg-group-title' }, '模型'),
      h(TextField, {
        label: 'provider', value: form.provider, placeholder: '留空 = 宿主默认模型',
        onChange: value => set('provider', value),
      }),
      h(TextField, {
        label: 'model', value: form.model, placeholder: '留空 = 宿主默认模型',
        onChange: value => set('model', value),
      }),
      h(TextField, {
        label: 'agent preset', value: form.preset, placeholder: '留空 = 默认 preset',
        onChange: value => set('preset', value),
      }),
      h(TextField, {
        label: '工作目录（cwd）', value: form.cwd ?? '',
        placeholder: '留空 = 宿主默认（当前工作区）',
        help: 'agent 在哪个目录干活。只对新建会话生效；已经存在的会话保持原目录，换目录用 /new。',
        onChange: value => set('cwd', value),
      }),

      h('div', { className: 'qg-group-title' }, '人设 / 额外提示词'),
      h(TextAreaField, {
        label: '群聊额外 system prompt',
        help: '追加到 qgent 的通道说明后面；群里的说话风格放这里。',
        value: form.groupPrompt,
        onChange: value => set('groupPrompt', value),
      }),
      h(TextAreaField, {
        label: '私聊额外 system prompt',
        value: form.directPrompt,
        onChange: value => set('directPrompt', value),
      }),

      h('div', { className: 'qg-group-title' }, '服务范围'),
      h('div', { className: 'qg-field' },
        h('span', { className: 'qg-label' }, '私聊'),
        h(Segmented, { label: '私聊访问模式', value: access.c2cMode, options: modeOptions, onChange: value => setAccess('c2cMode', value) }),
        access.c2cMode === 'allowlist'
          ? h('input', {
            className: 'qg-input',
            value: (access.c2cAllow ?? []).join(', '),
            placeholder: 'openid，逗号分隔',
            onChange: event => setAccess('c2cAllow', event.target.value.split(',').map(item => item.trim()).filter(Boolean)),
          })
          : null,
      ),
      h('div', { className: 'qg-field' },
        h('span', { className: 'qg-label' }, '群聊'),
        h(Segmented, { label: '群聊访问模式', value: access.groupMode, options: modeOptions, onChange: value => setAccess('groupMode', value) }),
        access.groupMode === 'allowlist'
          ? h('input', {
            className: 'qg-input',
            value: (access.groupAllow ?? []).join(', '),
            placeholder: 'group_openid，逗号分隔',
            onChange: event => setAccess('groupAllow', event.target.value.split(',').map(item => item.trim()).filter(Boolean)),
          })
          : null,
      ),

      h('div', { className: 'qg-group-title' }, '凭据'),
      h(TextField, {
        label: 'AppID', value: appId,
        help: '留空则沿用 profile 里 dsh-qqbot（im-qqbot）行的凭据；手填会写入 qgent 自己的配置行。同一个 AppID 只能有一个进程连 QQ。',
        onChange: setAppId,
      }),
      h(TextField, {
        label: 'AppSecret', type: 'password', value: secret, placeholder: '不回显；留空表示不改',
        onChange: setSecret,
      }),
      h('div', { className: 'qg-footer' },
        h('p', { className: 'qg-note' }, '凭据保存后 qgent 会自动重连。'),
        h('button', { type: 'button', className: 'qg-btn', disabled: busy !== '', onClick: bind }, busy === 'bind' ? '保存中…' : '保存凭据'),
        h('button', { type: 'button', className: 'qg-btn qg-btn--danger', disabled: busy !== '', onClick: unbind }, busy === 'unbind' ? '解绑中…' : '解绑'),
      ),

      h('div', { className: 'qg-footer' },
        h('p', { className: `qg-note${notice !== null && !notice.ok ? ' qg-note--error' : ''}` },
          notice !== null ? notice.text : '保存会写 profile 的 cordis.patch.yml，插件自动热重载。'),
        h('button', { type: 'submit', className: 'qg-save', disabled: busy !== '' }, busy === 'save' ? '保存中…' : '保存配置'),
      ))
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
