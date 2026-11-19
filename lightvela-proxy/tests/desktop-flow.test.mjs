import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const synthetic = 'synthetic-desktop-test-only';
async function upstream(t, instances = [{ id: 'synthetic-instance', name: 'Test instance', status: 'running' }]) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${synthetic}`) { res.statusCode = 401; return res.end(JSON.stringify({ message: 'do-not-log-' + synthetic })); }
    if (req.url === '/auth/session') return res.end(JSON.stringify({ user: { id: 'synthetic-user', email: 'fixture@example.test' } }));
    if (req.url === '/v1/instances') return res.end(JSON.stringify({ data: { items: instances } }));
    if (req.url.endsWith('/debug/exec')) {
      let data = ''; for await (const part of req) data += part;
      assert.equal(JSON.parse(data).run_as_user, 'agentuser');
      return res.end(JSON.stringify({ data: { status: 'completed', exit_code: 0, output: '本地模拟回复' } }));
    }
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
async function runWorker(base, token) {
  const child = spawn(process.execPath, [join(root, 'desktop-worker.mjs')], { env: { ...process.env, LV_API_BASE: base }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  child.stdin.end(JSON.stringify({ token })); const [code] = await once(child, 'close');
  return { code, data: JSON.parse(stdout), raw: stdout + stderr };
}
test('desktop verification uses only account and instance read endpoints', async t => {
  const up = await upstream(t); const result = await runWorker(up.url, synthetic);
  assert.equal(result.code, 0); assert.equal(result.data.ok, true);
  assert.equal(result.data.ready, true); assert.equal(result.data.instanceCount, 1);
  assert.equal(result.data.accountHint, 'fi***@example.test');
  assert.ok(!result.raw.includes('fixture@example.test'));
  assert.deepEqual(result.data.instances, [{ id: 'synthetic-instance', name: 'Test instance', status: 'running' }]);
  assert.deepEqual(up.requests, ['/auth/session', '/v1/instances']);
  assert.ok(!result.raw.includes(synthetic));
});
test('valid login with no instances is explicitly not ready', async t => {
  const up = await upstream(t, []); const result = await runWorker(up.url, synthetic);
  assert.equal(result.code, 0); assert.equal(result.data.ok, true);
  assert.equal(result.data.ready, false); assert.equal(result.data.instanceCount, 0);
  assert.match(result.data.message, /实例列表为空/);
  assert.deepEqual(up.requests, ['/auth/session', '/v1/instances']);
});
test('valid login with a stopped instance is not ready', async t => {
  const up = await upstream(t, [{ instance_id: 'stopped-test', status: 'Stopped' }]);
  const result = await runWorker(up.url, synthetic);
  assert.equal(result.data.ok, true); assert.equal(result.data.ready, false);
  assert.equal(result.data.instanceCount, 1); assert.match(result.data.message, /尚未运行/);
});
test('expired and malformed tokens produce safe failures without leaking upstream errors', async t => {
  const up = await upstream(t);
  const result = await runWorker(up.url, 'bad-synthetic');
  assert.equal(result.code, 1); assert.equal(result.data.status, 401);
  assert.ok(!result.raw.includes('do-not-log')); assert.ok(!result.raw.includes(synthetic));
  const malformed = await runWorker(up.url, 'bad\nheader');
  assert.equal(malformed.code, 1);
  assert.deepEqual(up.requests, ['/auth/session']);
});
test('proxy identity, auto model and Codex Responses round-trip work against local mock', async t => {
  const up = await upstream(t);
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, [join(root, 'server.mjs')], { env: { ...process.env, LV_API_BASE: up.url, LV_SESSION_TOKEN: synthetic, LV_MODEL_ID: 'auto', LV_BRIDGE_ID: 'test-owned-process', PORT: String(port), LV_INSTANCE_ID: '' }, stdio: ['ignore','pipe','pipe'] });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/bridge/status')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const identity = await (await fetch(base + '/bridge/status')).json();
  assert.deepEqual(identity, { ok: true, bridgeId: 'test-owned-process', model: 'auto' });
  assert.equal((await (await fetch(base + '/v1/models')).json()).data[0].id, 'auto');
  const post = async body => fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ input: [] })).status, 400);
  const data = await (await post({ model: 'auto', input: 'synthetic local prompt' })).json();
  assert.equal(data.status, 'completed'); assert.equal(data.output[0].content[0].text, '本地模拟回复');
  const stream = await (await post({ model: 'auto', input: 'synthetic local prompt', stream: true })).text();
  assert.match(stream, /event: response.completed/); assert.match(stream, /本地模拟回复/);
});
