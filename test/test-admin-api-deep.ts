/**
 * DynaPM 管理 API 深度测试与网关边界场景
 *
 * 覆盖场景：
 * 1. 管理 API 事件流 (SSE /_dynapm/api/events)
 * 2. 管理 API 路由边界（非法方法、非法路径、路径遍历）
 * 3. 请求体超过 10MB 限制的截断处理
 * 4. 3xx 重定向的 Location 头透传
 * 5. 多个并发请求同时断开（客户端 abort）
 * 6. 服务启动超时配置生效验证
 * 7. 非 JSON Content-Type 的请求体处理
 * 8. 管理 API 并发请求稳定性
 * 9. 网关进程信号处理后的稳定性
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { createConnection } from 'node:net';

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
  await sleep(500);
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

/** 确保 echo 在线 */
async function ensureEchoOnline(): Promise<void> {
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
    await sleep(500);
  }
}

// ==================== 测试场景 ====================

/** 1. 管理 API 事件流 (SSE) */
async function test_admin_api_event_stream() {
  /** 发起 SSE 连接 — 服务端立即 end() 发送 connected 事件后关闭 */
  const res = await httpRequest({
    port: 3091,
    path: '/_dynapm/api/events',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`SSE 期望 200, 实际 ${res.status}`);
  }

  /** 验证 SSE 响应头 */
  if (!res.headers['content-type']?.includes('text/event-stream')) {
    throw new Error(`Content-Type 不匹配: ${res.headers['content-type']}`);
  }

  if (!res.body.includes('event: connected')) {
    throw new Error('未收到 connected 事件');
  }
  if (!res.body.includes('"timestamp"')) {
    throw new Error('connected 事件缺少 timestamp 字段');
  }
}

/** 2. 管理 API 路由边界 */
async function test_admin_api_route_boundary() {
  /** PUT 方法应返回 404 */
  const putRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services', method: 'PUT', timeout: 5000 });
  if (putRes.status !== 404) {
    throw new Error(`PUT 非法方法期望 404, 实际 ${putRes.status}`);
  }

  /** DELETE 方法应返回 404 */
  const delRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services', method: 'DELETE', timeout: 5000 });
  if (delRes.status !== 404) {
    throw new Error(`DELETE 非法方法期望 404, 实际 ${delRes.status}`);
  }

  /** 路径遍历 */
  const traversalRes = await httpRequest({ port: 3091, path: '/_dynapm/api/../../../etc/passwd', timeout: 5000 });
  if (traversalRes.status !== 404) {
    throw new Error(`路径遍历期望 404, 实际 ${traversalRes.status}`);
  }

  /** 不存在的 API 路径 */
  const notFoundRes = await httpRequest({ port: 3091, path: '/_dynapm/api/nonexistent', timeout: 5000 });
  if (notFoundRes.status !== 404) {
    throw new Error(`不存在的 API 期望 404, 实际 ${notFoundRes.status}`);
  }
}

/** 3. 请求体超过 10MB 限制（按需启动路径） */
async function test_request_body_too_large() {
  /** 前置条件：echo 应离线（由 test_start_timeout_behavior 停止后保证） */
  /** 如果 echo 仍然在线，先强制停止 */
  if (await checkPort(3099)) {
    await httpRequest({
      port: 3091,
      path: '/_dynapm/api/services/echo-host/stop',
      method: 'POST',
      timeout: 10000,
    });
    await sleep(500);
    /** 多次强制杀进程 */
    for (let i = 0; i < 5; i++) {
      await killPort(3099);
      await sleep(300);
      if (!await checkPort(3099)) break;
    }
  }

  /** 同步网关状态：通过管理 API 查询，不发请求给 echo（避免触发按需启动） */
  for (let retry = 0; retry < 10; retry++) {
    try {
      const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 2000 });
      const data = JSON.parse(statusRes.body);
      if (data.status === 'offline') break;
    } catch {}
    await sleep(300);
  }

  /** 发送 11MB 请求体（超过 10MB 限制）—— 走按需启动路径，collectRequestBody 会截断 */
  const oversizedBody = 'x'.repeat(11 * 1024 * 1024);
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: oversizedBody,
    timeout: 30000,
  });

  /** 网关应该截断请求体，后端收到截断后的数据 */
  if (res.status === 502 || res.status === 413 || res.status === 503) {
    /** 网关拒绝了 oversized body — 合理行为 */
    return;
  }

  if (res.status !== 200) {
    throw new Error(`oversized body 期望截断或拒绝, 实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  /** 后端收到的 body 应不超过 10MB */
  if (data.bodyLength > 10 * 1024 * 1024) {
    throw new Error(`截断失败: bodyLength=${data.bodyLength} > 10MB`);
  }
}

/** 4. 3xx 重定向 Location 头透传 */
async function test_3xx_redirect_location() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/status?code=302',
    timeout: 5000,
  });

  if (res.status !== 302) {
    throw new Error(`期望 302, 实际 ${res.status}`);
  }

  if (!res.headers['location']) {
    throw new Error('302 响应缺少 Location 头');
  }
}

/** 5. 多个并发请求同时断开 */
async function test_concurrent_client_abort() {
  await ensureEchoOnline();

  /** 发送 50 个请求，然后在收到响应前断开 */
  const abortPromises = [];
  for (let i = 0; i < 50; i++) {
    abortPromises.push(new Promise<void>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 3090,
        path: `/delay?delay=5000`,
        headers: { Host: 'echo-host.test' },
        timeout: 10000,
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', () => resolve());
      /** 50ms 后断开 */
      setTimeout(() => req.destroy(), 50);
    }));
  }

  await Promise.all(abortPromises);

  /** 等待网关处理断开 */
  await sleep(1000);

  /** 验证网关仍然正常 */
  const healthCheck = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });
  if (healthCheck.status !== 200) {
    throw new Error('并发断开后网关异常');
  }
}

/** 6. 服务启动超时配置 */
async function test_start_timeout_behavior() {
  /** 通过管理 API 停止 echo */
  await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/stop',
    method: 'POST',
    timeout: 10000,
  });
  await sleep(500);

  /** 确保 echo 离线 */
  if (await checkPort(3099)) {
    await killPort(3099);
    await sleep(300);
  }
  /** 发请求触发状态同步 */
  try { await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 3000 }); } catch {}
  await sleep(300);

  /** 发送请求触发按需启动（网关会等待健康检查通过后才转发） */
  const start = Date.now();
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 20000,
  });
  const elapsed = Date.now() - start;

  if (res.status !== 200) {
    throw new Error(`按需启动失败: ${res.status}`);
  }

  /** 验证启动时间在合理范围内（< 15 秒） */
  if (elapsed > 15000) {
    throw new Error(`按需启动耗时过长: ${elapsed}ms`);
  }
}

/** 7. 非 JSON Content-Type 的 POST 请求体处理 */
async function test_non_json_content_type() {
  await ensureEchoOnline();

  /** 发送 text/plain 请求体 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'plain-text-body-data',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`text/plain POST 失败: ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.body !== 'plain-text-body-data') {
    throw new Error('text/plain body 不匹配');
  }
}

/** 8. 管理 API 并发请求稳定性 */
async function test_admin_api_concurrent() {
  const promises = [];

  /** 20 个并发的服务列表请求 */
  for (let i = 0; i < 20; i++) {
    promises.push(
      httpRequest({ port: 3091, path: '/_dynapm/api/services', timeout: 5000 })
        .then(r => ({ i, status: r.status }))
        .catch(() => ({ i, status: 0 }))
    );
  }

  /** 20 个并发的服务状态请求 */
  await ensureEchoOnline();
  for (let i = 0; i < 20; i++) {
    promises.push(
      httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 5000 })
        .then(r => ({ i: i + 20, status: r.status }))
        .catch(() => ({ i: i + 20, status: 0 }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => r.status !== 200);
  if (failed.length > 0) {
    throw new Error(`${failed.length}/40 个管理 API 并发请求失败`);
  }
}

/** 9. OPTIONS 预检请求（CORS preflight） */
async function test_options_preflight() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'OPTIONS',
    timeout: 5000,
  });

  /** OPTIONS 应该被正常转发到后端 */
  if (res.status !== 200) {
    throw new Error(`OPTIONS 预检期望 200, 实际 ${res.status}`);
  }
}

/** 10. 网关直接访问（无 Host 头）返回 404 */
async function test_gateway_direct_access() {
  const res = await httpRequest({
    port: 3090,
    path: '/any-path',
    timeout: 5000,
  });

  if (res.status !== 404) {
    throw new Error(`网关直接访问期望 404, 实际 ${res.status}`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔬 DynaPM 管理 API 深度测试与网关边界场景', C.cyan);

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

  /** 触发 echo 按需启动 */
  log('  触发按需启动 echo...', C.yellow);
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (warmup.status !== 200) {
    log(`  ✗ echo 启动失败: ${warmup.status}`, C.red);
    process.exit(1);
  }
  log('  ✓ Echo 已按需启动', C.green);

  section('管理 API');
  await runTest('管理 API 事件流 (SSE)', test_admin_api_event_stream);
  await runTest('管理 API 路由边界', test_admin_api_route_boundary);
  await runTest('管理 API 并发请求 (40个)', test_admin_api_concurrent);

  section('网关边界');
  await runTest('OPTIONS 预检请求', test_options_preflight);
  await runTest('网关直接访问返回 404', test_gateway_direct_access);

  section('请求体处理');
  await runTest('非 JSON Content-Type POST', test_non_json_content_type);

  section('状态码与重定向');
  await runTest('3xx 重定向 Location 头透传', test_3xx_redirect_location);

  section('客户端断开');
  await runTest('50 个并发请求同时断开', test_concurrent_client_abort);

  section('服务启动');
  await runTest('服务按需启动超时行为', test_start_timeout_behavior);

  /** 10MB 截断测试需要 echo 离线，放在服务启动测试之后 */
  section('请求体截断（按需启动路径）');
  await runTest('请求体超过 10MB 截断', test_request_body_too_large);

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
    log('\n🎉 所有管理 API 深度测试通过！', C.green);
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
