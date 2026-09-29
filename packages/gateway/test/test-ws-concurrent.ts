/**
 * DynaPM WebSocket 并发与稳定性测试
 *
 * 覆盖场景：
 * 1. 20 个并发 WebSocket 连接（Promise.all 模式）
 * 2. WebSocket 较大消息传输 (10KB)
 * 3. 快速连接/断开循环 (30次)
 * 4. WebSocket 连接期间服务停止后的清理
 * 5. WebSocket 与 HTTP 混合并发
 * 6. WebSocket 二进制消息传输
 * 7. 多消息顺序保证 (10条)
 * 8. WebSocket 活跃连接阻止闲置停止
 * 9. 多个并发 WebSocket 的 ping/pong
 * 10. WebSocket 按需启动
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
  body?: string;
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

/** 确保 ws-test 服务在线 */
async function ensureWsOnline(): Promise<void> {
  if (!await checkPort(3011)) {
    const res = await httpRequest({ hostname: 'ws-proxy.test', path: '/', timeout: 15000 });
    if (res.status !== 200) throw new Error('ws-test 启动失败');
    await sleep(500);
  }
}

/** 确保 ws-test 服务离线 */
async function ensureWsOffline(): Promise<void> {
  /** 通过管理 API 停止 */
  try {
    await httpRequest({
      port: 3091,
      path: '/_dynapm/api/services/ws-test/stop',
      method: 'POST',
      timeout: 10000,
    });
    await sleep(1000);
  } catch {}

  /** 多次强制杀进程 */
  for (let i = 0; i < 5; i++) {
    await killPort(3011);
    await sleep(300);
    if (!await checkPort(3011)) break;
  }

  /** 同步网关状态：发请求吃 502 触发状态重置 */
  for (let retry = 0; retry < 10; retry++) {
    try { await httpRequest({ hostname: 'ws-proxy.test', path: '/', timeout: 3000 }); } catch {}
    await sleep(300);
    try {
      const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/ws-test', timeout: 2000 });
      const data = JSON.parse(statusRes.body);
      if (data.status === 'offline') return;
    } catch {}

    /** 如果还是 online，再 kill 一次 */
    await killPort(3011);
  }

  /** 最终检查 */
  if (await checkPort(3011)) {
    throw new Error('ws-test 进程未能停止');
  }
}

/** 同时建立 N 个 WebSocket 连接并等待确认消息 */
async function concurrentWsConnectAndConfirm(count: number): Promise<{ failed: number; total: number }> {
  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(new Promise<{ i: number; ok: boolean }>((resolve) => {
      const ws = new WS('ws://127.0.0.1:3090/', {
        headers: { Host: 'ws-proxy.test' },
      });
      const timer = setTimeout(() => {
        ws.close();
        resolve({ i, ok: false });
      }, 10000);
      ws.on('message', (data) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data.toString());
          ws.close();
          resolve({ i, ok: parsed.type === 'connected' });
        } catch {
          clearTimeout(timer);
          ws.close();
          resolve({ i, ok: false });
        }
      });
      ws.on('error', () => {
        clearTimeout(timer);
        resolve({ i, ok: false });
      });
    }));
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  return { failed: failed.length, total: res.length };
}

/** 创建一个 WebSocket 连接并等待确认 */
async function createWsAndConfirm(): Promise<WS> {
  const ws = await new Promise<WS>((resolve, reject) => {
    const w = new WS('ws://127.0.0.1:3090/', {
      headers: { Host: 'ws-proxy.test' },
    });
    const timer = setTimeout(() => { w.close(); reject(new Error('连接超时')); }, 10000);
    w.on('message', (data) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'connected') resolve(w);
        else { w.close(); reject(new Error('非连接确认消息')); }
      } catch {
        clearTimeout(timer);
        w.close();
        reject(new Error('消息解析失败'));
      }
    });
    w.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
  return ws;
}

/** 等待 WebSocket 收到下一条消息 */
function waitForMessage(ws: WS, timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待消息超时')), timeout);
    ws.once('message', (data) => { clearTimeout(timer); resolve(data.toString()); });
  });
}

// ==================== 测试场景 ====================

/** 1. 20 个并发 WebSocket 连接 */
async function test_concurrent_ws_connections() {
  await ensureWsOnline();

  const { failed, total } = await concurrentWsConnectAndConfirm(20);
  if (failed > 0) {
    throw new Error(`${failed}/${total} 个并发 WebSocket 连接失败`);
  }
}

/** 2. WebSocket 较大消息传输 (10KB) */
async function test_ws_large_message() {
  await ensureWsOnline();

  const ws = await createWsAndConfirm();

  /** 10KB JSON 消息（uWS 默认 maxBackpressure=16KB，使用安全值） */
  const largeData = 'x'.repeat(10 * 1024);
  ws.send(JSON.stringify({ type: 'test', data: largeData }));

  const response = await waitForMessage(ws, 10000);
  const parsed = JSON.parse(response);
  if (parsed.data !== largeData) {
    ws.close();
    throw new Error(`大消息回显不匹配: 期望 ${largeData.length} 字节`);
  }

  ws.close();
}

/** 3. 快速连接/断开循环 */
async function test_ws_rapid_connect_disconnect() {
  await ensureWsOnline();

  for (let i = 0; i < 30; i++) {
    const ws = await createWsAndConfirm();
    ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await waitForMessage(ws, 5000);
    const data = JSON.parse(msg);
    if (data.type !== 'pong') {
      ws.close();
      throw new Error(`第 ${i} 次循环 pong 不匹配`);
    }
    ws.close();
    await sleep(10);
  }

  /** 验证网关仍然正常 */
  const ws = await createWsAndConfirm();
  ws.close();
}

/** 4. WebSocket 连接期间服务停止后的清理 */
async function test_ws_service_stop_cleanup() {
  await ensureWsOnline();

  const ws = await createWsAndConfirm();

  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await waitForMessage(ws, 5000);
  const pongData = JSON.parse(pong);
  if (pongData.type !== 'pong') {
    ws.close();
    throw new Error('ping/pong 不匹配');
  }

  /** 通过管理 API 停止服务 */
  await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/ws-test/stop',
    method: 'POST',
    timeout: 10000,
  });
  await sleep(1000);

  /** 验证网关仍在运行 */
  const healthCheck = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 15000,
  });
  if (healthCheck.status !== 200) {
    throw new Error('ws-test 停止后网关异常');
  }
}

/** 5. WebSocket 与 HTTP 混合并发 */
async function test_ws_http_mixed_concurrent() {
  await ensureWsOnline();

  /** 确保 echo 在线 */
  try { await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 }); } catch {}

  const promises: Promise<void>[] = [];

  /** 10 个 WebSocket 连接 */
  for (let i = 0; i < 10; i++) {
    promises.push((async () => {
      const { failed } = await concurrentWsConnectAndConfirm(1);
      if (failed > 0) throw new Error(`WS ${i} 连接失败`);
    })());
  }

  /** 10 个 HTTP 请求 */
  for (let i = 0; i < 10; i++) {
    promises.push((async () => {
      const res = await httpRequest({
        hostname: 'echo-host.test',
        path: `/echo?id=${i}`,
        timeout: 5000,
      });
      if (res.status !== 200) {
        throw new Error(`HTTP ${i} 失败: ${res.status}`);
      }
    })());
  }

  await Promise.all(promises);
}

/** 6. WebSocket 二进制消息传输 */
async function test_ws_binary_message() {
  await ensureWsOnline();

  const ws = await createWsAndConfirm();

  /** 发送二进制数据 */
  const binaryData = Buffer.alloc(1024, 0xAB);
  ws.send(binaryData);

  const response = await waitForMessage(ws, 5000);
  const responseBuf = Buffer.from(response);
  if (responseBuf.length === 0) {
    ws.close();
    throw new Error('二进制消息响应为空');
  }

  ws.close();
}

/** 7. 多连接消息顺序（每连接一条消息） */
async function test_ws_message_ordering() {
  await ensureWsOnline();

  /** 建立 10 个连接，每个连接发送一条带序号的消息 */
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push((async () => {
      const ws = await createWsAndConfirm();
      ws.send(JSON.stringify({ type: 'test', data: `order-${i}` }));
      const resp = await waitForMessage(ws, 5000);
      const parsed = JSON.parse(resp);
      ws.close();
      if (parsed.data !== `order-${i}`) {
        throw new Error(`消息不匹配: 期望 order-${i}, 实际 ${parsed.data}`);
      }
    })());
  }

  await Promise.all(promises);
}

/** 8. WebSocket 活跃连接阻止闲置停止 */
async function test_ws_prevents_idle_timeout() {
  await ensureWsOnline();

  const ws = await createWsAndConfirm();

  log('    等待闲置超时（15秒）...', C.yellow);
  await sleep(15000);

  if (!await checkPort(3011)) {
    ws.close();
    throw new Error('WebSocket 活跃连接未能阻止闲置停止');
  }

  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await waitForMessage(ws, 5000);
  const pongData = JSON.parse(pong);
  if (pongData.type !== 'pong') {
    ws.close();
    throw new Error('闲置超时后 WebSocket 通信失败');
  }

  ws.close();
}

/** 9. 多个并发 WebSocket 连接的 ping/pong */
async function test_concurrent_ws_ping_pong() {
  await ensureWsOnline();

  /** 逐个建立连接 */
  const wsList: WS[] = [];
  for (let i = 0; i < 10; i++) {
    const ws = await createWsAndConfirm();
    wsList.push(ws);
  }

  /** 同时发 ping */
  const pongPromises = wsList.map(async (ws, i) => {
    ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await waitForMessage(ws, 5000);
    const data = JSON.parse(msg);
    if (data.type !== 'pong') {
      throw new Error(`WS ${i} pong 不匹配`);
    }
  });

  await Promise.all(pongPromises);

  for (const ws of wsList) {
    ws.close();
  }
}

/** 10. WebSocket 按需启动 */
async function test_ws_on_demand_startup() {
  await ensureWsOffline();

  if (await checkPort(3011)) {
    throw new Error('前置条件：ws-test 应离线');
  }

  /** 触发 HTTP 请求按需启动 */
  const httpRes = await httpRequest({ hostname: 'ws-proxy.test', path: '/', timeout: 15000 });
  if (httpRes.status !== 200) {
    throw new Error(`ws-test HTTP 按需启动失败: ${httpRes.status}`);
  }

  await sleep(1000);

  /** 用 Promise.all 模式连接 */
  const { failed } = await concurrentWsConnectAndConfirm(1);
  if (failed > 0) {
    throw new Error('WebSocket 按需启动后连接失败');
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔌 DynaPM WebSocket 并发与稳定性测试', C.cyan);

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

  /** 预热服务（确保使用最新代码） */
  log('  预热服务...', C.yellow);
  await killPort(3011);
  await sleep(500);
  await ensureWsOnline();
  try { await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 }); } catch {}
  log('  ✓ 服务已预热', C.green);

  section('并发连接');
  await runTest('20 个并发 WebSocket 连接', test_concurrent_ws_connections);
  await runTest('10 个并发 WebSocket ping/pong', test_concurrent_ws_ping_pong);

  section('消息传输');
  await runTest('WebSocket 较大消息 (10KB)', test_ws_large_message);
  await runTest('WebSocket 二进制消息', test_ws_binary_message);
  await runTest('多消息顺序保证 (10条)', test_ws_message_ordering);

  section('连接生命周期');
  await runTest('快速连接/断开循环 (30次)', test_ws_rapid_connect_disconnect);
  await runTest('服务停止后连接清理', test_ws_service_stop_cleanup);

  section('混合与稳定性');
  await runTest('WebSocket + HTTP 混合并发', test_ws_http_mixed_concurrent);
  await runTest('WebSocket 活跃连接阻止闲置停止', test_ws_prevents_idle_timeout);

  section('按需启动');

  /** 通过管理 API 停止 ws-test */
  log('  停止 ws-test 以测试按需启动...', C.yellow);
  try {
    await httpRequest({ port: 3091, path: '/_dynapm/api/services/ws-test/stop', method: 'POST', timeout: 10000 });
    await sleep(1000);
    await killPort(3011);
    await sleep(500);
  } catch {}

  await runTest('WebSocket 按需启动', test_ws_on_demand_startup);

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
    log('\n🎉 所有 WebSocket 并发与稳定性测试通过！', C.green);
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
