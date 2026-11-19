import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

test('instance envelopes and selection distinguish valid instances, empty accounts and invalid data', async t => {
  let payload;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/instances');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.LV_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const { listInstances, resolveInstance } = await import('../lv-client.mjs');
  const items = [
    { instance_id: 'stopped-instance', name: 'Stopped', status: 'stopped' },
    { instance_id: 'running-instance', name: 'Running', status: 'Running' },
  ];
  await t.test('current data.items envelope resolves running and explicit instances', async () => {
    payload = { data: { items } };
    assert.deepEqual(await listInstances('synthetic'), items);
    assert.equal(await resolveInstance('synthetic'), 'running-instance');
    assert.equal(await resolveInstance('synthetic', 'stopped-instance'), 'stopped-instance');
    await assert.rejects(resolveInstance('synthetic', 'missing'), e => e.code === 'instance_not_found');
  });
  await t.test('legacy instance list envelopes remain supported', async () => {
    for (const shape of [{ items }, { data: items }, items]) {
      payload = shape;
      assert.deepEqual(await listInstances('synthetic'), items);
    }
  });
  await t.test('genuinely empty nested list reports no_instance', async () => {
    payload = { data: { items: [] } };
    assert.deepEqual(await listInstances('synthetic'), []);
    await assert.rejects(resolveInstance('synthetic'), e => e.code === 'no_instance');
  });
  await t.test('unknown response format never pretends account has zero instances', async () => {
    for (const shape of [null, {}, { data: { unexpected: [] } }, { data: { items: null } }]) {
      payload = shape;
      await assert.rejects(resolveInstance('synthetic'), e => e.code === 'invalid_instance_response');
    }
  });
});
