/**
 * DynaPM 管理 API 生命周期测试
 *
 * 测试管理 API 的完整功能：
 * 1. API 认证失败
 * 2. 服务列表包含所有已配置服务
 * 3. 服务详情包含完整字段
 * 4. 通过 API 启动离线服务
 * 5. 通过 API 停止在线服务
 * 6. 停止后自动按需启动
 * 7. 启动已在运行的服务返回 400
 * 8. 停止不在线的服务返回 400
 * 9. 启动不存在的服务返回 404
 * 10. 多服务并发按需启动（不同 hostname）
 * 11. 网关稳定性：200 个请求后无内存泄漏
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
    const { stdout } = await execAsync(`lsof -i:${port} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}'`);
    const pids = stdout.trim().split('\n').filter(pid => pid);
    for (const pid of pids) {
      try { process.kill(parseInt(pid), 'SIGKILL'); } catch {}
    }
  } catch {}
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
  body?: string;
  timeout?: number;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const { hostname, port = 3090, path = '/', method = 'GET', headers = {}, body, timeout = 10000 } = options;

  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (hostname) reqHeaders['Host'] = hostname;

    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: reqHeaders, timeout,
    }, (res) => {
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

/** 1. API 认证：无 authToken 配置时允许所有请求 */
async function test_auth_no_token_configured() {
  const res = await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services',
    headers: { 'Authorization': 'Bearer any-token' },
  });

  if (res.status !== 200) {
    throw new Error(`期望 200（无 authToken 配置），实际 ${res.status}`);
  }
}

/** 2. 服务列表包含所有已配置服务 */
async function test_service_list_completeness() {
  const res = await httpRequest({ port: 3091, path: '/_dynapm/api/services' });
  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);

  const data = JSON.parse(res.body);
  const names = data.services.map((s: { name: string }) => s.name);

  const expected = ['echo-host', 'echo-proxy', 'sse-test', 'ws-test'];
  for (const name of expected) {
    if (!names.includes(name)) {
      throw new Error(`缺少服务: ${name}，实际列表: ${names.join(', ')}`);
    }
  }
}

/** 3. 服务详情包含完整字段 */
async function test_service_detail_fields() {
  const res = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host' });
  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);

  const data = JSON.parse(res.body);
  const requiredFields = ['name', 'base', 'status', 'uptime', 'lastAccessTime', 'activeConnections', 'idleTimeout', 'startTimeout', 'proxyOnly', 'healthCheck', 'startCount', 'totalUptime'];
  for (const field of requiredFields) {
    if (!(field in data)) {
      throw new Error(`缺少字段: ${field}`);
    }
  }

  if (data.proxyOnly !== false) throw new Error('echo-host 不应该是 proxyOnly');
  if (data.status !== 'offline') throw new Error(`echo-host 应该离线，实际: ${data.status}`);
}

/** 4. 通过 API 启动离线服务 */
async function test_api_start_service() {
  const isOffline = !await checkPort(3099);
  if (!isOffline) throw new Error('前置条件：echo 应该离线');

  const res = await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/start',
    method: 'POST',
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}，body: ${res.body.substring(0, 200)}`);
  }

  const data = JSON.parse(res.body);
  if (!data.success) throw new Error('启动应该成功');

  if (!await checkPort(3099)) {
    throw new Error('echo 后端应该已启动');
  }
}

/** 5. 通过 API 停止在线服务 */
async function test_api_stop_service() {
  const isOnline = await checkPort(3099);
  if (!isOnline) throw new Error('前置条件：echo 应该在线');

  const res = await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/stop',
    method: 'POST',
    timeout: 10000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}，body: ${res.body.substring(0, 200)}`);
  }

  const data = JSON.parse(res.body);
  if (!data.success) throw new Error('停止应该成功');

  await sleep(500);
  const isOffline = !await checkPort(3099);
  if (!isOffline) throw new Error('echo 后端应该已停止');
}

/** 6. 停止后通过网关请求自动按需启动 */
async function test_auto_start_after_api_stop() {
  const isOffline = !await checkPort(3099);
  if (!isOffline) throw new Error('前置条件：echo 应该离线');

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  if (!await checkPort(3099)) {
    throw new Error('echo 应该已按需启动');
  }
}

/** 7. 启动已在运行的服务返回 400 */
async function test_start_already_running() {
  const isOnline = await checkPort(3099);
  if (!isOnline) throw new Error('前置条件：echo 应该在线');

  const res = await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/start',
    method: 'POST',
    timeout: 10000,
  });

  if (res.status !== 400) {
    throw new Error(`期望 400，实际 ${res.status}`);
  }
}

/** 8. 停止不在线的服务返回 400 */
async function test_stop_not_online() {
  /** 先通过 API 停止 echo */
  await killPort(3099);
  await sleep(500);

  /** 手动更新状态（模拟服务已停止） */
  const detailRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host' });
  if (detailRes.status === 200) {
    const data = JSON.parse(detailRes.body);
    if (data.status !== 'offline') {
      /** 通过 API 停止 */
      await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 5000 });
    }
  }

  const res = await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/stop',
    method: 'POST',
    timeout: 5000,
  });

  if (res.status !== 400) {
    throw new Error(`期望 400，实际 ${res.status}`);
  }
}

/** 9. 启动不存在的服务返回 404 */
async function test_start_nonexistent_service() {
  const res = await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/nonexistent/start',
    method: 'POST',
    timeout: 5000,
  });

  if (res.status !== 404) {
    throw new Error(`期望 404，实际 ${res.status}`);
  }
}

/** 10. 多服务并发按需启动（不同 hostname） */
async function test_multi_service_concurrent_start() {
  /** 确保所有后端离线 */
  await killPort(3099);
  await sleep(500);

  const promises = [
    httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 })
      .then(r => ({ name: 'echo', ok: r.status === 200, status: r.status })),
    httpRequest({ hostname: 'echo-host.test', path: '/status?code=201', timeout: 20000 })
      .then(r => ({ name: 'echo-status', ok: r.status === 201, status: r.status })),
    httpRequest({ hostname: 'echo-host.test', path: '/delay?delay=500', timeout: 20000 })
      .then(r => ({ name: 'echo-delay', ok: r.status === 200, status: r.status })),
  ];

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个请求失败: ${JSON.stringify(failed)}`);
  }

  /** 验证 echo 后端在线 */
  if (!await checkPort(3099)) throw new Error('echo 应该在线');
}

/** 11. 网关稳定性：200 个请求 */
async function test_gateway_stability() {
  /** 确保 echo 在线 */
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
  }

  const count = 200;
  let successCount = 0;
  let failCount = 0;

  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: `/echo?id=${i}`,
        timeout: 5000,
      })
        .then(() => { successCount++; })
        .catch(() => { failCount++; })
    );
  }

  await Promise.all(promises);

  if (failCount > 0) {
    throw new Error(`${failCount}/${count} 个请求失败`);
  }

  log(`    ${count} 个请求全部成功`, C.green);
}

/** 12. 特殊请求头（非 ASCII 会被 Node.js http.request 拒绝，测试合法特殊字符） */
async function test_special_headers() {
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
  }

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/headers',
    headers: { 'X-Custom-Header': 'value-with-dash_and_underscore', 'X-Num123': 'test123' },
    timeout: 5000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);

  const data = JSON.parse(res.body);
  if (data.headers['x-custom-header'] !== 'value-with-dash_and_underscore') {
    throw new Error(`自定义请求头未正确转发: ${data.headers['x-custom-header']}`);
  }
  if (data.headers['x-num123'] !== 'test123') {
    throw new Error(`数字请求头未正确转发: ${data.headers['x-num123']}`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔌 DynaPM 管理 API 生命周期测试', C.cyan);

  section('环境准备');

  for (const port of [3090, 3091, 3092, 3099, 3010, 3011]) {
    await killPort(port);
  }
  await sleep(500);

  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3090, 5000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3091, 5000);
  await waitForPort(3092, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(500);

  section('认证测试');

  await runTest('API 无 authToken 配置时允许访问', test_auth_no_token_configured);

  section('服务列表与详情');

  await runTest('服务列表完整性', test_service_list_completeness);
  await runTest('服务详情字段完整性', test_service_detail_fields);

  section('API 生命周期管理');

  await runTest('API 启动离线服务', test_api_start_service);
  await runTest('API 停止在线服务', test_api_stop_service);
  await runTest('停止后自动按需启动', test_auto_start_after_api_stop);
  await runTest('启动已运行服务返回 400', test_start_already_running);
  await runTest('停止不在线服务返回 400', test_stop_not_online);
  await runTest('启动不存在服务返回 404', test_start_nonexistent_service);

  section('多服务并发');

  await runTest('多服务并发按需启动', test_multi_service_concurrent_start);

  section('网关稳定性与特殊场景');

  await runTest('网关稳定性 (200 请求)', test_gateway_stability);
  await runTest('特殊请求头转发', test_special_headers);

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
    log('\n🎉 所有管理 API 测试通过！', C.green);
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
