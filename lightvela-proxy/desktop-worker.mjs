// Private desktop IPC: input is supplied over stdin, never command-line arguments.
import { getSession, listInstances } from './lv-client.mjs';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 65536) process.exit(2);
}
try {
  const { token } = JSON.parse(input);
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('invalid token');
  // No model execution or credit-consuming endpoint is called here.
  const session = await getSession(token);
  const instances = await listInstances(token);
  const user = session?.data?.session?.user || session?.data?.user || session?.session?.user || session?.user || {};
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  const accountHint = /^[^\s@]+@[^\s@]+$/.test(email) ? email.replace(/^(.{0,2})[^@]*@/, '$1***@') : '当前登录账号';
  const ready = instances.some(i => /^(running|active|ready)$/i.test(String(i.status || '')));
  console.log(JSON.stringify({ ok: true, ready, instanceCount: instances.length, accountHint,
    message: instances.length === 0 ? '登录有效，但此账号的中国站实例列表为空。请在官网核对账号和实例。' :
      !ready ? '登录有效，但实例尚未运行。请先在官网启动实例。' : '登录有效，已找到运行中的实例。',
    instances: instances.map(i => ({
    id: i.instance_id || i.id || '',
    name: i.name || i.display_name || i.instance_id || i.id || '',
    status: i.status || '',
  })).filter(i => i.id) }));
} catch (error) {
  const status = Number(error.status) || 0;
  // Never include raw upstream errors, headers or request bodies in desktop output.
  console.log(JSON.stringify({ ok: false, status, message:
    error.code === 'invalid_instance_response' ? '实例列表返回格式无法识别，请更新工具后重试。' :
    status === 401 || status === 403 ? '登录已失效或账号暂无访问权限，请重新登录。' :
    status === 429 ? '请求过于频繁，请稍后重试。' : '无法连接 LightVela，请检查网络后重试。' }));
  process.exitCode = 1;
}
