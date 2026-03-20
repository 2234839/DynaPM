/**
 * 精确模拟 test_concurrent_post_on_demand 的失败场景
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { createConnection } from 'node:net';

const execAsync = promisify(exec);

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 200 }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function killPort(port: number) {
  try {
    await execAsync(`lsof -i:${port} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9 2>/dev/null`);
  } catch {}
  await sleep(300);
}

/** 和测试中完全一样的 httpRequest（不带 Content-Length） */
function httpRequest(options: {
  hostname?: string; port?: number; path?: string; method?: string;
  headers?: Record<string, string>; body?: string | Buffer; timeout?: number;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const { hostname, port = 3090, path = '/', method = 'GET', headers = {}, body, timeout = 10000 } = options;
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (hostname) reqHeaders['Host'] = hostname;
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: reqHeaders, timeout }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString();
        const resHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) resHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
        }
        resolve({ status: res.statusCode || 0, headers: resHeaders, body: bodyStr });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function ensureEchoOffline() {
  for (let i = 0; i < 3; i++) {
    await killPort(3099);
    if (!await checkPort(3099)) break;
  }
  if (await checkPort(3099)) throw new Error('echo not killed');
  try { await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 }); } catch {}
  await sleep(500);
}

async function main() {
  // 清理
  for (const port of [3090, 3091, 3092, 3099]) await killPort(port);
  await sleep(500);

  // 启动网关
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /tmp/gw-debug2.log 2>&1 &`);
  await sleep(1500);
  if (!await checkPort(3090)) { console.log('网关启动失败'); process.exit(1); }
  console.log('网关已启动');

  // 确认 echo 离线
  await ensureEchoOffline();
  console.log('echo 已离线');

  // 发送 3 个并发 POST（不带 Content-Length）
  console.log('\n=== 3 并发 POST 按需启动（不带 CL） ===');
  const body = 'concurrent-test-body-';
  const promises = [];
  for (let i = 0; i < 3; i++) {
    promises.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: '/echo',
        method: 'POST',
        body: `${body}${i}`,
        timeout: 20000,
      })
        .then(res => ({ i, status: res.status, ok: res.status === 200, body: res.body }))
        .catch(err => ({ i, error: err instanceof Error ? err.message : String(err), ok: false }))
    );
  }
  const res = await Promise.all(promises);
  for (const r of res) {
    if (r.ok) {
      const data = JSON.parse(r.body);
      console.log(`  请求${r.i}: 200 OK, body="${data.body}"`);
    } else {
      console.log(`  请求${r.i}: FAILED ${r.error || 'status=' + r.status}`);
    }
  }

  // 再试 10 个
  console.log('\n=== 10 并发 POST 按需启动（不带 CL） ===');
  await ensureEchoOffline();
  const p2 = [];
  for (let i = 0; i < 10; i++) {
    p2.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: '/echo',
        method: 'POST',
        body: `test10-${i}`,
        timeout: 20000,
      })
        .then(r => ({ i, status: r.status, ok: r.status === 200 }))
        .catch(err => ({ i, error: err instanceof Error ? err.message : String(err), ok: false }))
    );
  }
  const r2 = await Promise.all(p2);
  const failed = r2.filter(r => !r.ok);
  console.log(`结果: ${10 - failed.length}/10 成功, ${failed.length} 失败`);
  for (const r of failed) console.log(`  请求${r.i}: ${r.error || 'status=' + r.status}`);

  // 检查网关日志
  console.log('\n=== 网关日志最后 30 行 ===');
  try {
    const { stdout } = await execAsync('tail -30 /tmp/gw-debug2.log');
    console.log(stdout);
  } catch {}

  for (const port of [3090, 3091, 3092, 3099]) await killPort(port);
  process.exit(0);
}

main().catch(console.error);
