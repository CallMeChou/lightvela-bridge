if (process.env.LV_ALLOW_LIVE_TESTS !== '1' || !process.env.LV_SESSION_TOKEN) throw new Error('Manual live test: set LV_ALLOW_LIVE_TESTS=1 and LV_SESSION_TOKEN first; requests may consume credits.');
/**
 * 直连测试：验证 debug/exec + hermes -z 全链路，UTF-8 干净
 * 用法：set LV_SESSION_TOKEN=xxx && node test-live.mjs "你的问题"
 */
import { debugExec, resolveInstance } from './lv-client.mjs';

const TOKEN = (process.env.LV_SESSION_TOKEN || '').trim();
const INSTANCE = process.env.LV_INSTANCE_ID || await resolveInstance(TOKEN);
const prompt = process.argv[2] || '只回复两个字：你好';

if (!TOKEN) {
  console.error('缺少 LV_SESSION_TOKEN');
  process.exit(2);
}

/** 把提示词 base64 后交给实例，避免任何 shell/locale 编码问题 */
function buildCmd(prompt, { timeoutSec = 150 } = {}) {
  const b64 = Buffer.from(prompt, 'utf8').toString('base64');
  return [
    'export PATH=$HOME/.local/bin:$PATH',
    'cd $HOME',
    `printf %s '${b64}' | base64 -d > /tmp/lv_in.txt`,
    `timeout ${timeoutSec} hermes -z "$(cat /tmp/lv_in.txt)" < /dev/null 2>&1`,
    'rc=$?',
    'rm -f /tmp/lv_in.txt',
    'exit $rc',
  ].join('; ');
}

console.log('prompt:', JSON.stringify(prompt));
const t0 = Date.now();
const r = await debugExec(TOKEN, INSTANCE, buildCmd(prompt), { timeoutMs: 180000 });
console.log(`exit=${r.exitCode} status=${r.status} elapsed=${Date.now() - t0}ms`);
console.log('--- output ---');
console.log(r.output);
