if (process.env.LV_ALLOW_LIVE_TESTS !== '1') throw new Error('Manual live test: set LV_ALLOW_LIVE_TESTS=1 first; requests may consume credits.');
/**
 * 本地冒烟测试：不依赖真实 token，验证服务骨架与路由。
 */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8790';

async function call(path, init) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  return { status: res.status, text };
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

// healthz 一定会响应（ok 取决于 token）
const h = await call('/healthz');
check('GET /healthz 返回 200', h.status === 200, h.text.slice(0, 120));

// models
const m = await call('/v1/models');
let models = null;
try {
  models = JSON.parse(m.text);
} catch {}
check('GET /v1/models 返回 model 列表', m.status === 200 && Array.isArray(models?.data) && models.data.length > 0);

// chat: 空 messages 应 400
const c = await call('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [] }),
});
check('POST /v1/chat/completions 空 messages -> 400', c.status === 400, c.text.slice(0, 100));

// 未知路由 404
const n = await call('/nope');
check('未知路由 -> 404', n.status === 404);

// CORS 预检
const o = await fetch(BASE + '/v1/chat/completions', { method: 'OPTIONS' });
check('OPTIONS 预检 -> 204', o.status === 204);

console.log('\n===== 汇总 =====');
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
