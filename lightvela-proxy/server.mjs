/**
 * LightVela -> OpenAI 兼容反向代理
 *
 * 上游：LightVela Hermes 实例内的 `hermes -z "<prompt>"`（经 debug/exec 执行）
 * 已实测：exit=0，UTF-8 干净，约 6s/次
 *
 * 端点：
 *   GET  /healthz
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream 支持)
 *   GET  /admin/instances
 *   POST /admin/exec            {command, instance?, timeoutMs?, runAs?}
 */

import http from 'node:http';
import { getSession, resolveInstance, debugExec, listInstances, LVError, API_BASE } from './lv-client.mjs';

const PORT = Number(process.env.PORT || 8790);
const TOKEN = (process.env.LV_SESSION_TOKEN || '').trim();
const FIXED_INSTANCE = (process.env.LV_INSTANCE_ID || '').trim();
const RUN_AS = process.env.LV_RUN_AS || 'agentuser';
const MODEL_ID = process.env.LV_MODEL_ID || 'auto';
const HERMES_BIN = process.env.LV_HERMES_BIN || 'hermes';
const EXTRA_ARGS = (process.env.LV_HERMES_ARGS || '').trim(); // 例如 -m gpt-5 --yolo
const DEFAULT_TIMEOUT = Number(process.env.LV_TIMEOUT_MS || 180000);
const DEBUG = process.env.LV_DEBUG === '1';

const log = (...a) => DEBUG && console.log('[lv]', ...a);

if (!TOKEN) {
  console.error('必须设置 LV_SESSION_TOKEN');
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 实例解析
 * ------------------------------------------------------------------ */
let cachedInstance = FIXED_INSTANCE || null;

async function instanceId() {
  if (cachedInstance) return cachedInstance;
  cachedInstance = await resolveInstance(TOKEN, FIXED_INSTANCE || undefined);
  log('instance:', cachedInstance);
  return cachedInstance;
}

/* ------------------------------------------------------------------ *
 * 命令构造
 * 提示词一律 base64 落文件再交给 hermes，彻底规避 shell 与 locale 编码问题
 * ------------------------------------------------------------------ */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function buildCommand(prompt, { timeoutSec = 180, model = '' } = {}) {
  const b64 = Buffer.from(prompt, 'utf8').toString('base64');
  const modelArg = model && model !== MODEL_ID ? ` -m ${shq(model)}` : '';
  const extra = EXTRA_ARGS ? ` ${EXTRA_ARGS}` : '';

  return [
    'export PATH=$HOME/.local/bin:$PATH',
    'cd $HOME',
    `printf %s ${shq(b64)} | base64 -d > /tmp/lv_in.txt`,
    `timeout ${timeoutSec} ${HERMES_BIN}${modelArg}${extra} -z "$(cat /tmp/lv_in.txt)" < /dev/null 2>&1`,
    'rc=$?',
    'rm -f /tmp/lv_in.txt',
    'exit $rc',
  ].join('; ');
}

/* ------------------------------------------------------------------ *
 * 上游调用
 * ------------------------------------------------------------------ */
async function runAgent(prompt, { model = '', timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const id = await instanceId();
  const timeoutSec = Math.max(10, Math.floor(timeoutMs / 1000) - 5);
  const command = buildCommand(prompt, { timeoutSec, model });
  return debugExec(TOKEN, id, command, { timeoutMs, runAs: RUN_AS });
}

/* ------------------------------------------------------------------ *
 * OpenAI messages -> 单条 prompt
 * Hermes 是带记忆的 agent，多轮由实例自己维护；这里把上下文压平传过去
 * ------------------------------------------------------------------ */
function flattenMessages(messages = []) {
  const sys = [];
  const turns = [];
  for (const m of messages) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).filter(Boolean).join('\n')
          : '';
    if (!text) continue;
    if (m.role === 'system' || m.role === 'developer') sys.push(text);
    else if (m.role === 'assistant') turns.push(`Assistant: ${text}`);
    else if (m.role === 'tool') turns.push(`Tool: ${text}`);
    else turns.push(text);
  }
  // 只有一条 user 时直接原样送，保留 Hermes 的原生语义
  const prompt = turns.length === 1 ? turns[0] : turns.join('\n\n');
  return { system: sys.join('\n\n'), prompt };
}

/** 去掉 hermes CLI 可能带的 ANSI / 提示噪音 */
function clean(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/^\s*=== EXIT:.*$/gm, '')
    .trim();
}

function responsesMessages(body) {
  const messages = [];
  if (typeof body.input === 'string' && body.input.trim()) {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || item.type === 'function_call_output') continue;
      const role = item.role || (item.type === 'message' ? 'user' : 'user');
      const content = Array.isArray(item.content)
        ? item.content.map((part) => part?.text ?? part?.value ?? '').filter(Boolean).join('\n')
        : String(item.content ?? item.text ?? '');
      if (content.trim()) messages.push({ role, content });
    }
  }
  if (body.instructions) messages.unshift({ role: 'system', content: String(body.instructions) });
  return messages;
}

function responsePayload(id, created, model, content, r) {
  return {
    id,
    object: 'response',
    created_at: created,
    model,
    status: 'completed',
    output: [{
      id: `${id}-msg`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    }],
    output_text: content,
    usage: {
      input_tokens: Math.ceil((r.inputLength || 0) / 4),
      output_tokens: Math.ceil(content.length / 4),
      total_tokens: Math.ceil(((r.inputLength || 0) + content.length) / 4),
    },
  };
}

/* ------------------------------------------------------------------ *
 * HTTP 基础
 * ------------------------------------------------------------------ */
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid JSON: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (url.pathname === '/bridge/status' && req.method === 'GET') {
    return json(res, 200, { ok: true, bridgeId: process.env.LV_BRIDGE_ID || '', model: MODEL_ID });
  }

  if (url.pathname === '/healthz') {
    try {
      const s = await getSession(TOKEN);
      const u = s?.user ?? s?.session?.user ?? {};
      return json(res, 200, {
        ok: true,
        api: API_BASE,
        user: u.id ?? null,
        email: u.email ?? null,
        instance: cachedInstance,
        runtimeAccess: u.runtimeAccess ?? null,
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, status: e.status, code: e.code });
    }
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    return json(res, 200, {
      object: 'list',
      data: [{ id: MODEL_ID, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'lightvela' }],
    });
  }

  if (url.pathname === '/admin/instances' && req.method === 'GET') {
    try {
      return json(res, 200, { items: await listInstances(TOKEN) });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code });
    }
  }

  if (url.pathname === '/admin/exec' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.command) return json(res, 400, { error: 'command required' });
      const id = body.instance || (await instanceId());
      const r = await debugExec(TOKEN, id, String(body.command), {
        timeoutMs: Number(body.timeoutMs || 60000),
        runAs: body.runAs || RUN_AS,
      });
      return json(res, 200, r);
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code });
    }
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
    }

    const { system, prompt } = flattenMessages(body.messages);
    if (!prompt.trim()) {
      return json(res, 400, { error: { message: 'messages 为空', type: 'invalid_request_error' } });
    }

    const full = system ? `${system}\n\n${prompt}` : prompt;
    const model = body.model || MODEL_ID;
    const stream = body.stream === true;
    const id = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const timeoutMs = Number(body.timeout_ms || DEFAULT_TIMEOUT);

    log('chat', { model, stream, len: full.length });

    try {
      if (!stream) {
        const r = await runAgent(full, { model, timeoutMs });
        const content = clean(r.output);
        return json(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: Math.ceil(full.length / 4),
            completion_tokens: Math.ceil(content.length / 4),
            total_tokens: Math.ceil((full.length + content.length) / 4),
          },
          _lv: { exitCode: r.exitCode, status: r.status },
        });
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      });

      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const delta = (content, finish = null) =>
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
        });

      delta('');
      const r = await runAgent(full, { model, timeoutMs });
      const text = clean(r.output);
      const CHUNK = 20;
      for (let i = 0; i < text.length; i += CHUNK) delta(text.slice(i, i + CHUNK));
      delta(null, 'stop');
      res.write('data: [DONE]\n\n');
      return res.end();
    } catch (e) {
      const status = e instanceof LVError ? e.status || 502 : 502;
      const msg = e?.message || String(e);
      log('error', msg);
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify({ error: { message: msg, type: 'upstream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch {
          /* ignore */
        }
        return res.end();
      }
      return json(res, status, { error: { message: msg, type: 'upstream_error', code: e?.code } });
    }
  }

  if (url.pathname === '/v1/responses' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
    }

    const messages = responsesMessages(body);
    const { system, prompt } = flattenMessages(messages);
    if (!prompt.trim()) {
      return json(res, 400, { error: { message: 'input 为空', type: 'invalid_request_error' } });
    }

    const full = system ? `${system}\n\n${prompt}` : prompt;
    const model = body.model || MODEL_ID;
    const stream = body.stream === true;
    const id = `resp_${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const timeoutMs = Number(body.timeout_ms || DEFAULT_TIMEOUT);

    try {
      const r = await runAgent(full, { model, timeoutMs });
      const content = clean(r.output);
      const result = responsePayload(id, created, model, content, { inputLength: full.length });
      if (!stream) return json(res, 200, result);

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      });
      const event = (type, data) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      event('response.created', { type: 'response.created', response: { ...result, status: 'in_progress', output: [], output_text: '' } });
      event('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: `${id}-msg`, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
      event('response.content_part.added', { type: 'response.content_part.added', item_id: `${id}-msg`, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      const CHUNK = 20;
      for (let i = 0; i < content.length; i += CHUNK) {
        event('response.output_text.delta', { type: 'response.output_text.delta', item_id: `${id}-msg`, output_index: 0, content_index: 0, delta: content.slice(i, i + CHUNK) });
      }
      event('response.output_text.done', { type: 'response.output_text.done', item_id: `${id}-msg`, output_index: 0, content_index: 0, text: content, logprobs: [] });
      event('response.content_part.done', { type: 'response.content_part.done', item_id: `${id}-msg`, output_index: 0, content_index: 0, part: { type: 'output_text', text: content, annotations: [] } });
      event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: result.output[0] });
      event('response.completed', { type: 'response.completed', response: result });
      return res.end();
    } catch (e) {
      const msg = e?.message || String(e);
      return json(res, 502, { error: { message: msg, type: 'upstream_error', code: e?.code } });
    }
  }

  json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LightVela OpenAI proxy  ->  http://127.0.0.1:${PORT}/v1`);
  console.log(`  upstream: ${API_BASE}  |  hermes -z  |  model=${MODEL_ID}`);
});
