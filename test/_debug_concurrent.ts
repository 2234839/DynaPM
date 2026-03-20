/**
 * 调试并发问题：直接测试 echo-server 和网关并发能力
 */
import * as http from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
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

function httpDirect(port: number, method: string, path: string, body?: string): Promise<{ status: number; error?: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (body) {
      headers['Content-Type'] = 'text/plain';
      headers['Content-Length'] = String(body.length);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0 }));
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  // 确保只有 echo-server 运行
  for (const port of [3090, 3091, 3092]) await killPort(port);

  // 直接测试 echo-server 并发
  console.log('=== 直接测试 echo-server 50 并发 POST ===');
  const p1 = [];
  for (let i = 0; i < 50; i++) {
    p1.push(httpDirect(3099, 'POST', '/echo', `body-${i}`));
  }
  const r1 = await Promise.all(p1);
  const f1 = r1.filter(r => r.status !== 200);
  console.log(`结果: ${50 - f1.length}/50 成功, ${f1.length} 失败`);
  for (const r of f1.slice(0, 3)) console.log(`  status=${r.status} ${r.error || ''}`);

  // 启动网关
  console.log('\n=== 启动网关 ===');
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /tmp/gw-debug.log 2>&1 &`);
  await sleep(1500);
  if (!await checkPort(3090)) { console.log('网关启动失败'); process.exit(1); }
  console.log('网关已启动');

  // 通过网关 hostname 路由测试并发
  console.log('\n=== 网关 hostname 路由 50 并发 POST ===');
  const p2 = [];
  for (let i = 0; i < 50; i++) {
    p2.push(
      new Promise<{ i: number; status: number; error?: string }>((resolve) => {
        const body = `gw-${i}`;
        const req = http.request({
          hostname: '127.0.0.1', port: 3090, path: '/echo', method: 'POST',
          headers: { Host: 'echo-host.test', 'Content-Type': 'text/plain', 'Content-Length': String(body.length) },
          timeout: 10000,
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ i, status: res.statusCode || 0 }));
        });
        req.on('error', (err) => resolve({ i, status: 0, error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ i, status: 0, error: 'timeout' }); });
        req.write(body);
        req.end();
      })
    );
  }
  const r2 = await Promise.all(p2);
  const f2 = r2.filter(r => r.status !== 200);
  console.log(`结果: ${50 - f2.length}/50 成功, ${f2.length} 失败`);
  for (const r of f2.slice(0, 5)) console.log(`  请求${r.i}: status=${r.status} ${r.error || ''}`);

  // 端口路由并发
  console.log('\n=== 网关端口路由 50 并发 POST ===');
  const p3 = [];
  for (let i = 0; i < 50; i++) {
    p3.push(
      new Promise<{ i: number; status: number; error?: string }>((resolve) => {
        const body = `port-${i}`;
        const req = http.request({
          hostname: '127.0.0.1', port: 3092, path: '/echo', method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) },
          timeout: 5000,
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ i, status: res.statusCode || 0 }));
        });
        req.on('error', (err) => resolve({ i, status: 0, error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ i, status: 0, error: 'timeout' }); });
        req.write(body);
        req.end();
      })
    );
  }
  const r3 = await Promise.all(p3);
  const f3 = r3.filter(r => r.status !== 200);
  console.log(`结果: ${50 - f3.length}/50 成功, ${f3.length} 失败`);
  for (const r of f3.slice(0, 5)) console.log(`  请求${r.i}: status=${r.status} ${r.error || ''}`);

  // 清理
  for (const port of [3090, 3091, 3092]) await killPort(port);
  console.log('\n清理完成');
  process.exit(0);
}

main().catch(console.error);
