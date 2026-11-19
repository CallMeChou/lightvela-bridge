if (process.env.LV_ALLOW_LIVE_TESTS !== '1' || !process.env.LV_SESSION_TOKEN) throw new Error('Manual live test: set LV_ALLOW_LIVE_TESTS=1 and LV_SESSION_TOKEN first; requests may consume credits.');
/**
 * 真实场景复现：带 DSH 风格工具集，问一个需要查证的问题。
 * 验证模型会真的发起工具调用并能在拿到结果后继续，而不是说一句就停。
 */
const TOKEN = (process.env.LV_SESSION_TOKEN || '').trim()
const mod = await import('./index.js')

let adapter = null
const ctx = {
  logger: { debug() {}, warn() {}, info() {}, error() {} },
  effect(fn) { fn() },
  inject(_s, cb) { cb({ effect(fn) { fn() }, webServer: { register() { return () => {} } } }) },
  emit() {},
  get: () => undefined,
  llm: {
    registerAdapter(_p, a) { adapter = a; return () => {} },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
  },
}
mod.apply(ctx, mod.Config({
  sessionToken: TOKEN, region: 'cn', mode: 'gateway',
  instanceId: (process.env.LV_INSTANCE_ID || ''),
}))
await new Promise((r) => setTimeout(r, 3000))

const models = (await adapter.listModels('lightvela')).map((m) => m.id)
const model = models.find((m) => /deepseek/i.test(m)) ?? models[0]

// 接近 DSH 真实工具集的最小版本
const tools = [
  {
    name: 'web_search',
    description: 'Search the web for current information. Use when the answer needs up-to-date facts.',
    parameters: {
      type: 'object',
      properties: {
        queries: { type: 'array', items: { type: 'string' }, description: 'Search queries' },
      },
      required: ['queries'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a specific URL and return its text content.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
]

const question = 'GitHub 是什么？请查询官方说明后回答。'

console.log('模型:', model)
console.log('问题:', question)
console.log('\n=== 第 1 轮 ===')

let lastMsgs = [{ role: 'user', content: question }]
let round = 0
let allText = []
let calledTools = []

while (round < 4) {
  round++
  const calls = []
  let txt = ''
  let fin = null
  for await (const c of adapter.stream({
    provider: 'lightvela', model, tools, messages: lastMsgs,
  })) {
    if (c.type === 'text-delta') txt += c.text
    if (c.type === 'block-end' && c.block?.type === 'tool-call') calls.push(c.block)
    if (c.type === 'finish') fin = c.reason
  }
  const kind = fin?.kind
  console.log(`\n[round ${round}] finish=${kind} text=${JSON.stringify(txt.slice(0, 100))}`)
  if (txt.trim()) allText.push(txt.trim())

  if (kind !== 'tool-calls' || calls.length === 0) {
    console.log('  → 无工具调用，结束')
    break
  }

  // 模拟工具执行
  for (const c of calls) {
    calledTools.push(c.name)
    let result = ''
    try {
      const args = JSON.parse(c.arguments || '{}')
      if (c.name === 'web_search') {
        result = JSON.stringify({
          results: [
            { title: 'NapCat - 一个基于 NTQQ 的 QQ 机器人框架', url: 'https://napneko.github.io/' },
            { title: 'NapCatQQ 支持微信吗？', snippet: 'NapCat 主要面向 QQ，微信支持不在其官方范围内。' },
          ],
        })
      } else {
        result = 'NapCat 是 QQ 机器人框架，不支持微信。'
      }
    } catch (e) {
      result = `error: ${e.message}`
    }
    console.log(`  → 调用 ${c.name}(${c.arguments})`)

    lastMsgs = [
      ...lastMsgs,
      { role: 'assistant', content: [{ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments }] },
      { role: 'tool', toolCallId: c.id, content: result },
    ]
  }
}

console.log('\n=== 结果 ===')
console.log('调用过的工具:', calledTools.join(', ') || '(无)')
console.log('最终回答:', allText.at(-1)?.slice(0, 400))

const ok =
  calledTools.length > 0 &&
  allText.length > 0 &&
  !/我先|让我先|稍等|马上/.test(allText.at(-1) ?? '')
console.log('\n' + (ok ? 'PASS' : 'FAIL') + ' 工具调用 + 最终回答完整')
console.log('轮次:', round)
