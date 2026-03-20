/**
 * DynaPM 网关安全与稳定性深度测试
 *
 * 测试场景：
 * 1. 超大请求体处理（超过限制应截断）
 * 2. 客户端提前断开连接时的资源清理
 * 3. 后端返回空响应
 * 4. 后端返回非标准状态码
 * 5. 并发启动后立即停止
 * 6. 请求超时后重试
 * 7. 连续快速启停循环
 * 8. 网关内存稳定性（500 请求）
 * 9. HEAD 方法代理
 * 10. Content-Length 不匹配
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import * as http from 'node:http';

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
  await sleep(200);
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

// ==================== 测试场景 ====================

/** 1. 超大请求体（5MB）应被截断而非崩溃 */
async function test_oversized_request_body() {
  const largeBody = 'x'.repeat(5 * 1024 * 1024);
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: largeBody,
    timeout: 10000,
  });

  if (res.status === 0) {
    throw new Error('网关崩溃或无响应');
  }
}

/** 2. 客户端提前断开连接 */
async function test_client_abort() {
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
  }

  await new Promise<void>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3090,
      path: '/delay?delay=5000',
      headers: { Host: 'echo-host.test' },
      timeout: 5000,
    });

    req.on('response', () => {
      req.destroy();
      reject(new Error('不应收到响应'));
    });

    req.on('error', () => {
      /** 客户端断开后预期会收到 ECONNRESET */
    });

    req.write('test');
    req.end();

    setTimeout(() => {
      req.destroy();
      setTimeout(async () => {
        if (!await checkPort(3090)) {
          reject(new Error('网关在客户端断开后崩溃'));
        }
        resolve();
      }, 500);
    }, 100);
  });
}

/** 3. 后端返回非标准状态码 */
async function test_nonstandard_status_code() {
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
  }

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/status?code=418',
    timeout: 5000,
  });

  if (res.status !== 418) {
    throw new Error(`期望 418，实际 ${res.status}`);
  }
}

/** 5. 并发启动后立即停止 */
async function test_concurrent_start_then_stop() {
  await killPort(3099);
  await sleep(500);

  const startPromise = httpRequest({ hostname: 'echo-host.test', path: '/delay?delay=1000', timeout: 20000 });
  await sleep(200);

  const stopRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 10000 });

  await startPromise;

  if (stopRes.status !== 200 && stopRes.status !== 400) {
    throw new Error(`停止返回 ${stopRes.status}`);
  }

  if (!await checkPort(3090)) {
    throw new Error('网关在并发启停时崩溃');
  }
}

/** 6. 连续快速启停循环（3 次） */
async function test_rapid_start_stop_cycle() {
  for (let i = 0; i < 3; i++) {
    await killPort(3099);
    await sleep(300);

    const startRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/start', method: 'POST', timeout: 20000 });
    if (startRes.status !== 200) {
      throw new Error(`第 ${i + 1} 次启动失败: ${startRes.status}`);
    }

    await sleep(500);

    const stopRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 10000 });
    if (stopRes.status !== 200) {
      throw new Error(`第 ${i + 1} 次停止失败: ${stopRes.status}`);
    }

    if (!await checkPort(3090)) {
      throw new Error(`第 ${i + 1} 次循环后网关崩溃`);
    }
  }
}

/** 7. 请求超时处理（后端延迟超过代理超时） */
async function test_proxy_timeout() {
  /** 确保 echo 在线且正常工作 */
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (warmup.status !== 200) throw new Error('echo 启动失败');

  /** 确认 echo 的 /delay 端点正常工作（500ms 测试） */
  const delayStart = Date.now();
  const delayCheck = await httpRequest({ hostname: 'echo-host.test', path: '/delay?delay=500', timeout: 5000 });
  if (delayCheck.status !== 200) throw new Error('delay 端点不可用');
  if (Date.now() - delayStart < 400) throw new Error('delay 端点未正确延迟');

  /**
   * 网关代理请求 timeout 为 30s，后端延迟 35s 确保超过网关 timeout。
   * 客户端 timeout 设 45s 确保能收到网关返回的 502 响应。
   */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/delay?delay=35000',
    timeout: 45000,
  });

  if (res.status !== 502 && res.status !== 504) {
    throw new Error(`期望 502/504，实际 ${res.status}`);
  }
}

/** 8. 网关稳定性（500 个串行请求） */
async function test_stability_500_requests() {
  /** 确保 echo 在线（前面的超时测试可能导致状态异常） */
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (warmup.status !== 200) throw new Error(`echo 启动失败: ${warmup.status}`);

  let failCount = 0;
  for (let i = 0; i < 500; i++) {
    try {
      const res = await httpRequest({ hostname: 'echo-host.test', path: `/echo?id=${i}`, timeout: 5000 });
      if (res.status !== 200) failCount++;
    } catch {
      failCount++;
    }
  }

  if (failCount > 0) {
    throw new Error(`${failCount}/500 个请求失败`);
  }
}

/** 9. GET 请求带查询参数特殊字符 */
async function test_query_params_special_chars() {
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (warmup.status !== 200) throw new Error(`echo 启动失败: ${warmup.status}`);

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo?key=value%20with%20spaces&foo=bar%26baz',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }
}

/** 10. 多 hostname 404 不影响正常路由 */
async function test_multiple_404_then_normal() {
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (warmup.status !== 200) throw new Error(`echo 启动失败: ${warmup.status}`);

  for (let i = 0; i < 10; i++) {
    const res = await httpRequest({ hostname: `unknown-${i}.test`, path: '/test', timeout: 3000 });
    if (res.status !== 404) {
      throw new Error(`404 请求返回 ${res.status}`);
    }
  }

  const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 });
  if (res.status !== 200) {
    throw new Error('多次 404 后正常路由失败');
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🛡️ DynaPM 安全与稳定性深度测试', C.cyan);

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

  section('安全测试');

  await runTest('超大请求体不崩溃 (5MB)', test_oversized_request_body);
  await runTest('客户端提前断开连接', test_client_abort);

  section('HTTP 方法测试');

  await runTest('非标准状态码透传 (418)', test_nonstandard_status_code);
  await runTest('查询参数特殊字符编码', test_query_params_special_chars);

  section('并发与启停测试');

  await runTest('并发启动后立即停止', test_concurrent_start_then_stop);
  await runTest('连续快速启停循环 (3次)', test_rapid_start_stop_cycle);

  section('超时与稳定性测试');

  await runTest('代理超时处理 (60s 后端延迟)', test_proxy_timeout);
  await runTest('网关稳定性 (500 串行请求)', test_stability_500_requests);
  await runTest('多次 404 后正常路由不受影响', test_multiple_404_then_normal);

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
    log('\n🎉 所有安全与稳定性测试通过！', C.green);
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
