if (process.env.LV_ALLOW_LIVE_TESTS !== '1' || !process.env.LV_SESSION_TOKEN) throw new Error('Manual live test: set LV_ALLOW_LIVE_TESTS=1 and LV_SESSION_TOKEN first; requests may consume credits.');
/**
 * 插件 adapter 端到端：验证 gateway 模式下 stream() 的延迟与内容
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

const results = []
const ck = (n, ok, d = '') => {
  results.push({ n, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`)
}

// 等网关预热
await new Promise((r) => setTimeout(r, 2500))

console.log('=== 模型列表 ===')
const models = await adapter.listModels('lightvela')
const ids = models.map((m) => m.id)
ck('模型列表非空', ids.length > 0, ids.join(', '))
ck('过滤掉 mock/test', !ids.some((m) => /mock|test/i.test(m)))
ck('包含 deepseek', ids.some((m) => /deepseek/i.test(m)))

console.log('\n=== 真实 stream（gateway 模式）===')
const pick = ids.find((m) => /deepseek/i.test(m)) ?? ids[0]
for (const model of [pick, ids[0]]) {
  const t0 = Date.now()
  const chunks = []
  let text = ''
  let firstDelta = null
  for await (const c of adapter.stream({
    provider: 'lightvela',
    model,
    messages: [{ role: 'user', content: '只回复两个字：接通' }],
  })) {
    chunks.push(c)
    if (c.type === 'text-delta') {
      if (firstDelta === null) firstDelta = Date.now() - t0
      text += c.text
    }
  }
  const ms = Date.now() - t0
  const fin = chunks.at(-1)
  ck(`${model} 正常结束`, fin?.type === 'finish' && fin.reason.kind === 'stop', fin?.reason?.kind)
  ck(`${model} 有文本`, text.trim().length > 0, JSON.stringify(text.trim()))
  console.log(`      ${ms} ms（首 delta ${firstDelta} ms）chunks=${chunks.length}`)
}

console.log('\n=== 边界 ===')
const empty = []
for await (const c of adapter.stream({
  provider: 'lightvela',
  model: ids[0],
  messages: [{ role: 'user', content: 'x' }],
  signal: AbortSignal.abort(),
})) {
  empty.push(c)
}
ck('取消时 finish 为 aborted', empty.at(-1)?.reason?.kind === 'aborted', empty.at(-1)?.reason?.kind)

console.log('\n===== 汇总 =====')
const bad = results.filter((r) => !r.ok)
console.log(`${results.length - bad.length}/${results.length} passed`)
process.exit(bad.length ? 1 : 0)
