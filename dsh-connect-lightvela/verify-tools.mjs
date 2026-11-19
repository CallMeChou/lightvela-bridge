if (process.env.LV_ALLOW_LIVE_TESTS !== '1' || !process.env.LV_SESSION_TOKEN) throw new Error('Manual live test: set LV_ALLOW_LIVE_TESTS=1 and LV_SESSION_TOKEN first; requests may consume credits.');
/**
 * 工具调用端到端：验证 tools 转发 + tool_calls 解析 + finish=tool-calls
 */
const TOKEN = (process.env.LV_SESSION_TOKEN || '').trim()
const mod = await import('./index.js')

let adapter = null
const ctx = {
  logger: { debug() {}, warn() {}, info() {}, error() {} },
  effect(fn) { fn() },
  inject(_s, cb) {
    cb({ effect(fn) { fn() }, webServer: { register() { return () => {} } } })
  },
  emit() {},
  get: () => undefined,
  llm: {
    registerAdapter(_p, a) { adapter = a; return () => {} },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
  },
}

mod.apply(ctx, mod.Config({
  sessionToken: TOKEN,
  region: 'cn',
  mode: 'gateway',
  instanceId: (process.env.LV_INSTANCE_ID || ''),
}))

await new Promise((r) => setTimeout(r, 3000))

const results = []
const ck = (n, ok, d = '') => {
  results.push({ n, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`)
}

const models = (await adapter.listModels('lightvela')).map((m) => m.id)
const model = models.find((m) => /deepseek/i.test(m)) ?? models[0]

// 一个模型必然会想调用的工具
const tools = [
  {
    name: 'web_search',
    description: '搜索网页，返回结果列表。需要查最新信息时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_time',
    description: '获取当前时间',
    parameters: { type: 'object', properties: {} },
  },
]

console.log(`模型: ${model}`)
console.log('\n=== 第一轮：期望模型发起工具调用 ===')
const chunks1 = []
let text1 = ''
const callBlocks = []
for await (const c of adapter.stream({
  provider: 'lightvela',
  model,
  tools,
  messages: [{ role: 'user', content: '现在几点了？必须用 get_time 工具查，不要猜。' }],
})) {
  chunks1.push(c)
  if (c.type === 'text-delta') text1 += c.text
  if (c.type === 'block-end' && c.block?.type === 'tool-call') callBlocks.push(c.block)
}

const fin1 = chunks1.at(-1)
console.log('chunk 类型:', chunks1.map((c) => c.type).join(' -> '))
console.log('文本:', JSON.stringify(text1))
console.log('工具调用块:', JSON.stringify(callBlocks, null, 2))

ck('第一轮有 tool-call 块', callBlocks.length > 0, `${callBlocks.length} 个`)
ck('finish 为 tool-calls', fin1?.reason?.kind === 'tool-calls', fin1?.reason?.kind)
if (callBlocks.length > 0) {
  const b = callBlocks[0]
  ck('tool-call 有 name', typeof b.name === 'string' && b.name.length > 0, b.name)
  ck('tool-call 有 id', typeof b.id === 'string' && b.id.length > 0, b.id)
  ck('arguments 是合法 JSON', (() => {
    try {
      JSON.parse(b.arguments)
      return true
    } catch {
      return false
    }
  })(), b.arguments)
}

console.log('\n=== 第二轮：喂回工具结果，期望模型给出最终回答 ===')
if (callBlocks.length > 0) {
  const b = callBlocks[0]
  const chunks2 = []
  let text2 = ''
  for await (const c of adapter.stream({
    provider: 'lightvela',
    model,
    tools,
    messages: [
      { role: 'user', content: '现在几点了？必须用 get_time 工具查，不要猜。' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: b.id, name: b.name, arguments: b.arguments },
        ],
      },
      {
        role: 'tool',
        toolCallId: b.id,
        content: '2026-11-18 16:20:00 +08:00',
      },
    ],
  })) {
    chunks2.push(c)
    if (c.type === 'text-delta') text2 += c.text
  }
  const fin2 = chunks2.at(-1)
  console.log('文本:', JSON.stringify(text2))
  console.log('finish:', fin2?.reason?.kind)
  ck('第二轮正常结束', fin2?.reason?.kind === 'stop', fin2?.reason?.kind)
  ck('第二轮有回答', text2.trim().length > 0, JSON.stringify(text2.trim().slice(0, 80)))
  ck('回答含时间', /16|20|:/.test(text2), text2.slice(0, 60))
}

console.log('\n=== 无工具时不应有 tool-call ===')
const chunks3 = []
for await (const c of adapter.stream({
  provider: 'lightvela',
  model,
  messages: [{ role: 'user', content: '说个数字' }],
})) {
  chunks3.push(c)
}
ck('无 tools 时 finish 为 stop', chunks3.at(-1)?.reason?.kind === 'stop', chunks3.at(-1)?.reason?.kind)
ck('无 tools 时无 tool-call 块', !chunks3.some((c) => c.type === 'block-end' && c.block?.type === 'tool-call'))

console.log('\n===== 汇总 =====')
const bad = results.filter((r) => !r.ok)
console.log(`${results.length - bad.length}/${results.length} passed`)
process.exit(bad.length ? 1 : 0)
