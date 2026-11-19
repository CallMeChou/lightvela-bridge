if (process.env.LV_ALLOW_LIVE_TESTS !== '1' || !process.env.LV_SESSION_TOKEN) throw new Error('Manual live test: set LV_ALLOW_LIVE_TESTS=1 and LV_SESSION_TOKEN first; requests may consume credits.');
/**
 * 会话无关的元数据校验：完全复刻 dsh-llm listModels 的断言
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

/** 复刻 dsh-llm/src/index.ts listModels 的校验 */
function validateLikeDsh(provider, models) {
  const seen = new Set()
  for (const model of models) {
    if (
      typeof model.provider !== 'string' ||
      model.provider !== provider ||
      typeof model.id !== 'string' ||
      model.id.length === 0 ||
      typeof model.name !== 'string' ||
      model.name.length === 0 ||
      (model.description !== undefined && typeof model.description !== 'string') ||
      seen.has(model.id)
    ) {
      return `INVALID_CATALOG at id=${JSON.stringify(model?.id)} provider=${JSON.stringify(model?.provider)}`
    }
    seen.add(model.id)
  }
  return null
}

console.log('=== listModels 元数据校验 ===')
for (const provider of ['lightvela', 'other']) {
  const models = await adapter.listModels(provider)
  const err = validateLikeDsh(provider, models)
  ck(`provider="${provider}" 通过 DSH 校验`, err === null, err || `${models.length} 个`)
  if (models.length > 0) {
    console.log('      ', models.map((m) => `${m.provider}/${m.id}`).join(', '))
  }
}

console.log('\n=== resolveModel 元数据 ===')
for (const id of ['auto', 'deepseek-v4-pro-202606']) {
  const m = await adapter.resolveModel('lightvela', id)
  ck(`resolveModel(${id}) 带 provider`, m.provider === 'lightvela' && m.id === id, JSON.stringify(m.id))
}

console.log('\n=== 重复 id 检查 ===')
const all = await adapter.listModels('lightvela')
const ids = all.map((m) => m.id)
ck('无重复 id', new Set(ids).size === ids.length, ids.join(', '))

console.log('\n===== 汇总 =====')
const bad = results.filter((r) => !r.ok)
console.log(`${results.length - bad.length}/${results.length} passed`)
process.exit(bad.length ? 1 : 0)
