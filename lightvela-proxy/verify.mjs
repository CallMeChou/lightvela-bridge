if (process.env.LV_ALLOW_LIVE_TESTS !== '1' || !process.env.LV_SESSION_TOKEN) throw new Error('Manual live test: set LV_ALLOW_LIVE_TESTS=1 and LV_SESSION_TOKEN first; requests may consume credits.');
/**
 * 端到端验收：走本地反代，验证 OpenAI 协议 + 积分扣减
 */
const BASE = process.env.LV_PROXY || 'http://127.0.0.1:8790';
const TOKEN = process.env.LV_SESSION_TOKEN;
const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`);
};

async function post(path, obj) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

async function credits() {
  const r = await fetch('https://api.lightvela.com/v1/passes', {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      origin: 'https://lightvela.com',
      accept: 'application/json',
    },
  });
  const j = await r.json();
  const p = j?.data?.passes?.[0];
  return p ? { avail: p.credit_available, total: p.credit_total } : null;
}

console.log('=== 1. 健康检查 ===');
const h = await fetch(BASE + '/healthz').then((r) => r.json());
check('上游连通 + 身份正确', h.ok === true, `${h.email} / ${h.instance}`);

console.log('\n=== 2. 模型列表 ===');
const m = await fetch(BASE + '/v1/models').then((r) => r.json());
check('返回 OpenAI 格式模型列表', m.object === 'list' && m.data.length > 0, m.data?.[0]?.id);

console.log('\n=== 3. 积分基线 ===');
const before = await credits();
check('读到积分', before !== null, `可用 ${before?.avail} / 总 ${before?.total}`);

console.log('\n=== 4. 非流式对话 ===');
const c1 = await post('/v1/chat/completions', {
  model: 'hermes',
  messages: [{ role: 'user', content: '只回复两个字：收到' }],
});
let j1 = null;
try {
  j1 = JSON.parse(c1.text);
} catch {}
check('HTTP 200', c1.status === 200);
check('choices[0].message.content 非空', !!j1?.choices?.[0]?.message?.content);
check('上游 exitCode=0', j1?._lv?.exitCode === 0);
console.log('      回复:', JSON.stringify(j1?.choices?.[0]?.message?.content));

console.log('\n=== 5. 流式对话 ===');
const c2 = await post('/v1/chat/completions', {
  model: 'hermes',
  stream: true,
  messages: [{ role: 'user', content: '回复一个数字：7' }],
});
const lines = c2.text.split('\n').filter((l) => l.startsWith('data: '));
const chunks = lines.filter((l) => l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
const joined = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
check('SSE 收到多个 chunk', chunks.length > 1, `${chunks.length} chunks`);
check('有 [DONE] 终止符', c2.text.includes('data: [DONE]'));
check('拼接内容非空', joined.trim().length > 0, JSON.stringify(joined));

console.log('\n=== 6. 边界 ===');
const c3 = await post('/v1/chat/completions', { messages: [] });
check('空 messages -> 400', c3.status === 400);

console.log('\n=== 7. 积分变化 ===');
await new Promise((r) => setTimeout(r, 2500));
const after = await credits();
const used = (before?.avail ?? 0) - (after?.avail ?? 0);
check('积分被扣减', used > 0, `${before?.avail} -> ${after?.avail}  (消耗 ${used})`);
console.log(`\n总消耗: ${used} 积分，剩余 ${after?.avail}`);

console.log('\n===== 汇总 =====');
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
