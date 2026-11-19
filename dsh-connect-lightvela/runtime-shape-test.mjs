if (process.env.LV_ALLOW_LIVE_TESTS !== '1' || !process.env.LV_SESSION_TOKEN) throw new Error('Manual live test: set LV_ALLOW_LIVE_TESTS=1 and LV_SESSION_TOKEN first; requests may consume credits.');
/**
 * 运行时形状测试：模拟 DSH 的真实调用序列（duck typing）
 * 验证 providerRetryPolicy / imageRequestPricing / prepareCall 等都被调用到
 */
const TOKEN = (process.env.LV_SESSION_TOKEN || '').trim()
const results = []
const ck = (n, ok, d = '') => {
  results.push({ n, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`)
}

const mod = await import('./index.js')

let captured = null
const routes = []
const ctx = {
  logger: { debug() {}, warn() {}, info() {}, error() {} },
  effect(fn) {
    fn()
  },
  // 新增：HTTP 路由用 ctx.inject(['webServer'], cb)
  inject(_services, cb) {
    cb({
      effect(fn) {
        fn()
      },
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    })
  },
  get: () => undefined,
  llm: {
    registerAdapter(_p, a) {
      captured = a
      return () => {}
    },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
  },
}
mod.apply(ctx, mod.Config({ sessionToken: TOKEN, region: 'cn' }))

ck('捕获到 adapter', !!captured)
ck('注册了 HTTP 路由', routes.length === 1, routes[0]?.path)
ck('路由为 exact 类型', routes[0]?.kind === 'exact')
ck('路由有 handler', typeof routes[0]?.handler === 'function')

// DSH 会按鸭子类型调用这些方法，任何一个缺失都会让 fiber 失败
const mustHave = [
  'providerInfo',
  'providerRetryPolicy',
  'imageRequestPricing',
  'imageRequestTarget',
  'listModels',
  'resolveModel',
  'prepareCall',
  'stream',
]
for (const m of mustHave) {
  ck(`adapter.${m} 是可调用函数`, typeof captured[m] === 'function')
}

ck('providerInfo 返回 id/name', (() => {
  const i = captured.providerInfo('lightvela')
  return i.id === 'lightvela' && typeof i.name === 'string'
})())
ck('providerRetryPolicy 返回 undefined', captured.providerRetryPolicy('lightvela') === undefined)
ck('imageRequestPricing 返回 undefined', captured.imageRequestPricing('lightvela', 'hermes') === undefined)
const tgt = captured.imageRequestTarget('lightvela', 'hermes', { width: 10, height: 20, bytes: 100 })
ck('imageRequestTarget 回显尺寸', tgt.width === 10 && tgt.height === 20 && tgt.maxBytes === 100)

const pc = await captured.prepareCall('lightvela', 'hermes')
ck('prepareCall 返回 model + stream', !!pc.model && typeof pc.stream === 'function')
ck('prepareCall.model.provider 正确', pc.model.provider === 'lightvela' && pc.model.id === 'hermes')

console.log('\n===== 汇总 =====')
const bad = results.filter((r) => !r.ok)
console.log(`${results.length - bad.length}/${results.length} passed`)
process.exit(bad.length ? 1 : 0)
