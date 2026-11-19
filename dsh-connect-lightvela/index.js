/**
 * dsh-connect-lightvela
 *
 * 把 LightVela 接进 DSH 模型列表。两条通道：
 *
 *   gateway（默认）—— 直连 token.lightvela.com/v1，用实例里的 CUSTOM_API_KEY。
 *     模型就是网关真实模型（auto / deepseek-v4-pro-202606 / …）。实测 ~1.8s。
 *
 *   agent —— 在实例内跑 `hermes -z`，带工具与记忆，但每次冷启动约 10s。
 *
 * 设置页有 LightVela section，可填 token、看账号/积分、切通道、测连通。
 */

import Schema from '@deepseek-ai/schemastery'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  getSession,
  listInstances,
  listPasses,
  debugExec,
  readGatewayCredential,
  listGatewayModels,
  gatewayChat,
  runHermes,
  LightVelaError,
} from './lv-api.js'

export const name = 'dsh-connect-lightvela'

/** 没有 llm 服务就不激活。 */
export const inject = ['llm']

export const PROVIDER = 'lightvela'
const PROVIDER_DISPLAY_NAME = 'LightVela'
const AGENT_MODEL = 'hermes'
const SETTINGS_NS = 'dsh-connect-lightvela'
const CONTEXT_WINDOW = 128_000
const MAX_TOKENS = 8_192

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

export const Config = Schema.object({
  sessionToken: Schema.string()
    .default('')
    .description('LightVela 会话 token。设置页可以直接粘贴，无需手改配置文件。'),
  region: Schema.union([Schema.const('cn'), Schema.const('intl')])
    .default('cn')
    .description('cn=lightvela.com，intl=lightvela.ai'),
  instanceId: Schema.string().default('').description('留空则自动选择第一个 Running 实例'),
  mode: Schema.union([Schema.const('gateway'), Schema.const('agent')])
    .default('gateway')
    .description('gateway=直连模型网关（快，~2s）；agent=实例内 hermes（带工具，~10s）'),
  modelIds: Schema.array(Schema.string())
    .default([])
    .description('对外模型 id；留空则自动取网关模型列表'),
  gatewayBaseUrl: Schema.string().default('').description('网关地址，留空自动从实例读取'),
  timeoutMs: Schema.number().default(180000).description('单次请求超时（毫秒）'),
  runAsUser: Schema.string().default('agentuser').description('debug/exec 的执行用户'),
})

/* ------------------------------------------------------------------ *
 * 状态持久化
 * ------------------------------------------------------------------ */

const STATE_DIR = join(homedir(), '.dsh', 'dsh-connect-lightvela')
const STATE_FILE = join(STATE_DIR, 'state.json')

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeState(patch) {
  const next = { ...(await readState()), ...patch }
  await mkdir(STATE_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await rename(tmp, STATE_FILE)
  return next
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const cleanOutput = (t) => String(t ?? '').replace(ANSI, '').trim()

/** 从 content 数组里取纯文本。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** 从 content 数组里取 tool-call 块。 */
function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b && b.type === 'tool-call')
    .map((b) => ({
      id: String(b.id ?? ''),
      name: String(b.name ?? ''),
      arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}),
    }))
}

/**
 * DSH 消息 → OpenAI chat messages。
 *
 * 三种情况必须映射成原生结构，否则模型看不到工具、也不知道结果：
 *   assistant + tool-call 块  → assistant.tool_calls
 *   role=tool                 → {role:'tool', tool_call_id}
 *   其余                      → {role, content}
 *
 * 之前把所有东西都压成文本，模型只能说"我先查一下"然后停住 —— 因为它
 * 要的 tool_calls 根本没有下发，也没有工具可调。
 */
function toOpenAiMessages(messages, system) {
  const out = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages ?? []) {
    const role = m?.role
    const text = textOf(m?.content)

    if (role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: String(m.toolCallId ?? ''),
        content: text || '(empty)',
      })
      continue
    }

    if (role === 'assistant') {
      const calls = toolCallsOf(m?.content)
      if (calls.length > 0) {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        })
        continue
      }
      if (text) out.push({ role: 'assistant', content: text })
      continue
    }

    if (role === 'system' || role === 'developer') {
      if (text) out.push({ role: 'system', content: text })
      continue
    }

    // user 及其他
    if (text) out.push({ role: 'user', content: text })
  }
  return out
}

/** DSH ToolSchema[] → OpenAI tools[]。 */
function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const mapped = tools
    .filter((t) => t && typeof t.name === 'string' && t.name.length > 0)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: String(t.description ?? ''),
        parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
      },
    }))
  return mapped.length > 0 ? mapped : undefined
}

/**
 * DSH 消息 → 单条纯文本 prompt（只给 agent 通道用）。
 * hermes -z 只接受一段文本，工具调用在这里退化成文字描述。
 */
function toAgentPrompt(messages, system) {
  const turns = []
  for (const m of messages ?? []) {
    const text = textOf(m?.content)
    const calls = toolCallsOf(m?.content)
    if (m?.role === 'tool') {
      turns.push(`Tool result (${String(m.toolCallId ?? '')}): ${text || '(empty)'}`)
      continue
    }
    if (m?.role === 'assistant') {
      if (text) turns.push(`Assistant: ${text}`)
      for (const c of calls) turns.push(`Assistant called tool ${c.name}(${c.arguments})`)
      continue
    }
    if (m?.role === 'system' || m?.role === 'developer') {
      if (text) turns.push(`System: ${text}`)
      continue
    }
    if (text) turns.push(text)
  }
  const body = turns.join('\n\n')
  return system ? `${system}\n\n${body}` : body
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

class LightVelaAdapter {
  constructor(runtime) {
    this.runtime = runtime
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_DISPLAY_NAME }
  }

  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_p, _m, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /**
   * 构造一个模型的目录元数据。
   * DSH 会校验 model.provider === 注册时的 provider，缺了直接抛
   * INVALID_CATALOG（adapter returned invalid or duplicate model metadata）。
   */
  describe(id, provider = PROVIDER) {
    const isAgent = id === AGENT_MODEL
    return {
      provider,
      id,
      name: isAgent ? 'LightVela Hermes (agent)' : `LightVela ${id}`,
      contextWindow: CONTEXT_WINDOW,
      maxTokens: MAX_TOKENS,
      inputModalities: ['text'],
    }
  }

  async listModels(provider) {
    if (provider !== PROVIDER) return []
    const ids = this.runtime.visibleModelIds()
    return ids.map((id) => this.describe(id, provider))
  }

  async resolveModel(provider, model) {
    return this.describe(model, provider)
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options) {
    const { signal, model, system } = options
    const isAgent = this.runtime.mode() === 'agent' || model === AGENT_MODEL

    // agent 通道只能吃纯文本，gateway 通道走原生 messages
    const messages = isAgent
      ? this.runtime.toAgentPrompt(options.messages, system)
      : toOpenAiMessages(options.messages, system)
    const tools = isAgent ? undefined : toOpenAiTools(options.tools)

    const promptGuess = isAgent
      ? messages
      : messages.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n')

    /* ---- 文本块 ---- */
    yield { type: 'block-start', index: 0, blockType: 'text' }

    let text = ''
    /** 上游返回的 tool_calls，按 OpenAI 的 index 累积 */
    const toolAcc = new Map()
    let finishReason = null
    let streamedInline = false

    try {
      if (isAgent) {
        // ---- agent 通道：实例内 hermes ----
        const cred = await this.runtime.credential()
        const instanceId = await this.runtime.instanceId(cred, signal)
        const r = await runHermes(cred, instanceId, messages, {
          signal,
          timeoutMs: this.runtime.timeoutMs(),
        })
        text = cleanOutput(r.output)
        if (r.exitCode !== 0 && !text) {
          throw new LightVelaError(`agent 执行失败（exit ${r.exitCode}）`, 0, 'agent_failed')
        }
      } else {
        // ---- gateway 通道：直连模型网关，流式 ----
        const gw = await this.runtime.gateway(signal)
        const target = this.runtime.pickModel(model, gw)
        const res = await gatewayChat(
          gw,
          {
            model: target,
            messages,
            stream: true,
            // 关键：把 DSH 的工具定义转发上去，否则模型只能说"我先查一下"然后停住
            ...(tools ? { tools } : {}),
            ...(tools ? { tool_choice: 'auto' } : {}),
            // 思考型模型会把 max_tokens 全部耗在 reasoning 上，导致 content 为空；
            // 除非调用方明确指定，否则不设上限。
            ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.stop ? { stop: options.stop } : {}),
          },
          { signal, timeoutMs: this.runtime.timeoutMs() },
        )

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        const pieces = []
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const raw of lines) {
              const line = raw.trim()
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (!data || data === '[DONE]') continue
              let chunk
              try {
                chunk = JSON.parse(data)
              } catch {
                continue
              }
              const choice = chunk?.choices?.[0]
              if (!choice) continue
              if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason

              const delta = choice.delta
              if (!delta) continue

              // 文本
              const piece = delta.content
              if (typeof piece === 'string' && piece.length > 0) {
                pieces.push(piece)
                yield { type: 'text-delta', index: 0, text: piece }
              }

              // 工具调用：name/arguments 也可能分片
              const calls = delta.tool_calls
              if (Array.isArray(calls)) {
                for (const c of calls) {
                  const key = typeof c.index === 'number' ? c.index : 0
                  const slot = toolAcc.get(key) ?? { id: '', name: '', args: '' }
                  if (typeof c.id === 'string' && c.id) slot.id = c.id
                  if (c.function?.name) slot.name += c.function.name
                  if (c.function?.arguments) slot.args += c.function.arguments
                  toolAcc.set(key, slot)
                }
              }
            }
          }
        } finally {
          try {
            await reader.cancel()
          } catch {}
        }
        text = pieces.join('')
        streamedInline = true
      }
    } catch (e) {
      const aborted = e?.name === 'AbortError' || signal?.aborted === true
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message: '已取消', code: 'aborted' } }
          : { kind: 'error', failure: { message: e?.message ?? String(e), code: e?.code || 'PROVIDER_ERROR' } },
      }
      return
    }

    // agent 通道是整段返回：这里切片补发。
    // gateway 通道的 delta 已在流式循环里逐片发过，不能再补，否则内容会翻倍。
    if (!streamedInline) {
      const CHUNK = 32
      for (let i = 0; i < text.length; i += CHUNK) {
        if (signal?.aborted) break
        yield { type: 'text-delta', index: 0, text: text.slice(i, i + CHUNK) }
      }
    }

    const textBlock = { type: 'text', text }
    yield { type: 'block-end', index: 0, block: textBlock }

    /* ---- 工具调用块 ---- */
    const calls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((v) => v.name.length > 0)

    let idx = 1
    for (const c of calls) {
      const id = c.id || `call_${idx}_${Date.now().toString(36)}`
      const args = c.args && c.args.trim().length > 0 ? c.args : '{}'
      yield { type: 'tool-call-delta', index: idx, id, name: c.name, argumentsDelta: args }
      yield {
        type: 'block-end',
        index: idx,
        block: { type: 'tool-call', id, name: c.name, arguments: args },
      }
      idx += 1
    }

    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.ceil(promptGuess.length / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
    }

    // 有工具调用时必须报 tool-calls，DSH 才会真的去执行工具再回来
    if (calls.length > 0) {
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else if (finishReason === 'length') {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    } else {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const resolved = {
    sessionToken: String(config?.sessionToken ?? '').trim(),
    region: config?.region === 'intl' ? 'intl' : 'cn',
    instanceId: String(config?.instanceId ?? '').trim(),
    mode: config?.mode === 'agent' ? 'agent' : 'gateway',
    modelIds: Array.isArray(config?.modelIds) ? config.modelIds.map((m) => String(m).trim()).filter(Boolean) : [],
    gatewayBaseUrl: String(config?.gatewayBaseUrl ?? '').trim(),
    timeoutMs: Number(config?.timeoutMs) > 0 ? Number(config.timeoutMs) : 180000,
    runAsUser: String(config?.runAsUser ?? 'agentuser').trim() || 'agentuser',
  }

  let saved = {}
  let instanceCache = resolved.instanceId || ''
  let gatewayCache = null // { apiKey, baseUrl, models: [], at: number }

  const runtime = {
    timeoutMs: () => resolved.timeoutMs,
    mode: () => resolved.mode,
    toAgentPrompt,

    /** 对外可见的模型 id。gateway 模式下是网关真实模型。 */
    visibleModelIds() {
      if (resolved.mode === 'agent') return [AGENT_MODEL]
      if (resolved.modelIds.length > 0) return resolved.modelIds
      const gw = gatewayCache?.models
      if (Array.isArray(gw) && gw.length > 0) {
        // 过滤掉 mock、test 与部署占位模型。
        const usable = gw.filter((m) => !/mock|test|^ep-/i.test(m))
        if (usable.length > 0) return usable
      }
      return [AGENT_MODEL]
    },

    /**
     * 选实际下发的模型。
     * agent 通道的占位 id `hermes` 需要映射到网关真模型。
     */
    pickModel(model, gw) {
      const available = Array.isArray(gw?.models) ? gw.models : []
      const usable = available.filter((m) => !/mock|test|^ep-/i.test(m))
      if (model && model !== AGENT_MODEL && usable.includes(model)) return model
      // 优先 deepseek-v4-pro：实测比 auto 快一倍
      const preferred = usable.find((m) => /deepseek/i.test(m))
      return preferred ?? usable[0] ?? 'auto'
    },

    async credential() {
      const token = resolved.sessionToken || String(saved.sessionToken ?? '')
      if (!token) {
        throw new LightVelaError('未配置 LightVela token，请在设置页填入会话 token。', 0, 'MISSING_CREDENTIAL')
      }
      return { token, region: saved.region === 'intl' || saved.region === 'cn' ? saved.region : resolved.region }
    },

    async instanceId(cred, signal) {
      if (instanceCache) return instanceCache
      const list = await listInstances(cred, signal)
      if (list.length === 0) throw new LightVelaError('账号下没有 LightVela 实例', 0, 'no_instance')
      const running = list.filter((i) => /^(running|active|ready)$/i.test(String(i.status ?? '')))
      const pick = (running.length > 0 ? running : list)[0]
      instanceCache = String(pick.instance_id ?? pick.id ?? '')
      return instanceCache
    },

    /** 取网关凭据（缓存 10 分钟）。models 为空时不缓存，下次重取。 */
    async gateway(signal) {
      const fresh =
        gatewayCache &&
        Date.now() - gatewayCache.at < 10 * 60 * 1000 &&
        (gatewayCache.models?.length ?? 0) > 0
      if (fresh) return gatewayCache

      const cred = await this.credential()
      const instanceId = await this.instanceId(cred, signal)
      const gw = await readGatewayCredential(cred, instanceId, { signal })
      const baseUrl = resolved.gatewayBaseUrl || gw.baseUrl
      let models = []
      let lastErr = null
      try {
        models = await listGatewayModels({ apiKey: gw.apiKey, baseUrl }, { signal })
      } catch (e) {
        lastErr = e
        models = []
      }
      gatewayCache = { apiKey: gw.apiKey, baseUrl, models, at: Date.now() }
      if (models.length > 0) {
        ctx.logger?.info?.(`dsh-connect-lightvela: 网关模型 ${models.join(', ')}`)
      } else {
        ctx.logger?.warn?.(
          `dsh-connect-lightvela: 模型列表为空${lastErr ? `（${lastErr.message}）` : ''}，将重试`,
        )
      }
      return gatewayCache
    },
  }

  const adapter = new LightVelaAdapter(runtime)

  // provider 路由 + 配置目录
  ctx.effect(() => {
    const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], adapter)
    const releaseDirectory = ctx.llm.registerConfigurableProviders([
      {
        provider: PROVIDER,
        displayName: PROVIDER_DISPLAY_NAME,
        settingsNs: SETTINGS_NS,
        settingsPath: [],
        declared: false,
      },
    ])
    return () => {
      try {
        releaseAdapter?.()
      } catch {}
      try {
        releaseDirectory?.()
      } catch {}
    }
  })

  // 模型发现：预热网关并广播
  ctx.effect(() => {
    if (typeof ctx.llm.registerModelDiscovery !== 'function') return () => {}
    const release = ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request, signal) => {
      if (request?.provider !== PROVIDER) return []
      try {
        if (resolved.mode === 'gateway') {
          const gw = await runtime.gateway(signal)
          const ids = resolved.modelIds.length > 0 ? resolved.modelIds : gw.models
          if (ids.length > 0) return ids.map((id) => adapter.describe(id))
        }
        await runtime.credential()
        return runtime.visibleModelIds().map((id) => adapter.describe(id))
      } catch (e) {
        ctx.logger?.warn?.(`dsh-connect-lightvela: 模型发现失败：${e?.message ?? e}`)
        return []
      }
    })
    return () => {
      try {
        release?.()
      } catch {}
    }
  })

  // 启动即预热：让模型列表尽快出现
  void readState()
    .then((state) => {
      saved = state
      if (typeof state?.instanceId === 'string' && state.instanceId) instanceCache = state.instanceId
      if (state?.region === 'cn' || state?.region === 'intl') resolved.region = state.region
      if (state?.mode === 'agent' || state?.mode === 'gateway') resolved.mode = state.mode
    })
    .then(() => {
      if (resolved.mode !== 'gateway') return
      return runtime
        .gateway()
        .then(() => {
          ctx.logger?.info?.(
            `dsh-connect-lightvela: 网关就绪，模型 ${runtime.visibleModelIds().join(', ')}`,
          )
          ctx.emit?.('llm/models-updated', PROVIDER)
        })
        .catch((e) => {
          ctx.logger?.warn?.(`dsh-connect-lightvela: 网关预热失败：${e?.message ?? e}`)
        })
    })
    .catch(() => {})

  /* ---------------------------------------------------------------- *
   * 状态汇总
   * ---------------------------------------------------------------- */
  async function collectStatus() {
    const token = resolved.sessionToken || String(saved.sessionToken ?? '')
    const base = {
      tokenPresent: token.length > 0,
      connected: false,
      region: resolved.region,
      mode: resolved.mode,
      email: null,
      userId: null,
      instanceId: instanceCache || null,
      instanceStatus: null,
      creditAvailable: null,
      creditTotal: null,
      bundleName: null,
      expiresAt: null,
      models: runtime.visibleModelIds(),
      gatewayReady: !!gatewayCache,
    }
    if (!token) return base

    try {
      const cred = await runtime.credential()
      const session = await getSession(cred)
      const user = session?.session?.user ?? session?.user ?? {}
      base.email = user.email ?? null
      base.userId = user.id ?? null
      base.connected = true

      const insts = await listInstances(cred)
      const inst = insts.find((i) => String(i.instance_id ?? i.id) === instanceCache) ?? insts[0]
      if (inst) {
        base.instanceId = String(inst.instance_id ?? inst.id ?? '')
        base.instanceStatus = String(inst.status ?? '')
        if (!instanceCache && base.instanceId) instanceCache = base.instanceId
      }

      const pass = (await listPasses(cred))[0]
      if (pass) {
        base.creditAvailable = pass.credit_available ?? null
        base.creditTotal = pass.credit_total ?? null
        base.bundleName = pass.bundle_name ?? null
        base.expiresAt = pass.expired_time ?? null
      }

      if (resolved.mode === 'gateway') {
        const gw = await runtime.gateway()
        base.gatewayReady = true
        base.models = runtime.visibleModelIds()
        void gw
      }
    } catch (e) {
      base.connected = false
      base.error = e?.message ?? String(e)
    }
    return base
  }

  /* ---------------------------------------------------------------- *
   * HTTP 路由
   * ---------------------------------------------------------------- */
  ctx.inject(['webServer'], (child) => {
    const PATH = '/api/dsh-connect-lightvela/status'

    const send = (res, code, obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    }

    const readJson = (req) =>
      new Promise((resolve) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 256 * 1024) {
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (!raw) return resolve({})
          try {
            resolve(JSON.parse(raw))
          } catch {
            resolve({})
          }
        })
        req.on('error', () => resolve({}))
      })

    child.effect(() => {
      const off = child.webServer.register({
        kind: 'exact',
        path: PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
          const body = await readJson(req)
          const action = String(body?.action ?? 'status')

          try {
            if (action === 'login') {
              const token = String(body?.sessionToken ?? '').trim()
              if (!token) return send(res, 400, { ok: false, error: 'token 不能为空' })
              try {
                await getSession({ token, region: resolved.region })
              } catch (e) {
                return send(res, 400, { ok: false, error: `token 校验失败：${e?.message ?? e}` })
              }
              resolved.sessionToken = token
              saved = await writeState({ sessionToken: token, region: resolved.region })
              instanceCache = resolved.instanceId || ''
              gatewayCache = null
              const status = await collectStatus()
              return send(res, 200, {
                ok: true,
                message: status.email ? `已登录：${status.email}` : '已保存 token',
                status,
              })
            }

            if (action === 'logout') {
              resolved.sessionToken = ''
              saved = await writeState({ sessionToken: '' })
              instanceCache = resolved.instanceId || ''
              gatewayCache = null
              return send(res, 200, { ok: true, message: '已退出', status: await collectStatus() })
            }

            if (action === 'setMode') {
              const m = body?.mode === 'agent' ? 'agent' : 'gateway'
              resolved.mode = m
              saved = await writeState({ mode: m })
              gatewayCache = null
              ctx.emit?.('llm/models-updated', PROVIDER)
              return send(res, 200, {
                ok: true,
                message: m === 'gateway' ? '已切到网关模式（快）' : '已切到 agent 模式（带工具，较慢）',
                status: await collectStatus(),
              })
            }

            if (action === 'test') {
              const status = await collectStatus()
              if (!status.tokenPresent) return send(res, 200, { ok: true, message: '未配置 token', status })
              if (status.connected !== true) {
                return send(res, 200, { ok: true, message: `连接失败：${status.error ?? '未知错误'}`, status })
              }
              const t0 = Date.now()
              if (resolved.mode === 'gateway') {
                const gw = await runtime.gateway()
                const target = runtime.pickModel('auto', gw)
                const res2 = await gatewayChat(
                  gw,
                  {
                    // 不设 max_tokens：思考型模型会把它全耗在 reasoning 上，content 为空
                    model: target,
                    messages: [{ role: 'user', content: '只回复两个字：正常' }],
                  },
                  { timeoutMs: resolved.timeoutMs },
                )
                const j = await res2.json()
                const msgObj = j?.choices?.[0]?.message ?? {}
                const txt = String(msgObj.content ?? '').trim()
                const reasoningLen = String(msgObj.reasoning_content ?? '').length
                return send(res, 200, {
                  ok: true,
                  message: txt
                    ? `网关正常（${Date.now() - t0} ms，模型 ${j?.model ?? target}），回复：${txt}`
                    : `网关有响应但 content 为空（${Date.now() - t0} ms，模型 ${j?.model ?? target}，思考 ${reasoningLen} 字）`,
                  status: await collectStatus(),
                })
              }
              const cred = await runtime.credential()
              const instanceId = await runtime.instanceId(cred)
              const r = await runHermes(cred, instanceId, '只回复两个字：正常', { timeoutMs: resolved.timeoutMs })
              return send(res, 200, {
                ok: true,
                message:
                  r.exitCode === 0
                    ? `agent 正常（${Date.now() - t0} ms），回复：${cleanOutput(r.output) || '(空)'}`
                    : `agent 退出码 ${r.exitCode}（${Date.now() - t0} ms）`,
                status: await collectStatus(),
              })
            }

            return send(res, 200, { ok: true, status: await collectStatus() })
          } catch (e) {
            return send(res, 500, { ok: false, error: e?.message ?? String(e) })
          }
        },
      })
      return () => {
        try {
          off?.()
        } catch {}
      }
    }, 'dsh-connect-lightvela: http route')
  })

  /* ---------------------------------------------------------------- *
   * agent 工具
   * ---------------------------------------------------------------- */
  ctx.effect(() => {
    let release
    try {
      const tools = ctx.get?.('tools')
      if (!tools || typeof tools.register !== 'function') return () => {}
      release = tools.register({
        name: 'lightvela_status',
        description:
          '查看或设置 LightVela 连接：传入 sessionToken 登录；mode 切通道（gateway=快/agent=带工具）；不传则返回状态。',
        parameters: {
          type: 'object',
          properties: {
            sessionToken: { type: 'string', description: 'LightVela 会话 token' },
            mode: { type: 'string', enum: ['gateway', 'agent'], description: '通道' },
          },
        },
        async execute(args) {
          const incoming = String(args?.sessionToken ?? '').trim()
          if (incoming) {
            resolved.sessionToken = incoming
            saved = await writeState({ sessionToken: incoming, region: resolved.region })
            instanceCache = resolved.instanceId || ''
            gatewayCache = null
          }
          if (args?.mode === 'agent' || args?.mode === 'gateway') {
            resolved.mode = args.mode
            saved = await writeState({ mode: args.mode })
          }
          return collectStatus()
        },
      })
    } catch (e) {
      ctx.logger?.debug?.(`dsh-connect-lightvela: 状态工具未注册：${e?.message ?? e}`)
      return () => {}
    }
    return () => {
      try {
        release?.()
      } catch {}
    }
  })
}
