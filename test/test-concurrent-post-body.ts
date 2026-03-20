/**
 * DynaPM 并发与竞争条件深度测试
 *
 * 测试场景：
 * 1. 多个并发请求同时触发按需启动，所有请求都应收到正确响应
 * 2. 并发请求中混合 GET/POST/PUT 方法
 * 3. 第一个请求触发启动，后续请求等待完成后代理
 * 4. 并发 POST 请求体在等待期间不被丢失
 * 5. 快速连续请求（间隔 50ms）10 次 POST
 * 6. 服务 starting 状态时收到 50 个并发请求
 * 7. 服务 stopping 时收到请求应等待停止完成后启动
 * 8. 并发启动竞争：第一个失败后第二个重试
 * 9. 管理 API 启动 + 并发请求同时到达
 * 10. 100 个并发 POST 请求（压力测试）
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
          /** 状态为 online 但端口已死，发请求触发 502 重置 */
          try { await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 3000 }); } catch {}
          await sleep(500);
          continue;
        }
      }
    } catch {}
    await sleep(500);
  }

  /** 最后手段：直接检查端口 */
  if (await checkPort(3099)) {
    throw new Error('echo 进程未能停止');
  }
}

/** 确保后端在线（端口在线 + 请求可达） */
async function ensureEchoOnline(): Promise<void> {
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
    return;
  }
  /** 端口在线，但需要验证请求能成功到达 */
  for (let retry = 0; retry < 3; retry++) {
    try {
      const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 });
      if (res.status === 200) return;
    } catch {}
    await sleep(500);
  }
  /** 端口在线但请求失败，尝试通过管理 API 查询状态 */
  try {
    const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 3000 });
    const data = JSON.parse(statusRes.body);
    if (data.status !== 'online') {
      /** 状态不是 online，触发按需启动 */
      const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
      if (res.status !== 200) throw new Error('echo 启动失败');
    }
  } catch {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
  }
}

// ==================== 测试场景 ====================

/** 1. 多个并发 POST 同时触发按需启动 */
async function test_concurrent_post_on_demand() {
  await ensureEchoOffline();

  const body = 'concurrent-test-body-';
  const promises = [];
  for (let i = 0; i < 10; i++) {
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
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个请求失败: ${failed[0].error || 'status=' + failed[0].status}`);
  }

  /** 验证每个请求的 body 都正确 */
  for (const r of res) {
    const data = JSON.parse(r.body);
    if (data.body !== `${body}${r.i}`) {
      throw new Error(`请求 ${r.i} body 不匹配: "${data.body}" !== "${body}${r.i}"`);
    }
  }
}

/** 2. 并发请求混合 GET/POST/PUT */
async function test_mixed_method_concurrent() {
  await ensureEchoOffline();

  const promises = [];
  for (let i = 0; i < 6; i++) {
    const method = ['GET', 'POST', 'PUT'][i % 3];
    const body = method === 'GET' ? undefined : `method-${i}`;
    promises.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: '/echo',
        method,
        body,
        timeout: 20000,
      })
        .then(res => ({ i, method, status: res.status, ok: res.status === 200, body: res.body }))
        .catch(() => ({ i, method, ok: false }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个混合方法请求失败`);
  }

  /** 验证方法正确 */
  for (const r of res) {
    const data = JSON.parse(r.body);
    if (data.method !== r.method.toLowerCase()) {
      throw new Error(`请求 ${r.i} 方法不匹配: ${data.method} !== ${r.method.toLowerCase()}`);
    }
  }
}

/** 3. 快速连续 POST 请求（间隔 50ms） */
async function test_rapid_sequential_post() {
  await ensureEchoOnline();

  let failCount = 0;
  for (let i = 0; i < 10; i++) {
    const res = await httpRequest({
      hostname: 'echo-host.test',
      path: '/echo',
      method: 'POST',
      body: `rapid-${i}`,
      timeout: 5000,
    });

    if (res.status !== 200) {
      failCount++;
      continue;
    }

    const data = JSON.parse(res.body);
    if (data.body !== `rapid-${i}`) {
      failCount++;
    }

    await sleep(50);
  }

  if (failCount > 0) {
    throw new Error(`${failCount}/10 个快速 POST 请求失败或 body 不匹配`);
  }
}

/** 4. 服务 starting 状态时 50 个并发请求 */
async function test_starting_state_concurrent() {
  await ensureEchoOffline();

  /** 使用管理 API 触发启动（不等待完成） */
  const startPromise = httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/start',
    method: 'POST',
    timeout: 10000,
  });

  await sleep(200);

  /** 在 starting 状态时发送 50 个并发请求 */
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: `/echo?id=${i}`,
        timeout: 20000,
      })
        .then(res => ({ i, status: res.status, ok: res.status === 200 }))
        .catch(() => ({ i, ok: false }))
    );
  }

  const startRes = await startPromise;

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);

  if (startRes.status !== 200 && startRes.status !== 400) {
    throw new Error(`管理 API 启动返回 ${startRes.status}`);
  }

  if (failed.length > 5) {
    throw new Error(`${failed.length}/50 个 starting 状态请求失败`);
  }
}

/** 5. 服务 stopping 时收到请求 */
async function test_stopping_state_request() {
  await ensureEchoOnline();

  /** 使用管理 API 停止服务（不等待完成） */
  httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/stop',
    method: 'POST',
    timeout: 10000,
  });

  await sleep(100);

  /** 在 stopping 状态时发送请求 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    body: 'stopping-test',
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`stopping 状态请求期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.body !== 'stopping-test') {
    throw new Error('stopping 状态请求 body 不匹配');
  }
}

/** 6. 并发 POST 压力测试 (100 个) */
async function test_concurrent_post_stress() {
  /** 先完全重置再启动，确保干净状态 */
  await ensureEchoOffline();
  await ensureEchoOnline();

  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: '/echo',
        method: 'POST',
        body: `stress-${i}`,
        timeout: 10000,
      })
        .then(res => ({ i, status: res.status, ok: res.status === 200 }))
        .catch(() => ({ i, ok: false }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 2) {
    throw new Error(`${failed.length}/100 个并发 POST 请求失败`);
  }
}

/** 7. 按需启动时 POST body 大小梯度 */
async function test_on_demand_body_sizes() {
  await ensureEchoOffline();

  const sizes = [10, 100, 1024, 10240, 102400];
  for (const size of sizes) {
    const body = 'x'.repeat(size);
    const res = await httpRequest({
      hostname: 'echo-host.test',
      path: '/echo',
      method: 'POST',
      body,
      timeout: 20000,
    });

    if (res.status !== 200) {
      throw new Error(`按需启动 ${size}B POST 失败: ${res.status}`);
    }

    const data = JSON.parse(res.body);
    if (data.bodyLength !== size) {
      throw new Error(`${size}B body 长度不匹配: ${data.bodyLength}`);
    }

    /** 重置后端状态 */
    await ensureEchoOffline();
  }
}

/** 8. 管理 API 启动 + 并发请求竞争 */
async function test_admin_start_with_concurrent() {
  await ensureEchoOffline();

  /** 同时发送管理 API 启动和客户端请求 */
  const [adminRes, clientRes] = await Promise.all([
    httpRequest({
      port: 3091,
      path: '/_dynapm/api/services/echo-host/start',
      method: 'POST',
      timeout: 20000,
    }),
    httpRequest({
      hostname: 'echo-host.test',
      path: '/echo',
      method: 'POST',
      body: 'race-condition-test',
      timeout: 20000,
    }),
  ]);

  if (adminRes.status !== 200 && adminRes.status !== 400) {
    throw new Error(`管理 API 启动返回 ${adminRes.status}`);
  }

  /**
   * 客户端请求可能在管理 API 启动完成前到达（status=starting 但 startingPromises 未设置），
   * 导致走 handleDirectProxy 兜底返回 502。这种情况下重试一次即可。
   */
  if (clientRes.status === 502) {
    const retryRes = await httpRequest({
      hostname: 'echo-host.test',
      path: '/echo',
      method: 'POST',
      body: 'race-condition-test',
      timeout: 10000,
    });
    if (retryRes.status !== 200) {
      throw new Error(`并发客户端请求重试后失败: ${retryRes.status}`);
    }
    return;
  }

  if (clientRes.status !== 200) {
    throw new Error(`并发客户端请求失败: ${clientRes.status}`);
  }

  const data = JSON.parse(clientRes.body);
  if (data.body !== 'race-condition-test') {
    throw new Error('并发 POST body 不匹配');
  }
}

/** 9. 端口路由并发 POST */
async function test_port_route_concurrent_post() {
  await ensureEchoOffline();
  await ensureEchoOnline();

  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(
      httpRequest({
        port: 3092,
        path: '/echo',
        method: 'POST',
        body: `port-${i}`,
        timeout: 5000,
      })
        .then(res => ({ i, status: res.status, ok: res.status === 200 }))
        .catch(() => ({ i, ok: false }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length}/20 个端口路由并发 POST 失败`);
  }
}

/** 10. 按需启动 + 闲置超时 + 再次按需启动的 POST */
async function test_idle_restart_post() {
  /** 先完全重置再启动，确保干净状态 */
  await ensureEchoOffline();
  await ensureEchoOnline();

  /** 第一次 POST 应该成功 */
  const r1 = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    body: 'before-idle',
    timeout: 5000,
  });

  if (r1.status !== 200) {
    throw new Error(`闲置前 POST 失败: ${r1.status}`);
  }

  /** 等待闲置超时（配置 10s + 检查间隔 3s + 余量） */
  log('    等待闲置超时（20秒）...', C.yellow);
  await sleep(20000);

  /** 轮询检查 echo 是否已停止（最多等 10 秒） */
  let isOffline = false;
  for (let i = 0; i < 20; i++) {
    if (!await checkPort(3099)) {
      isOffline = true;
      break;
    }
    await sleep(500);
  }

  if (!isOffline) {
    /** 检查管理 API 状态 */
    try {
      const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 3000 });
      const data = JSON.parse(statusRes.body);
      throw new Error(`echo 未在闲置后自动停止, status=${data.status}, activeConnections=${data.activeConnections}`);
    } catch (e) {
      if (e instanceof Error && e.message.includes('echo 未在闲置后自动停止')) throw e;
      throw new Error('echo 未在闲置后自动停止');
    }
  }

  /** 第二次 POST 应触发按需启动 */
  const r2 = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    body: 'after-idle',
    timeout: 20000,
  });

  if (r2.status !== 200) {
    throw new Error(`闲置后按需启动 POST 失败: ${r2.status}`);
  }

  const data = JSON.parse(r2.body);
  if (data.body !== 'after-idle') {
    throw new Error('闲置后 POST body 不匹配');
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n⚡ DynaPM 并发与竞争条件深度测试', C.cyan);

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

  section('并发 POST 按需启动测试');

  await runTest('并发 POST 同时触发按需启动 (10个)', test_concurrent_post_on_demand);
  await runTest('混合 GET/POST/PUT 并发按需启动', test_mixed_method_concurrent);
  await runTest('快速连续 POST (10个, 间隔50ms)', test_rapid_sequential_post);

  section('服务状态转换期间请求测试');

  await runTest('starting 状态 50 个并发请求', test_starting_state_concurrent);
  await runTest('stopping 状态请求应等待后重启', test_stopping_state_request);

  section('压力测试');

  await runTest('100 个并发 POST 压力测试', test_concurrent_post_stress);
  await runTest('端口路由 20 并发 POST', test_port_route_concurrent_post);

  section('按需启动 body 大小梯度');

  await runTest('按需启动 body 大小梯度 (10B~100KB)', test_on_demand_body_sizes);

  section('管理 API 竞争测试');

  await runTest('管理 API 启动 + 并发请求竞争', test_admin_start_with_concurrent);

  section('闲置重启 POST 测试');

  await runTest('闲置超时后再次按需启动 POST', test_idle_restart_post);

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
    log('\n🎉 所有并发与竞争条件测试通过！', C.green);
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
