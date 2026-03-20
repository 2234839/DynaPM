/**
 * DynaPM POST 请求体完整性专项测试
 *
 * 验证按需启动模式下 POST 请求体不会丢失（uWS ArrayBuffer 借用语义修复）
 * 以及 transfer-encoding 头冲突修复
 *
 * 测试场景：
 * 1. 按需启动 POST 小请求体 (100B)
 * 2. 按需启动 POST 中等请求体 (100KB)
 * 3. 按需启动 POST 大请求体 (500KB)
 * 4. 按需启动 PUT 请求体
 * 5. 按需启动 PATCH 请求体
 * 6. 热代理 POST 请求体（对照）
 * 7. 端口路由 POST 请求体
 * 8. JSON 请求体完整性
 * 9. 二进制请求体（非 UTF-8 字符）
 * 10. 空请求体按需启动
 * 11. Content-Type 各种类型
 * 12. 按需启动 POST 超大请求体 (15MB > 10MB 限制应截断)
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { createConnection } from 'node:net';

const execAsync = promisify(exec);

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
function log(msg: string, color = C.reset) { console.log(`${color}${msg}${C.reset}`); }

function section(msg: string) {
  log(`\n${'='.repeat(60)}`, C.cyan);
  log(msg, C.cyan);
  log('='.repeat(60), C.cyan);
}

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
  await sleep(500);
}

async function waitForPort(port: number, timeout = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await checkPort(port)) return true; await sleep(100); }
  return false;
}

function httpRequest(options: {
  hostname?: string;
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeout?: number;
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

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, message: '通过', duration });
    log(`  ✓ ${name}`, C.green);
  } catch (err: unknown) {
    const duration = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, message, duration });
    log(`  ✗ ${name}: ${message}`, C.red);
  }
}

/** 确保后端在线（如果离线则触发按需启动） */
async function ensureEchoOnline(): Promise<void> {
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
  }
}

/** 确保后端离线（包括网关状态同步） */
async function ensureEchoOffline(): Promise<void> {
  /** 第一步：通过管理 API 停止服务（如果在线） */
  try {
    const statusRes = await httpRequest({
      port: 3091,
      path: '/_dynapm/api/services/echo-host',
      timeout: 3000,
    });
    if (statusRes.status === 200) {
      const data = JSON.parse(statusRes.body);
      if (data.status === 'online' || data.status === 'starting') {
        await httpRequest({
          port: 3091,
          path: '/_dynapm/api/services/echo-host/stop',
          method: 'POST',
          timeout: 10000,
        });
        await sleep(500);
      }
    }
  } catch {}

  /** 第二步：确保进程完全退出（强制 kill） */
  for (let i = 0; i < 5; i++) {
    await killPort(3099);
    await sleep(200);
    if (!await checkPort(3099)) break;
  }

  /** 第三步：轮询管理 API 直到状态为 offline */
  for (let retry = 0; retry < 10; retry++) {
    try {
      const statusRes = await httpRequest({
        port: 3091,
        path: '/_dynapm/api/services/echo-host',
        timeout: 2000,
      });
      if (statusRes.status === 200) {
        const data = JSON.parse(statusRes.body);
        if (data.status === 'offline') return;
        if (data.status === 'online') {
          try { await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 3000 }); } catch {}
          await sleep(500);
          continue;
        }
      }
    } catch {}
    await sleep(500);
  }

  if (await checkPort(3099)) {
    throw new Error('echo 进程未能停止');
  }
}

// ==================== 测试场景 ====================

/** 1. 按需启动 POST 小请求体 (100B) */
async function test_on_demand_post_small() {
  await ensureEchoOffline();

  const body = 'x'.repeat(100);
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== body.length) {
    throw new Error(`请求体长度不匹配: 期望 ${body.length}，实际 ${data.bodyLength}`);
  }
}

/** 2. 按需启动 POST 中等请求体 (100KB) */
async function test_on_demand_post_medium() {
  await ensureEchoOffline();

  const body = 'y'.repeat(100 * 1024);
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/big-body',
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== body.length) {
    throw new Error(`请求体长度不匹配: 期望 ${body.length}，实际 ${data.bodyLength}`);
  }
}

/** 3. 按需启动 POST 大请求体 (500KB) */
async function test_on_demand_post_large() {
  await ensureEchoOffline();

  const body = 'z'.repeat(500 * 1024);
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/big-body',
    method: 'POST',
    body,
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== body.length) {
    throw new Error(`请求体长度不匹配: 期望 ${body.length}，实际 ${data.bodyLength}`);
  }
}

/** 4. 按需启动 PUT 请求体 */
async function test_on_demand_put() {
  await ensureEchoOffline();

  const body = 'put-test-data-12345';
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body,
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.method !== 'put') {
    throw new Error(`方法不匹配: ${data.method}`);
  }
  if (data.body !== body) {
    throw new Error(`请求体不匹配`);
  }
}

/** 5. 按需启动 PATCH 请求体 */
async function test_on_demand_patch() {
  await ensureEchoOffline();

  const body = JSON.stringify({ op: 'replace', path: '/name', value: 'test' });
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body,
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.method !== 'patch') {
    throw new Error(`方法不匹配: ${data.method}`);
  }
  if (data.body !== body) {
    throw new Error(`请求体不匹配`);
  }
}

/** 6. 热代理 POST 请求体（对照基准） */
async function test_hot_proxy_post() {
  await ensureEchoOnline();

  const body = 'hot-proxy-body-check';
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.body !== body) {
    throw new Error(`热代理请求体不匹配`);
  }
}

/** 7. 端口路由 POST 请求体 */
async function test_port_route_post() {
  await ensureEchoOnline();

  const body = 'port-route-post-body';
  const res = await httpRequest({
    port: 3092,
    path: '/echo',
    method: 'POST',
    body,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.body !== body) {
    throw new Error(`端口路由请求体不匹配`);
  }
}

/** 8. JSON 请求体完整性 */
async function test_json_body_integrity() {
  await ensureEchoOffline();

  const jsonBody = JSON.stringify({
    key: 'value',
    nested: { a: 1, b: [1, 2, 3] },
    special: '中文测试',
    num: 3.14159,
  });

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonBody,
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.body !== jsonBody) {
    throw new Error('JSON 请求体不匹配');
  }
}

/** 9. 二进制请求体（非 UTF-8 字符） */
async function test_binary_body() {
  await ensureEchoOnline();

  /** 生成包含各种字节的 body */
  const bytes = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const body = bytes.toString('binary');

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== 256) {
    throw new Error(`二进制请求体长度不匹配: 期望 256，实际 ${data.bodyLength}`);
  }
}

/** 10. 空请求体按需启动 */
async function test_empty_body_on_demand() {
  await ensureEchoOffline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== 0) {
    throw new Error(`空请求体长度不匹配: 期望 0，实际 ${data.bodyLength}`);
  }
}

/** 11. Content-Type 各种类型 */
async function test_content_types() {
  await ensureEchoOnline();

  const types = [
    { ct: 'application/x-www-form-urlencoded', body: 'a=1&b=2&c=3' },
    { ct: 'text/xml', body: '<root><item>test</item></root>' },
    { ct: 'text/plain', body: 'plain text content' },
  ];

  for (const { ct, body } of types) {
    const res = await httpRequest({
      hostname: 'echo-host.test',
      path: '/echo',
      method: 'POST',
      headers: { 'Content-Type': ct },
      body,
      timeout: 5000,
    });

    if (res.status !== 200) {
      throw new Error(`Content-Type ${ct}: 期望 200，实际 ${res.status}`);
    }

    const data = JSON.parse(res.body);
    if (data.body !== body) {
      throw new Error(`Content-Type ${ct}: 请求体不匹配`);
    }
  }
}

/** 12. 超大请求体 (15MB > 10MB 限制应被截断或拒绝) */
async function test_oversized_body_on_demand() {
  await ensureEchoOffline();

  const body = 'x'.repeat(15 * 1024 * 1024);
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/big-body',
    method: 'POST',
    body,
    timeout: 30000,
  });

  /** 超大请求体可能被截断或返回错误 */
  if (res.status === 200) {
    const data = JSON.parse(res.body);
    if (data.bodyLength >= body.length) {
      throw new Error(`15MB 请求体未被截断: ${data.bodyLength}`);
    }
    /** 截断是正常行为 */
  } else if (res.status !== 502 && res.status !== 503) {
    throw new Error(`期望 200/502/503，实际 ${res.status}`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n📋 DynaPM POST 请求体完整性专项测试', C.cyan);

  section('环境准备');

  for (const port of [3090, 3091, 3092, 3099, 3010, 3011]) {
    await killPort(port);
  }
  await sleep(1000);

  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  await sleep(1000);
  if (!await waitForPort(3090, 10000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3091, 5000);
  await waitForPort(3092, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(500);

  section('按需启动 POST 请求体测试');

  await runTest('按需启动 POST 小请求体 (100B)', test_on_demand_post_small);
  await runTest('按需启动 POST 中等请求体 (100KB)', test_on_demand_post_medium);
  await runTest('按需启动 POST 大请求体 (500KB)', test_on_demand_post_large);
  await runTest('按需启动 PUT 请求体', test_on_demand_put);
  await runTest('按需启动 PATCH 请求体', test_on_demand_patch);
  await runTest('空请求体按需启动', test_empty_body_on_demand);

  section('热代理与端口路由 POST 对照测试');

  await runTest('热代理 POST 请求体', test_hot_proxy_post);
  await runTest('端口路由 POST 请求体', test_port_route_post);

  section('请求体内容完整性测试');

  await runTest('JSON 请求体完整性', test_json_body_integrity);
  await runTest('二进制请求体 (非 UTF-8)', test_binary_body);
  await runTest('多种 Content-Type', test_content_types);

  section('请求体大小限制测试');

  await runTest('超大请求体 (15MB > 10MB 限制)', test_oversized_body_on_demand);

  section('清理环境');

  for (const port of [3090, 3091, 3092, 3099, 3010, 3011]) {
    await killPort(port);
  }
  await sleep(500);
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
    log('\n🎉 所有 POST 请求体测试通过！', C.green);
    process.exit(0);
  } else {
    log(`\n❌ ${failedCount} 个测试失败`, C.red);
    process.exit(1);
  }
}

main().catch(err => {
  log(`测试执行失败: ${err}`, C.red);
  console.error(err);
  process.exit(1);
});
