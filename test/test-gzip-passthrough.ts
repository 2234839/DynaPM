/**
 * DynaPM Gzip 压缩响应透传测试
 *
 * 验证网关正确透传后端返回的 gzip 压缩响应：
 * 1. gzip 响应 Content-Encoding 头正确透传
 * 2. gzip 压缩的响应体完整透传（客户端可解压）
 * 3. 不发送 Accept-Encoding 时后端不压缩，网关正常透传
 * 4. 通过端口路由的 gzip 响应透传
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { createConnection } from 'node:net';
import { gunzipSync } from 'node:zlib';

const execAsync = promisify(exec);

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
function log(msg: string, color = C.reset) { console.log(`${color}${msg}${C.reset}`); }
function section(msg: string) { log(`\n${'='.repeat(60)}`, C.cyan); log(msg, C.cyan); log('='.repeat(60), C.cyan); }
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
  try {
    await execAsync(`fuser -k ${port}/tcp 2>/dev/null`);
  } catch {}
  await sleep(300);
}

function httpRequest(options: {
  hostname?: string;
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const { hostname, port = 3090, path = '/', method = 'GET', headers = {}, body, timeout = 10000 } = options;
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (hostname) reqHeaders['Host'] = hostname;
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: reqHeaders, timeout }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        const resHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) resHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
        }
        resolve({ status: res.statusCode || 0, headers: resHeaders, body: bodyBuf });
      });
    });
    if (body) req.write(body);
    req.on('error', reject);
    req.end();
  });
}

async function waitForPort(port: number, timeout = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await checkPort(port)) return true; await sleep(100); }
  return false;
}

const results: { name: string; passed: boolean; message?: string }[] = [];

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
    log(`  ✓ ${name}`, C.green);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, message });
    log(`  ✗ ${name}: ${message}`, C.red);
  }
}

/** 确保 echo-host 服务在线 */
async function ensureEchoOnline(): Promise<void> {
  const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (res.status !== 200) throw new Error('echo-host 预热失败');
}

// ==================== 测试场景 ====================

/** 1. gzip 响应 Content-Encoding 头正确透传 */
async function test_gzip_content_encoding() {
  await ensureEchoOnline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/gzip',
    headers: { 'Accept-Encoding': 'gzip' },
    timeout: 5000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  if (res.headers['content-encoding'] !== 'gzip') {
    throw new Error(`Content-Encoding 头缺失或错误: ${res.headers['content-encoding']}`);
  }
}

/** 2. gzip 压缩的响应体完整透传（客户端可解压） */
async function test_gzip_body_decompressible() {
  await ensureEchoOnline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/gzip',
    headers: { 'Accept-Encoding': 'gzip' },
    timeout: 5000,
  });

  /** 解压响应体 */
  const decompressed = gunzipSync(res.body);
  const data = JSON.parse(decompressed.toString());

  if (data.message !== 'gzip compressed') {
    throw new Error(`解压后数据不匹配: ${data.message}`);
  }
  if (data.data !== 'x'.repeat(1000)) {
    throw new Error('解压后 data 字段长度不匹配');
  }
}

/** 3. 不发送 Accept-Encoding 时后端仍返回 gzip（echo-server 的 /gzip 总是压缩） */
async function test_gzip_without_accept_encoding() {
  await ensureEchoOnline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/gzip',
    timeout: 5000,
  });

  /** /gzip 端点总是返回 gzip，即使没有 Accept-Encoding */
  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  if (res.headers['content-encoding'] !== 'gzip') {
    throw new Error(`Content-Encoding 头缺失: ${res.headers['content-encoding']}`);
  }

  /** node:http 客户端默认不解压（因为请求没有 Accept-Encoding） */
  const decompressed = gunzipSync(res.body);
  const data = JSON.parse(decompressed.toString());
  if (data.message !== 'gzip compressed') {
    throw new Error('不解压时响应体仍为有效 gzip');
  }
}

/** 4. 通过端口路由的 gzip 响应透传 */
async function test_gzip_port_route() {
  /** echo-proxy (端口 3092) 是 proxyOnly，后端是 echo-host (3099)，需要先预热 */
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (warmup.status !== 200) throw new Error('echo-host 预热失败');

  const res = await httpRequest({
    port: 3092,
    path: '/gzip',
    headers: { 'Accept-Encoding': 'gzip' },
    timeout: 5000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  if (res.headers['content-encoding'] !== 'gzip') {
    throw new Error(`Content-Encoding 头缺失: ${res.headers['content-encoding']}`);
  }

  const decompressed = gunzipSync(res.body);
  const data = JSON.parse(decompressed.toString());
  if (data.message !== 'gzip compressed') {
    throw new Error('端口路由 gzip 解压后数据不匹配');
  }
}

/** 5. Accept-Encoding 包含多种编码时 gzip 仍然透传 */
async function test_gzip_multi_encoding() {
  await ensureEchoOnline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/gzip',
    headers: { 'Accept-Encoding': 'gzip, deflate, br' },
    timeout: 5000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  if (res.headers['content-encoding'] !== 'gzip') {
    throw new Error(`Content-Encoding 头错误: ${res.headers['content-encoding']}`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n📦 DynaPM Gzip 压缩响应透传测试', C.cyan);

  section('环境准备');

  for (const port of [3090, 3091, 3092, 3099, 3010, 3011]) {
    await killPort(port);
  }
  await sleep(500);

  /** 启动 proxy-test 配置网关（包含 echo-host hostname 路由和 echo-proxy 端口路由） */
  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3090, 10000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3091, 5000);
  await waitForPort(3092, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(500);

  section('Hostname 路由');

  await runTest('gzip Content-Encoding 头透传', test_gzip_content_encoding);
  await runTest('gzip 响应体可解压验证', test_gzip_body_decompressible);
  await runTest('无 Accept-Encoding 时 gzip 透传', test_gzip_without_accept_encoding);
  await runTest('多 Accept-Encoding 时 gzip 透传', test_gzip_multi_encoding);

  section('端口路由');

  await runTest('端口路由 gzip 响应透传', test_gzip_port_route);

  section('清理环境');

  for (const port of [3090, 3091, 3092, 3099, 3010, 3011]) {
    await killPort(port);
  }
  log('  ✓ 所有进程已清理', C.green);

  section('测试结果汇总');

  let passedCount = 0;
  let failedCount = 0;
  for (const result of results) {
    if (result.passed) passedCount++;
    else failedCount++;
  }

  log(`\n总计: ${results.length} 个测试`, C.cyan);
  log(`通过: ${passedCount} 个`, C.green);
  if (failedCount > 0) {
    log(`失败: ${failedCount} 个`, C.red);
    for (const r of results) {
      if (!r.passed) log(`  ✗ ${r.name}: ${r.message}`, C.red);
    }
  }

  if (failedCount === 0) {
    log('\n🎉 所有 Gzip 透传测试通过！', C.green);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch(err => {
  log(`测试执行失败: ${err}`, C.red);
  console.error(err);
  process.exit(1);
});
