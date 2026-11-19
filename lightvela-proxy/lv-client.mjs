/**
 * LightVela 下游客户端
 * 复刻前端 http-repositories.ts 的真实调用链：
 *   Authorization: Bearer <sessionToken>   (来自 localStorage['lightclaw-auth-token-v1'])
 *   BASE = https://api.lightvela.com
 *   POST /v1/instances/{id}/debug/exec  {command, run_as_user:"agentuser"}
 */

export const API_BASE = process.env.LV_API_BASE || 'https://api.lightvela.com';
export const WEB_ORIGIN = process.env.LV_WEB_ORIGIN || 'https://lightvela.com';

export class LVError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'LVError';
    this.status = status;
    this.code = code;
  }
}

export function tokenFromEnv() {
  const t = (process.env.LV_SESSION_TOKEN || '').trim();
  return t || null;
}

export function headers(token, extra = {}) {
  const h = {
    accept: 'application/json',
    origin: WEB_ORIGIN,
    referer: `${WEB_ORIGIN}/`,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    ...extra,
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function parseErr(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  const code = (body?.code || body?.error || '').toString().trim();
  const rid = (body?.request_id || body?.requestId || res.headers.get('x-request-id') || '').toString().trim();
  const msg = (body?.message || body?.error || `HTTP ${res.status}`).toString().trim();
  return new LVError(rid ? `${msg} (${code || 'error'}, request_id=${rid})` : msg, res.status, code);
}

/** 通用请求，自动补 Bearer */
export async function api(path, { method = 'GET', token, body, signal, raw = false } = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const init = {
    method,
    headers: headers(token, body === undefined ? {} : { 'content-type': 'application/json' }),
    signal,
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  if (!res.ok) throw await parseErr(res);
  if (raw) return res;
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** GET /auth/session —— 验证 token + 拿 user / runtimeAccess */
export async function getSession(token) {
  return api('/auth/session', { token });
}

/** GET /v1/instances —— 列出实例（每项含 instance_id / status） */
export async function listInstances(token) {
  const r = await api('/v1/instances', { token });
  // Current LightVela control-plane envelope (same as the DSH client).
  // Keep legacy envelopes readable, but never report unknown payloads as empty.
  if (Array.isArray(r?.data?.items)) return r.data.items;
  if (Array.isArray(r?.items)) return r.items;
  if (Array.isArray(r?.data)) return r.data;
  if (Array.isArray(r)) return r;
  throw new LVError('实例列表返回格式无法识别，请更新工具后重试', 502, 'invalid_instance_response');
}

/** GET /v1/instances/{id}/bots */
export async function listBots(token, instanceId) {
  const r = await api(`/v1/instances/${encodeURIComponent(instanceId)}/bots`, { token });
  return Array.isArray(r?.items) ? r.items : [];
}

/**
 * POST /v1/instances/{id}/debug/exec
 * 前端：createDebugExecRequestBody(command) -> {command, run_as_user:"agentuser"}
 * 返回 { status, exitCode, output }；details 里带时优先用 details
 */
export async function debugExec(token, instanceId, command, { timeoutMs = 120000, runAs = 'agentuser' } = {}) {
  const ac = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${API_BASE}/v1/instances/${encodeURIComponent(instanceId)}/debug/exec`, {
      method: 'POST',
      headers: headers(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ command, run_as_user: runAs }),
      signal: ac.signal,
    });

    let json = null;
    try {
      json = await res.json();
    } catch {
      /* 可能是空 body，details 已足够 */
    }

    const d = json?.details;
    if (d && (typeof d.output === 'string' || typeof d.exit_code === 'number')) {
      return {
        status: d.status ?? '',
        exitCode: typeof d.exit_code === 'number' ? d.exit_code : -1,
        output: d.output ?? '',
      };
    }
    if (!res.ok) {
      const code = (json?.code || json?.error || '').toString().trim();
      const msg = (json?.message || json?.error || `HTTP ${res.status}`).toString().trim();
      throw new LVError(msg, res.status, code);
    }
    const w = json?.data ?? {};
    return {
      status: w.status ?? '',
      exitCode: typeof w.exit_code === 'number' ? w.exit_code : -1,
      output: w.output ?? '',
    };
  } catch (e) {
    if (e?.name === 'AbortError') throw new LVError(`debug_exec_timeout:${timeoutMs}`, 0, 'timeout');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 选一个可用实例（Running/active/ready 优先） */
export async function resolveInstance(token, wanted) {
  const insts = await listInstances(token);
  if (!insts.length) throw new LVError('账号下没有可用实例', 0, 'no_instance');
  const ok = insts.filter((i) => /^(running|active|ready)$/i.test(String(i.status ?? '')));
  const pool = ok.length ? ok : insts;
  if (wanted) {
    const hit = insts.find((i) => i.instance_id === wanted || i.id === wanted);
    if (!hit) throw new LVError(`指定实例不存在: ${wanted}`, 0, 'instance_not_found');
    return hit.instance_id ?? hit.id;
  }
  return pool[0].instance_id ?? pool[0].id;
}
