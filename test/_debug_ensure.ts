/**
 * 调试 ensureEchoOffline 和测试顺序问题
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

function httpRequest(options: {
  hostname?: string; port?: number; path?: string; method?: string;
  headers?: Record<string, string>; body?: string; timeout?: number;
}): Promise<{ status: number; body: string }> {
  const { hostname, port = 3090, path = '/', method = 'GET', headers = {}, body, timeout = 10000 } = options;
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (hostname) reqHeaders['Host'] = hostname;
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: reqHeaders, timeout }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function ensureEchoOffline() {
  try {
    const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 3000 });
    if (statusRes.status === 200) {
      const data = JSON.parse(statusRes.body);
      console.log(`  [ensureEchoOffline] 管理 API status=${data.status}`);
      if (data.status === 'online' || data.status === 'starting') {
        const stopRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 10000 });
        console.log(`  [ensureEchoOffline] stop result: ${stopRes.status}`);
      }
    }
  } catch (e) {
    console.log(`  [ensureEchoOffline] 管理 API 不可用: ${e}`);
  }

  for (let i = 0; i < 3; i++) {
    await killPort(3099);
    if (!await checkPort(3099)) break;
  }
  console.log(`  [ensureEchoOffline] port 3099=${await checkPort(3099)}`);

  try {
    const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 3000 });
    if (statusRes.status === 200) {
      const data = JSON.parse(statusRes.body);
      if (data.status === 'online') {
        console.log(`  [ensureEchoOffline] 状态仍为 online，触发 502 重置`);
        try { await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 }); } catch {}
        await sleep(300);
      }
    }
  } catch {}

  const finalStatus = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 3000 });
  const finalData = JSON.parse(finalStatus.body);
  console.log(`  [ensureEchoOffline] 最终状态: status=${finalData.status} port=${await checkPort(3099)}`);
}

async function main() {
  for (const port of [3090, 3091, 3092, 3099]) await killPort(port);
  await sleep(500);

  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /tmp/gw-debug4.log 2>&1 &`);
  await sleep(1500);
  if (!await checkPort(3090)) { console.log('网关启动失败'); process.exit(1); }
  console.log('网关已启动\n');

  // 测试1: ensureEchoOffline 从未启动过
  console.log('=== 测试1: ensureEchoOffline 从未启动过 ===');
  await ensureEchoOffline();
  console.log();

  // 测试2: ensureEchoOffline 在 online 后
  console.log('=== 测试2: 启动 echo 后 ensureEchoOffline ===');
  await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  console.log('  echo 已启动');
  await ensureEchoOffline();
  console.log();

  // 测试3: 混合方法并发
  console.log('=== 测试3: 混合方法并发按需启动 ===');
  const promises = [];
  for (let i = 0; i < 6; i++) {
    const method = ['GET', 'POST', 'PUT'][i % 3];
    const body = method === 'GET' ? undefined : `method-${i}`;
    promises.push(
      httpRequest({
        hostname: 'echo-host.test', path: '/echo', method, body, timeout: 20000,
      })
        .then(res => ({ i, method, status: res.status, body: res.body.substring(0, 100) }))
        .catch(err => ({ i, method, error: err.message }))
    );
  }
  const results = await Promise.all(promises);
  for (const r of results) {
    if (r.error) {
      console.log(`  请求${r.i} ${r.method}: ERROR ${r.error}`);
    } else {
      console.log(`  请求${r.i} ${r.method}: ${r.status} ${r.body}`);
    }
  }
  console.log();

  // 测试4: 压力测试
  console.log('=== 测试4: 确保 echo 在线后 100 并发 POST ===');
  if (!await checkPort(3099)) {
    console.log('  echo 不在线，启动...');
    const r = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
    console.log(`  启动结果: ${r.status}`);
  }
  const p4 = [];
  for (let i = 0; i < 100; i++) {
    p4.push(
      httpRequest({ hostname: 'echo-host.test', path: '/echo', method: 'POST', body: `s-${i}`, timeout: 10000 })
        .then(res => ({ i, status: res.status }))
        .catch(err => ({ i, error: err.message }))
    );
  }
  const r4 = await Promise.all(p4);
  const f4 = r4.filter(r => r.error || r.status !== 200);
  console.log(`  失败: ${f4.length}/100`);
  for (const r of f4.slice(0, 3)) console.log(`    请求${r.i}: ${r.error || 'status=' + r.status}`);

  // 清理
  for (const port of [3090, 3091, 3092, 3099]) await killPort(port);
  process.exit(0);
}

main().catch(console.error);
