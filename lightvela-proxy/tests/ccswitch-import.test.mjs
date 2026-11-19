import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importProvider } from '../ccswitch-import.mjs';

function fixture(t, incomplete = false) {
  const dir = mkdtempSync(join(tmpdir(), 'lv-import-test-'));
  const path = join(dir, 'fixture.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE providers(id TEXT,app_type TEXT,name TEXT,settings_config TEXT,website_url TEXT,category TEXT,created_at INTEGER,sort_index INTEGER,notes TEXT,icon TEXT,icon_color TEXT,meta TEXT,is_current INTEGER,in_failover_queue INTEGER,cost_multiplier TEXT,provider_type TEXT,PRIMARY KEY(id,app_type));
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO providers(id,app_type,name,settings_config,is_current) VALUES ('old','codex','Original','{"unchanged":true}',1),('claude','claude','Other','{}',1);
    INSERT INTO settings VALUES('currentProviderCodex','old');`);
  if (!incomplete) db.exec('CREATE TABLE provider_endpoints(provider_id TEXT,app_type TEXT,url TEXT,added_at INTEGER)');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, db };
}

test('idempotent import sets both selections and preserves other providers', async t => {
  const { path, db } = fixture(t);
  const opts = { checkRunning: () => false };
  const first = await importProvider(path, opts);
  await importProvider(path, { ...opts, baseUrl: 'http://127.0.0.1:9123/v1' });
  assert.equal(db.prepare("SELECT count(*) n FROM providers WHERE id='lightvela-codex'").get().n, 1);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='currentProviderCodex'").get().value, 'lightvela-codex');
  assert.equal(db.prepare("SELECT is_current FROM providers WHERE id='old'").get().is_current, 0);
  assert.equal(db.prepare("SELECT settings_config FROM providers WHERE id='old'").get().settings_config, '{"unchanged":true}');
  assert.equal(db.prepare("SELECT is_current FROM providers WHERE id='claude'").get().is_current, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM provider_endpoints').get().n, 1);
  const config = JSON.parse(db.prepare("SELECT settings_config FROM providers WHERE id='lightvela-codex'").get().settings_config);
  assert.match(config.config, /9123\/v1/); assert.equal(config.modelCatalog.models[0].model, 'auto');
  assert.ok(existsSync(first.backup));
});

test('backup includes committed WAL rows and can restore original selections', async t => {
  const { path, db } = fixture(t);
  db.exec("INSERT INTO settings VALUES('wal-only','recent-committed-value')");
  const { backup } = await importProvider(path, { checkRunning: () => false });
  const snapshot = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(snapshot.prepare("SELECT value FROM settings WHERE key='wal-only'").get().value, 'recent-committed-value');
    assert.equal(snapshot.prepare("SELECT value FROM settings WHERE key='currentProviderCodex'").get().value, 'old');
    assert.equal(snapshot.prepare("SELECT count(*) n FROM providers WHERE id='lightvela-codex'").get().n, 0);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { snapshot.close(); }
});

test('schema failure rolls back provider and current selection', async t => {
  const { path, db } = fixture(t, true);
  await assert.rejects(importProvider(path, { checkRunning: () => false }));
  assert.equal(db.prepare("SELECT is_current FROM providers WHERE id='old'").get().is_current, 1);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='currentProviderCodex'").get().value, 'old');
  assert.equal(db.prepare('SELECT count(*) n FROM providers').get().n, 2);
});

test('running CC Switch blocks backup and mutation', async t => {
  const { dir, path, db } = fixture(t);
  await assert.rejects(importProvider(path, { checkRunning: () => true }), /退出/);
  assert.equal(existsSync(join(dir, 'backups')), false);
  assert.equal(db.prepare('SELECT count(*) n FROM providers').get().n, 2);
});

test('CC Switch reopening during backup blocks mutation', async t => {
  const { path, db } = fixture(t); let n = 0;
  await assert.rejects(importProvider(path, { checkRunning: () => ++n > 1 }), /已启动/);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='currentProviderCodex'").get().value, 'old');
});

test('invalid URLs/model are rejected before any mutation', async t => {
  const { dir, path, db } = fixture(t);
  for (const baseUrl of ['https://evil.example/v1', 'http://127.0.0.1/v1?secret=bad', 'http://user@localhost/v1']) {
    await assert.rejects(importProvider(path, { baseUrl, checkRunning: () => false }));
  }
  await assert.rejects(importProvider(path, { model: 'a"\nb', checkRunning: () => false }));
  assert.equal(db.prepare('SELECT count(*) n FROM providers').get().n, 2);
  assert.equal(existsSync(join(dir, 'backups')), false);
});
