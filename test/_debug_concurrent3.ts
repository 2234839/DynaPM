/**
 * 精确调试：检查 502 的具体原因
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

function httpRequestDetailed(i: number, body: string, timeout = 20000): Promise<{
  i: number; status: number; body: string; error?: string;
  timing: { send: number; firstByte: number; end: number };
}> {
  const sendTime = Date.now();
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 3090, path: '/echo', method: 'POST',
      headers: { Host: 'echo-host.test' },
      timeout,
    }, (res) => {
      const firstByteTime = Date.now();
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          i, status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString(),
          timing: { send: sendTime, firstByte: firstByteTime, end: Date.now() },
        });
      });
    });
    req.on('error', (err) => {
      resolve({ i, status: 0, body: '', error: err.message, timing: { send: sendTime, firstByte: 0, end: Date.now() } });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ i, status: 0, body: '', error: 'timeout', timing: { send: sendTime, firstByte: 0, end: Date.now() } });
    });
    req.write(body);
    req.end();
  });
}

async function ensureEchoOffline() {
  for (let j = 0; j < 3; j++) {
    await killPort(3099);
    if (!await checkPort(3099)) break;
  }
  if (await checkPort(3099)) throw new Error('echo not killed');
  // 触发网关状态重置
  await new Promise<void>((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 3090, path: '/echo', method: 'GET',
      headers: { Host: 'echo-host.test' }, timeout: 5000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
  await sleep(500);
}

async function main() {
  for (const port of [3090, 3091, 3092, 3099]) await killPort(port);
  await sleep(500);

  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /tmp/gw-debug3.log 2>&1 &`);
  await sleep(1500);
  if (!await checkPort(3090)) { console.log('网关启动失败'); process.exit(1); }

  await ensureEchoOffline();
  console.log('echo 已离线，开始 5 并发 POST...\n');

  const N = 5;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(httpRequestDetailed(i, `body-${i}`));
  }
  const results = await Promise.all(promises);

  const baseTime = results[0].timing.send;
  for (const r of results) {
    const latency = r.timing.firstByte ? r.timing.firstByte - r.timing.send : r.timing.end - r.timing.send;
    console.log(`请求${r.i}: status=${r.status} latency=${latency}ms send_offset=${r.timing.send - baseTime}ms ${r.error ? 'ERROR: ' + r.error : ''}`);
    if (r.status === 200) {
      try {
        const data = JSON.parse(r.body);
        console.log(`        body="${data.body}" bodyLength=${data.bodyLength}`);
      } catch {
        console.log(`        body=${r.body.substring(0, 80)}`);
      }
    } else if (r.status === 502) {
      console.log(`        response body="${r.body}"`);
    }
  }

  console.log('\n=== 网关日志 ===');
  try {
    const { stdout } = await execAsync('cat /tmp/gw-debug3.log');
    console.log(stdout);
  } catch {}

  for (const port of [3090, 3091, 3092, 3099]) await killPort(port);
  process.exit(0);
}

main().catch(console.error);
