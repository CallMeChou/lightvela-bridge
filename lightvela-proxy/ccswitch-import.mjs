import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';

function isCCSwitchRunning() {
  if (process.platform !== 'win32') throw new Error('桌面导入仅支持 Windows');
  const result = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq cc-switch.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return /"cc-switch\.exe"/i.test(result);
}

export async function importProvider(dbPath, {
  baseUrl = 'http://127.0.0.1:8790/v1', model = 'auto', checkRunning = isCCSwitchRunning,
} = {}) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/v1'
    || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('本地反代地址或模型无效');
  if (!existsSync(dbPath)) throw new Error('找不到 CC Switch 数据库');
  if (checkRunning()) throw new Error('请先完全退出 CC Switch，包括托盘进程');
  const id = 'lightvela-codex';
  const now = Date.now();
  const config = [
    `model = "${model}"`, 'model_provider = "custom"', '', '[model_providers.custom]',
    'name = "lightvela"', `base_url = "${baseUrl}"`, 'wire_api = "responses"',
    'requires_openai_auth = true', '',
  ].join('\n');
  const settings = JSON.stringify({
    auth: { OPENAI_API_KEY: 'local-lightvela' }, config,
    modelCatalog: { models: [{ model, displayName: `LightVela ${model}`, inputModalities: ['text'] }] },
  });
  const backupDir = join(dirname(dbPath), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `lightvela-${now}-${randomUUID()}.db`);
  const db = new DatabaseSync(dbPath);
  let backupComplete = false;
  try {
    // SQLite backup includes committed WAL pages; copying .db alone does not.
    await backup(db, backupPath);
    backupComplete = true;
    if (checkRunning()) throw new Error('CC Switch 已启动，请退出后重新导入');
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      INSERT INTO providers
        (id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue, cost_multiplier, provider_type)
      VALUES (?, 'codex', 'LightVela', ?, 'https://lightvela.com', 'third_party', ?, 0, ?, NULL, '#6D5EF5', '{}', 1, 0, '1.0', 'custom')
      ON CONFLICT(id, app_type) DO UPDATE SET
        name = excluded.name, settings_config = excluded.settings_config,
        website_url = excluded.website_url, category = excluded.category,
        is_current = 1, provider_type = excluded.provider_type
    `).run(id, settings, now, 'LightVela auto via local proxy');
    db.prepare("UPDATE providers SET is_current = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE app_type = 'codex'").run(id);
    db.prepare("INSERT INTO settings (key, value) VALUES ('currentProviderCodex', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
    db.prepare('DELETE FROM provider_endpoints WHERE provider_id = ? AND app_type = ?').run(id, 'codex');
    db.prepare('INSERT INTO provider_endpoints (provider_id, app_type, url, added_at) VALUES (?, ?, ?, ?)').run(id, 'codex', baseUrl, now);
    db.exec('COMMIT');
    return { ok: true, providerId: id, model, baseUrl, backup: backupPath };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { }
    if (!backupComplete) { try { rmSync(backupPath); } catch { } }
    throw error;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await importProvider(process.argv[2] || join(process.env.USERPROFILE || '', '.cc-switch', 'cc-switch.db'), {
      baseUrl: process.env.LV_PROXY_URL || 'http://127.0.0.1:8790/v1', model: process.env.LV_MODEL_ID || 'auto',
    })));
  } catch {
    console.log(JSON.stringify({ ok: false, message: '导入失败，未切换供应商。请确认 CC Switch 已退出，数据库可用。' }));
    process.exitCode = 1;
  }
}
