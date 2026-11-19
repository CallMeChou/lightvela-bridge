/**
 * dsh-connect-lightvela — Client UI
 *
 * 设置页里的 LightVela section：填 token、看账号/积分、切通道、测连通。
 */
window.__ModuleLoader__.load({
  id: 'dsh-connect-lightvela',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-connect-lightvela'
    const SECTION_ID = 'lightvela'
    const API = '/api/dsh-connect-lightvela/status'

    const CSS = [
      '.lv-root{display:flex;flex-direction:column;gap:18px;max-width:720px}',
      '.lv-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.lv-title{font-size:16px;font-weight:600}',
      '.lv-sub{font-size:12.5px;line-height:1.6;margin:0;opacity:.72}',
      '.lv-card{border:1px solid var(--dsw-alias-border-default,rgba(0,0,0,.1));border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
      '.lv-label{font-size:12.5px;font-weight:600}',
      '.lv-hint{font-size:11.5px;opacity:.62;line-height:1.65;margin:0}',
      '.lv-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;padding:1px 5px;border-radius:4px;background:rgba(127,127,127,.12);word-break:break-all}',
      '.lv-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.lv-input{flex:1 1 220px;min-width:160px;font:inherit;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-default,rgba(0,0,0,.14));background:transparent;color:inherit;outline:none}',
      '.lv-input:focus{border-color:var(--dsw-alias-border-focus,#6b8afd)}',
      '.lv-btn{font:inherit;font-size:13px;font-weight:500;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-default,rgba(0,0,0,.14));background:transparent;color:inherit;transition:opacity .15s ease}',
      '.lv-btn:hover:not(:disabled){opacity:.8}',
      '.lv-btn:disabled{opacity:.45;cursor:default}',
      '.lv-btn-primary{background:var(--dsw-alias-bg-accent,#4d6bfe);color:#fff;border-color:transparent}',
      '.lv-btn-on{background:rgba(77,107,254,.12);border-color:var(--dsw-alias-bg-accent,#4d6bfe);font-weight:600}',
      '.lv-grid{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px}',
      '.lv-k{opacity:.62}',
      '.lv-v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}',
      '.lv-ok{color:#16a34a}',
      '.lv-err{color:#dc2626}',
      '.lv-msg{font-size:12.5px;padding:8px 10px;border-radius:8px;line-height:1.5;word-break:break-word}',
      '.lv-msg-ok{background:rgba(22,163,74,.10);color:#15803d}',
      '.lv-msg-err{background:rgba(220,38,38,.10);color:#b91c1c}',
      '.lv-msg-info{background:rgba(77,107,254,.10)}',
      '.lv-badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-default,rgba(0,0,0,.12))}',
      '.lv-dot{width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.lv-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.lv-chip{font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-default,rgba(0,0,0,.12));opacity:.85}',
    ].join('\n')

    async function callHost(action, extra) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action }, extra || {})),
      })
      let body = null
      try {
        body = await res.json()
      } catch (e) {
        body = null
      }
      if (!res.ok || !body || body.ok !== true) {
        throw new Error((body && body.error) || 'HTTP ' + res.status)
      }
      return body
    }

    function Panel() {
      const [token, setToken] = React.useState('')
      const [busy, setBusy] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [showToken, setShowToken] = React.useState(false)

      const run = React.useCallback(async function (action, extra) {
        setBusy(action)
        setMessage(null)
        try {
          const body = await callHost(action, extra)
          if (body.status) setStatus(body.status)
          setMessage({ kind: 'ok', text: body.message || '完成' })
          return body
        } catch (e) {
          setMessage({ kind: 'err', text: (e && e.message) || String(e) })
          return null
        } finally {
          setBusy(null)
        }
      }, [])

      React.useEffect(function () {
        let alive = true
        callHost('status')
          .then(function (b) {
            if (!alive) return
            setStatus(b.status)
            if (!b.status || b.status.tokenPresent !== true) {
              setMessage({ kind: 'info', text: '尚未配置 token。填入 LightVela 会话 token 后即可使用。' })
            }
          })
          .catch(function (e) {
            if (alive) setMessage({ kind: 'err', text: '状态读取失败：' + ((e && e.message) || e) })
          })
        return function () {
          alive = false
        }
      }, [])

      const onLogin = function () {
        const v = token.trim()
        if (!v) {
          setMessage({ kind: 'err', text: '请先填入 token。' })
          return
        }
        void run('login', { sessionToken: v })
      }

      const disabled = busy !== null
      const st = status || {}
      const mode = st.mode || 'gateway'

      const row = (k, v) =>
        v === null || v === undefined || v === ''
          ? null
          : [
              h('span', { className: 'lv-k', key: 'k-' + k }, k),
              h('span', { className: 'lv-v', key: 'v-' + k }, String(v)),
            ]

      return h(
        'div',
        { className: 'lv-root' },
        h('style', null, CSS),

        h(
          'div',
          { className: 'lv-head' },
          h('div', { className: 'lv-title' }, 'LightVela'),
          st.connected === true
            ? h('span', { className: 'lv-badge lv-ok' }, h('span', { className: 'lv-dot' }), '已连接')
            : st.connected === false
              ? h('span', { className: 'lv-badge lv-err' }, h('span', { className: 'lv-dot' }), '未连接')
              : null,
          h(
            'span',
            { className: 'lv-badge' },
            mode === 'gateway' ? '网关模式 · 快' : 'Agent 模式 · 带工具',
          ),
        ),

        h(
          'p',
          { className: 'lv-sub' },
          '把 LightVela 作为模型接进 DSH。网关模式直连模型服务（约 2 秒）；Agent 模式在实例内跑完整 Hermes（约 10 秒，带工具与记忆）。',
        ),

        /* ---- 通道 ---- */
        h(
          'div',
          { className: 'lv-card' },
          h('div', { className: 'lv-label' }, '通道'),
          h(
            'div',
            { className: 'lv-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'lv-btn' + (mode === 'gateway' ? ' lv-btn-on' : ''),
                disabled: disabled,
                onClick: function () {
                  if (mode !== 'gateway') void run('setMode', { mode: 'gateway' })
                },
              },
              '网关（快）',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'lv-btn' + (mode === 'agent' ? ' lv-btn-on' : ''),
                disabled: disabled,
                onClick: function () {
                  if (mode !== 'agent') void run('setMode', { mode: 'agent' })
                },
              },
              'Agent（带工具）',
            ),
          ),
          h(
            'p',
            { className: 'lv-hint' },
            '网关模式用实例内的模型凭据直连服务，速度快但只有对话；Agent 模式每次起一个 hermes 进程，能用技能和长期记忆。',
          ),
        ),

        /* ---- token ---- */
        h(
          'div',
          { className: 'lv-card' },
          h('div', { className: 'lv-label' }, '会话 token'),
          h(
            'p',
            { className: 'lv-hint' },
            '在 ',
            h('code', null, 'lightvela.com'),
            ' 已登录页 Console 里跑下面这段，它会自动扫出 token 并复制：',
            h('br'),
            h('code', null, 'copy(localStorage.getItem("lightclaw-auth-token-v1") || sessionStorage.getItem("vela.lightvela.session-token.v1") || "")'),
            h('br'),
            '注意：主站首页写的是 ',
            h('code', null, 'lightclaw-auth-token-v1'),
            '；',
            h('code', null, 'vela.lightvela.session-token.v1'),
            ' 只在 workbench 内嵌场景由宿主注入，浏览器里直接开那个页面查不到值是正常的。',
          ),
          h(
            'div',
            { className: 'lv-row' },
            h('input', {
              className: 'lv-input',
              type: showToken ? 'text' : 'password',
              value: token,
              placeholder: st.tokenPresent === true ? '已保存 token，重新输入可覆盖' : '粘贴 token…',
              spellCheck: false,
              autoComplete: 'off',
              disabled: disabled,
              onChange: function (e) {
                setToken(e.target.value)
              },
              onKeyDown: function (e) {
                if (e.key === 'Enter') onLogin()
              },
            }),
          ),
          h(
            'div',
            { className: 'lv-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'lv-btn lv-btn-primary',
                disabled: disabled || token.trim().length === 0,
                onClick: onLogin,
              },
              busy === 'login' ? '登录中…' : '保存并登录',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'lv-btn',
                disabled: disabled,
                onClick: function () {
                  setShowToken(function (x) {
                    return !x
                  })
                },
              },
              showToken ? '隐藏 token' : '显示 token',
            ),
          ),
        ),

        /* ---- 状态 ---- */
        status !== null &&
          h(
            'div',
            { className: 'lv-card' },
            h('div', { className: 'lv-label' }, '账号与实例'),
            h(
              'div',
              { className: 'lv-grid' },
              row('账号', st.email),
              row('区域', st.region === 'intl' ? 'international' : st.region),
              row('实例', st.instanceId),
              row('实例状态', st.instanceStatus),
              row(
                '积分',
                st.creditAvailable !== null && st.creditAvailable !== undefined
                  ? st.creditAvailable +
                      ' / ' +
                      (st.creditTotal === null || st.creditTotal === undefined ? '?' : st.creditTotal)
                  : null,
              ),
              row('套餐', st.bundleName),
              row('到期', st.expiresAt),
            ),
            Array.isArray(st.models) && st.models.length > 0
              ? h(
                  'div',
                  null,
                  h('div', { className: 'lv-label', style: { marginBottom: 6 } }, '可用模型'),
                  h(
                    'div',
                    { className: 'lv-chips' },
                    st.models.map(function (m) {
                      return h('span', { className: 'lv-chip', key: m }, m)
                    }),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'lv-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'lv-btn',
                  disabled: disabled,
                  onClick: function () {
                    void run('refresh')
                  },
                },
                busy === 'refresh' ? '检查中…' : '刷新状态',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'lv-btn',
                  disabled: disabled,
                  onClick: function () {
                    void run('test')
                  },
                },
                busy === 'test' ? '测试中…' : '测试连通',
              ),
              st.tokenPresent === true
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'lv-btn',
                      disabled: disabled,
                      onClick: function () {
                        void run('logout')
                      },
                    },
                    busy === 'logout' ? '退出中…' : '退出登录',
                  )
                : null,
            ),
          ),

        message && h('div', { className: 'lv-msg lv-msg-' + message.kind }, message.text),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section.icon', function () {
        const off = ctx.slots.register({ name: 'settings.section.icon', id: SECTION_ID }, function (owner) {
          const size = (owner && owner.size) || 16
          return h(
            'svg',
            {
              viewBox: '0 0 64 64',
              width: size,
              height: size,
              'aria-hidden': true,
              style: { display: 'block' },
            },
            h('path', {
              d: 'M32 8c1.8 8.4 6 12.6 14.4 14.4C38 24.2 33.8 28.4 32 36.8 30.2 28.4 26 24.2 17.6 22.4 26 20.6 30.2 16.4 32 8z',
              fill: 'currentColor',
            }),
            h('path', {
              d: 'M32 38c1.1 5 3.6 7.5 8.6 8.6-5 1.1-7.5 3.6-8.6 8.6-1.1-5-3.6-7.5-8.6-8.6 5-1.1 7.5-3.6 8.6-8.6z',
              fill: 'currentColor',
              opacity: 0.68,
            }),
          )
        })
        return typeof off === 'function' ? off : function () {}
      })

      const off = ctx.slots.register(
        {
          name: 'settings.section',
          id: SECTION_ID,
          order: 60,
          label: function () {
            return 'LightVela'
          },
          locale: NS,
        },
        function () {
          return h(Panel)
        },
      )
      return typeof off === 'function' ? off : function () {}
    }

    return { name: NS, inject: inject, apply: apply }
  },
})
