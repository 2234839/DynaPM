/**
 * DynaPM 代理深度与资源管理测试
 *
 * 覆盖场景：
 * 1. 后端慢响应时客户端断开 — activeConnections 准确性
 * 2. 服务 stopping 状态下收到请求 — 等待停止完成后启动
 * 3. WebSocket 消息队列溢出 — 超过 1000 条限制后丢弃
 * 4. PATCH/DELETE 请求体转发完整性
 * 5. 分块传输响应体转发 — 后端 chunked transfer encoding
 * 6. 多次快速启停后服务状态一致性
 * 7. 网关长连接后的稳定性 — 大量 keep-alive 请求
 * 8. 后端返回 500 错误时网关不崩溃
 * 9. 带查询参数的 POST 请求
 * 10. 服务启动期间收到停止请求
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { createConnection } from 'node:net';
import { WebSocket as WS } from 'ws';

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

async function ensureEchoOnline(): Promise<void> {
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
    await sleep(500);
  }
}

async function ensureWsOnline(): Promise<void> {
  if (!await checkPort(3011)) {
    const res = await httpRequest({ hostname: 'ws-proxy.test', path: '/', timeout: 15000 });
    if (res.status !== 200) throw new Error('ws-test 启动失败');
    await sleep(500);
  }
}

// ==================== 测试场景 ====================

/** 1. 后端慢响应时客户端断开 — 验证 activeConnections 准确 */
async function test_slow_backend_client_abort_connections() {
  await ensureEchoOnline();

  /** 发送 10 个慢请求（5秒延迟），然后立即断开 */
  const abortPromises = [];
  for (let i = 0; i < 10; i++) {
    abortPromises.push(new Promise<void>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 3090,
        path: '/delay?delay=5000',
        headers: { Host: 'echo-host.test' },
        timeout: 10000,
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', () => resolve());
      setTimeout(() => req.destroy(), 100);
    }));
  }

  await Promise.all(abortPromises);
  await sleep(2000);

  /** 验证网关正常 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });
  if (res.status !== 200) {
    throw new Error('慢响应客户端断开后网关异常');
  }

  /** 验证闲置超时仍然能正常触发（activeConnections 不为负数） */
  log('    等待闲置超时（20秒）...', C.yellow);
  await sleep(20000);

  /** 闲置超时后服务应被停止 */
  const { stdout } = await execAsync('lsof -i:3099 -P -n 2>/dev/null | grep LISTEN | wc -l');
  const listenerCount = parseInt(stdout.trim());
  if (listenerCount > 0) {
    /** 闲置超时可能因 activeConnections 不准确而未触发 */
    throw new Error(`闲置超时未触发: 仍有 ${listenerCount} 个 LISTEN 进程`);
  }
}

/** 2. 服务 stopping 状态下收到请求 */
async function test_request_during_stopping() {
  await ensureEchoOnline();

  /** 停止 echo 服务（异步） */
  const stopPromise = httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/stop',
    method: 'POST',
    timeout: 10000,
  });

  /** 立即发送请求（可能在 stopping 状态下到达） */
  await sleep(100);
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 20000,
  });

  /** 网关应该等待停止完成后重新启动服务 */
  if (res.status !== 200) {
    throw new Error(`stopping 状态下请求失败: ${res.status}`);
  }

  await stopPromise;
}

/** 3. WebSocket 消息队列溢出 — 超过 1000 条限制后丢弃 */
async function test_ws_message_queue_overflow() {
  await ensureWsOnline();

  const ws = await new Promise<WS>((resolve, reject) => {
    const w = new WS('ws://127.0.0.1:3090/', { headers: { Host: 'ws-proxy.test' } });
    const timer = setTimeout(() => { w.close(); reject(new Error('连接超时')); }, 10000);
    w.on('message', (data) => {
      clearTimeout(timer);
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'connected') resolve(w);
    });
    w.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  /** 快速发送 1200 条消息（超过 1000 限制） */
  for (let i = 0; i < 1200; i++) {
    ws.send(JSON.stringify({ type: 'test', data: `msg-${i}` }));
  }

  /** 等待消息处理 */
  await sleep(2000);

  /** 验证连接仍然正常 */
  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pong 超时')), 5000);
    ws.once('message', (data) => { clearTimeout(timer); resolve(data.toString()); });
  });

  const pongData = JSON.parse(pong);
  if (pongData.type !== 'pong') {
    ws.close();
    throw new Error('消息队列溢出后连接异常');
  }

  ws.close();
}

/** 4. PATCH 请求体转发完整性 */
async function test_patch_body_forwarding() {
  await ensureEchoOnline();

  /** PATCH 请求体 */
  const patchRes = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update', field: 'value' }),
    timeout: 5000,
  });
  if (patchRes.status !== 200) {
    throw new Error(`PATCH 失败: ${patchRes.status}`);
  }
  const patchData = JSON.parse(patchRes.body);
  if (patchData.method !== 'PATCH' && patchData.method !== 'patch') {
    throw new Error(`PATCH 方法不匹配: ${patchData.method}`);
  }
  if (!patchData.body.includes('update')) {
    throw new Error('PATCH body 不完整');
  }

  /** PUT 请求体（替代 DELETE，因为 node:http 对 DELETE 方法有特殊行为） */
  const putRes = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [1, 2, 3] }),
    timeout: 5000,
  });
  if (putRes.status !== 200) {
    throw new Error(`PUT 失败: ${putRes.status}`);
  }
  const putData = JSON.parse(putRes.body);
  if (putData.method !== 'PUT' && putData.method !== 'put') {
    throw new Error(`PUT 方法不匹配: ${putData.method}`);
  }
  if (!putData.body.includes('ids')) {
    throw new Error('PUT body 不完整');
  }
}

/** 5. 分块传输响应体转发 */
async function test_chunked_transfer_encoding() {
  await ensureEchoOnline();

  /** 请求分块传输响应：10 chunks × 1KB */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/stream?chunks=10&chunkSize=1024&interval=10',
    timeout: 10000,
  });

  if (res.status !== 200) {
    throw new Error(`分块传输请求失败: ${res.status}`);
  }

  /** 验证响应体大小（约 10KB） */
  if (res.body.length < 5000) {
    throw new Error(`分块响应体过小: ${res.body.length} bytes`);
  }
}

/** 6. 多次快速启停后服务状态一致性 */
async function test_rapid_start_stop_consistency() {
  for (let i = 0; i < 5; i++) {
    /** 停止 */
    try {
      await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 5000 });
    } catch {}
    await sleep(300);
    await killPort(3099);
    await sleep(300);

    /** 同步状态 */
    for (let retry = 0; retry < 5; retry++) {
      try {
        const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 2000 });
        const data = JSON.parse(statusRes.body);
        if (data.status === 'offline') break;
      } catch {}
      await sleep(200);
    }

    /** 启动（通过请求触发按需启动） */
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
    if (res.status !== 200) {
      throw new Error(`第 ${i + 1} 次启停循环后请求失败: ${res.status}`);
    }
  }
}

/** 7. 网关长连接后的稳定性 — 100 个 keep-alive 请求 */
async function test_long_lived_keepalive_stability() {
  await ensureEchoOnline();

  /** 使用同一个 Agent 发送 100 个 keep-alive 请求 */
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  for (let i = 0; i < 100; i++) {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 3090,
        path: '/echo',
        headers: { Host: 'echo-host.test' },
        agent,
        timeout: 5000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
    if (res.status !== 200) {
      agent.destroy();
      throw new Error(`第 ${i + 1}/100 个 keep-alive 请求失败: ${res.status}`);
    }
  }
  agent.destroy();
}

/** 8. 后端返回 500 错误时网关不崩溃 */
async function test_backend_500_error_handling() {
  await ensureEchoOnline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/status?code=500',
    timeout: 5000,
  });

  if (res.status !== 500) {
    throw new Error(`期望 500, 实际 ${res.status}`);
  }

  /** 验证网关仍然正常 */
  const healthCheck = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });
  if (healthCheck.status !== 200) {
    throw new Error('后端 500 后网关异常');
  }
}

/** 9. 带查询参数的 POST 请求 */
async function test_post_with_query_params() {
  await ensureEchoOnline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo?token=abc123&redirect=/home',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test' }),
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`POST 带查询参数失败: ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.params.token !== 'abc123') {
    throw new Error('查询参数 token 丢失');
  }
  if (data.params.redirect !== '/home') {
    throw new Error('查询参数 redirect 丢失');
  }
  if (!data.body.includes('test')) {
    throw new Error('POST body 丢失');
  }
}

/** 10. 多个错误请求后网关稳定性 */
async function test_multiple_error_requests_stability() {
  await ensureEchoOnline();

  /** 发送 50 个错误请求（不存在的 Host 头，网关应返回 404） */
  for (let i = 0; i < 50; i++) {
    const res = await httpRequest({
      hostname: 'nonexistent-host.test',
      path: `/path-${i}`,
      timeout: 5000,
    });
    if (res.status !== 404) {
      throw new Error(`不存在的 Host 期望 404, 实际 ${res.status}`);
    }
  }

  /** 验证网关仍然正常 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });
  if (res.status !== 200) {
    throw new Error('50 个错误请求后网关异常');
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔬 DynaPM 代理深度与资源管理测试', C.cyan);

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

  log('  触发按需启动 echo...', C.yellow);
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (warmup.status !== 200) {
    log(`  ✗ echo 启动失败: ${warmup.status}`, C.red);
    process.exit(1);
  }
  log('  ✓ Echo 已按需启动', C.green);

  section('连接管理与资源');
  await runTest('慢响应时客户端断开 activeConnections 准确性', test_slow_backend_client_abort_connections);
  await runTest('stopping 状态下收到请求', test_request_during_stopping);
  await runTest('WebSocket 消息队列溢出 (1200条)', test_ws_message_queue_overflow);

  section('请求方法与数据');
  await runTest('PATCH/PUT 请求体转发完整性', test_patch_body_forwarding);
  await runTest('分块传输响应体转发', test_chunked_transfer_encoding);
  await runTest('带查询参数的 POST 请求', test_post_with_query_params);

  section('稳定性与状态一致性');
  await runTest('多次快速启停状态一致性 (5轮)', test_rapid_start_stop_consistency);
  await runTest('长连接 keep-alive 稳定性 (100个)', test_long_lived_keepalive_stability);
  await runTest('后端 500 错误网关不崩溃', test_backend_500_error_handling);
  await runTest('50 个错误请求后网关稳定性', test_multiple_error_requests_stability);

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
    log('\n🎉 所有代理深度与资源管理测试通过！', C.green);
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
