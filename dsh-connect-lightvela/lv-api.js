/**
 * LightVela 上游客户端
 *
 * 两条路径：
 *
 *   FAST（默认）—— 直连 LightVela 的模型网关 token.lightvela.com/v1，
 *     用实例 .hermes/.env 里的 CUSTOM_API_KEY。实测 1.8s。
 *
 *   AGENT —— 在实例内跑 `hermes -z`，能带工具/技能/记忆，但每次冷启动
 *     约 10s。用于需要真实 agent 行为的场景。
 *
 * 鉴权（控制面）：Authorization: Bearer <sessionToken>
 * 执行面：POST /v1/instances/{id}/debug/exec  {command, run_as_user:"agentuser"}
 */

export const LV_API_CN = 'https://api.lightvela.com'
export const LV_API_INTL = 'https://api.lightvela.ai'
export const LV_WEB_CN = 'https://lightvela.com'
export const LV_WEB_INTL = 'https://lightvela.ai'
export const LV_GATEWAY = 'https://token.lightvela.com/v1'

export class LightVelaError extends Error {
  constructor(message, status = 0, code = '') {
    super(message)
    this.name = 'LightVelaError'
    this.status = status
    this.code = code
  }
}

export function apiBaseOf(region) {
  return region === 'intl' ? LV_API_INTL : LV_API_CN
}

function baseHeaders(origin, token) {
  const h = {
    accept: 'application/json',
    origin,
    referer: `${origin}/`,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  }
  if (token) h.authorization = `Bearer ${token}`
  return h
}

async function failureOf(res) {
  let body = null
  try {
    body = await res.json()
  } catch {
    /* body may be empty */
  }
  const code = String(body?.code ?? body?.error ?? '').trim()
  const rid = String(body?.request_id ?? body?.requestId ?? res.headers.get('x-request-id') ?? '').trim()
  const raw = body?.message ?? body?.error
  let msg =
    typeof raw === 'string' && raw.trim()
      ? raw.trim()
      : raw && typeof raw === 'object'
        ? String(raw.message ?? JSON.stringify(raw))
        : `HTTP ${res.status}`

  // 429：上游 RPM 限流（实测 60 次/分钟）
  if (res.status === 429) {
    const retry = res.headers.get('retry-after')
    msg = retry
      ? `上游限流（每分钟 60 次），请 ${retry}s 后重试`
      : '上游限流（每分钟 60 次），请稍后重试'
  }

  return new LightVelaError(rid ? `${msg} (${code || 'error'}, request_id=${rid})` : msg, res.status, code || (res.status === 429 ? 'RATE_LIMIT' : ''))
}

/** 一次控制面 API 调用。 */
export async function lvApi(
  { region, token },
  path,
  { method = 'GET', body, signal, timeoutMs = 60_000 } = {},
) {
  const origin = region === 'intl' ? LV_WEB_INTL : LV_WEB_CN
  const base = apiBaseOf(region)
  const ac = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  const init = { method, headers: baseHeaders(origin, token), signal: ac, cache: 'no-store' }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let res
  try {
    res = await fetch(`${base}${path}`, init)
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new LightVelaError(`请求超时：${path}`, 0, 'timeout')
    }
    throw new LightVelaError(`网络错误：${e?.message ?? e}`, 0, 'network')
  }
  if (!res.ok) throw await failureOf(res)
  if (res.status === 204) return null
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

export function getSession(cred, signal) {
  return lvApi(cred, '/auth/session', { signal })
}

export async function listInstances(cred, signal) {
  const r = await lvApi(cred, '/v1/instances', { signal })
  return Array.isArray(r?.data?.items) ? r.data.items : []
}

export async function listPasses(cred, signal) {
  const r = await lvApi(cred, '/v1/passes', { signal })
  return Array.isArray(r?.data?.passes) ? r.data.passes : []
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** 在实例内执行命令，返回 { status, exitCode, output }。 */
export async function debugExec(cred, instanceId, command, { signal, timeoutMs = 180_000, runAs = 'agentuser' } = {}) {
  const origin = cred.region === 'intl' ? LV_WEB_INTL : LV_WEB_CN
  const base = apiBaseOf(cred.region)
  const ac = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)

  let res
  try {
    res = await fetch(`${base}/v1/instances/${encodeURIComponent(instanceId)}/debug/exec`, {
      method: 'POST',
      headers: { ...baseHeaders(origin, cred.token), 'content-type': 'application/json' },
      body: JSON.stringify({ command, run_as_user: runAs }),
      signal: ac,
    })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new LightVelaError(`执行超时（${timeoutMs}ms）`, 0, 'exec_timeout')
    }
    throw new LightVelaError(`执行请求失败：${e?.message ?? e}`, 0, 'network')
  }

  let json = null
  try {
    json = await res.json()
  } catch {
    /* details may be absent */
  }

  const d = json?.details
  if (d && (typeof d.output === 'string' || typeof d.exit_code === 'number')) {
    return {
      status: String(d.status ?? ''),
      exitCode: typeof d.exit_code === 'number' ? d.exit_code : -1,
      output: String(d.output ?? ''),
    }
  }
  if (!res.ok) throw await failureOf(res)

  const w = json?.data ?? {}
  return {
    status: String(w.status ?? ''),
    exitCode: typeof w.exit_code === 'number' ? w.exit_code : -1,
    output: String(w.output ?? ''),
  }
}

/* ------------------------------------------------------------------ *
 * 网关：读实例里的 CUSTOM_API_KEY 与可用模型
 * ------------------------------------------------------------------ */

/**
 * 从实例读取网关凭据。
 * 返回 { apiKey, baseUrl, models: [] }。
 */
export async function readGatewayCredential(cred, instanceId, { signal, timeoutMs = 60_000 } = {}) {
  const cmd = [
    'cd $HOME',
    `K=$(grep -E '^CUSTOM_API_KEY=' .hermes/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \\r')`,
    `B=$(grep -E '^CUSTOM_BASE_URL=' .hermes/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \\r')`,
    'printf "KEY=%s\\n" "$K"',
    'printf "BASE=%s\\n" "$B"',
  ].join('; ')

  const r = await debugExec(cred, instanceId, cmd, { signal, timeoutMs })
  const out = String(r.output ?? '')
  const key = /^KEY=(.+)$/m.exec(out)?.[1]?.trim() ?? ''
  const base = /^BASE=(.+)$/m.exec(out)?.[1]?.trim() ?? ''
  if (!key) {
    throw new LightVelaError(
      '实例里没有 CUSTOM_API_KEY，无法走快速通道。请改用 agent 模式。',
      0,
      'NO_GATEWAY_KEY',
    )
  }
  return { apiKey: key, baseUrl: base || LV_GATEWAY }
}

/** 列出网关支持的模型。 */
export async function listGatewayModels({ apiKey, baseUrl }, { signal, timeoutMs = 30_000 } = {}) {
  const ac = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: ac,
    })
  } catch (e) {
    throw new LightVelaError(`网关模型列表失败：${e?.message ?? e}`, 0, 'gateway_network')
  }
  if (!res.ok) throw await failureOf(res)
  const j = await res.json()
  return Array.isArray(j?.data) ? j.data.map((m) => String(m?.id ?? '')).filter(Boolean) : []
}

/**
 * 直连网关做一次 chat completion（流式）。
 * 返回原始 Response，由调用方读 SSE。
 */
export async function gatewayChat(
  { apiKey, baseUrl },
  payload,
  { signal, timeoutMs = 180_000 } = {},
) {
  const ac = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: ac,
    })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new LightVelaError(`网关超时（${timeoutMs}ms）`, 0, 'gateway_timeout')
    }
    throw new LightVelaError(`网关请求失败：${e?.message ?? e}`, 0, 'gateway_network')
  }
  if (!res.ok) throw await failureOf(res)
  return res
}

/** 把提示词交给实例内的 hermes（agent 模式）。 */
export async function runHermes(cred, instanceId, prompt, { signal, timeoutMs = 180_000, model = '', extraArgs = '' } = {}) {
  const b64 = Buffer.from(prompt, 'utf8').toString('base64')
  const timeoutSec = Math.max(10, Math.floor(timeoutMs / 1000) - 5)
  const modelArg = model ? ` -m ${shellQuote(model)}` : ''
  const extra = extraArgs ? ` ${extraArgs}` : ''

  const command = [
    'export PATH=$HOME/.local/bin:$PATH',
    'cd $HOME',
    `printf %s ${shellQuote(b64)} | base64 -d > /tmp/dsh_lv_in.txt`,
    `timeout ${timeoutSec} hermes${modelArg}${extra} -z "$(cat /tmp/dsh_lv_in.txt)" < /dev/null 2>&1`,
    'rc=$?',
    'rm -f /tmp/dsh_lv_in.txt',
    'exit $rc',
  ].join('; ')

  return debugExec(cred, instanceId, command, { signal, timeoutMs })
}
