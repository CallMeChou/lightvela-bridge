if (process.env.LV_ALLOW_LIVE_TESTS !== '1' || !process.env.LV_SESSION_TOKEN) throw new Error('Manual live test: set LV_ALLOW_LIVE_TESTS=1 and LV_SESSION_TOKEN first; requests may consume credits.');
/**
 * 网关通道端到端验收 v2
 */
import {
  getSession,
  listInstances,
  listPasses,
  readGatewayCredential,
  listGatewayModels,
  gatewayChat,
} from './lv-api.js'

const TOKEN = (process.env.LV_SESSION_TOKEN || '').trim()
const cred = { token: TOKEN, region: 'cn' }
const results = []
const ck = (n, ok, d = '') => {
  results.push({ n, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`)
}

const insts = await listInstances(cred)
const instanceId = String(insts[0].instance_id)
const gw = await readGatewayCredential(cred, instanceId)
const models = await listGatewayModels(gw)
const usable = models.filter((m) => !/mock|test/i.test(m))

console.log('=== 环境 ===')
console.log('实例:', instanceId)
console.log('网关:', gw.baseUrl)
console.log('模型:', usable.join(', '))
console.log('积分:', (await listPasses(cred))[0]?.credit_available)

console.log('\n=== 各模型延迟与可用性 ===')
const latencies = {}
for (const m of usable) {
  const t0 = Date.now()
  try {
    const r = await gatewayChat(gw, {
      model: m,
      messages: [{ role: 'user', content: '只回复两个字：网关' }],
    })
    const j = await r.json()
    const txt = String(j?.choices?.[0]?.message?.content ?? '').trim()
    const ms = Date.now() - t0
    latencies[m] = ms
    ck(`${m} 可对话`, txt.length > 0, `${ms} ms | ${JSON.stringify(txt)}`)
  } catch (e) {
    latencies[m] = Infinity
    ck(`${m} 可对话`, false, e.message.slice(0, 80))
  }
}

const fastest = Object.entries(latencies)
  .filter(([, v]) => Number.isFinite(v))
  .sort((a, b) => a[1] - b[1])[0]
console.log(`\n最快模型: ${fastest?.[0]} (${fastest?.[1]} ms)`)

console.log('\n=== 流式首 token ===')
const t2 = Date.now()
const r2 = await gatewayChat(gw, {
  model: fastest[0],
  messages: [{ role: 'user', content: '数到五，用逗号分隔' }],
  stream: true,
})
const reader = r2.body.getReader()
const dec = new TextDecoder()
let buf = ''
const pieces = []
let firstMs = null
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const c = JSON.parse(data)
      const p = c?.choices?.[0]?.delta?.content
      if (p) {
        if (firstMs === null) firstMs = Date.now() - t2
        pieces.push(p)
      }
    } catch {}
  }
}
ck('流式有内容', pieces.join('').length > 0, JSON.stringify(pieces.join('')))
console.log(`      总 ${Date.now() - t2} ms，首 token ${firstMs} ms`)

console.log('\n=== 缓存后的重复请求 ===')
for (let i = 0; i < 2; i++) {
  const t = Date.now()
  const r = await gatewayChat(gw, {
    model: fastest[0],
    messages: [{ role: 'user', content: '回复：快' }],
  })
  const j = await r.json()
  console.log(`      #${i + 1}: ${Date.now() - t} ms -> ${JSON.stringify(String(j?.choices?.[0]?.message?.content ?? '').trim())}`)
}

console.log('\n===== 汇总 =====')
const bad = results.filter((r) => !r.ok)
console.log(`${results.length - bad.length}/${results.length} passed`)
process.exit(bad.length ? 1 : 0)
