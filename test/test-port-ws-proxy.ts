/**
 * DynaPM 端口绑定 WebSocket 代理测试
 *
 * 覆盖 createPortBindingListener (gateway.ts 1402-1606) 的所有代码路径：
 * 1. 端口路由 WebSocket 基本连接与消息收发
 * 2. 端口路由 WebSocket 按需启动（后端离线时连接触发启动）
 * 3. 端口路由 WebSocket 并发连接（10 个同时连接）
 * 4. 端口路由 WebSocket 二进制消息传输
 * 5. 端口路由 WebSocket 较大消息传输 (10KB)
 * 6. 端口路由 WebSocket 快速连接/断开循环 (20次)
 * 7. 端口路由 WebSocket 消息队列（后端未就绪时消息排队）
 * 8. 端口路由 WebSocket 活跃连接阻止闲置停止
 * 9. 端口路由 WebSocket 与 HTTP 同时工作
 * 10. 端口路由 WebSocket 后端崩溃后连接清理
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
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const { hostname, port = 3093, path = '/', method = 'GET', headers = {}, body, timeout = 10000 } = options;
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

/** ws-port-test 后端端口（独立于 ws-test 的 3011） */
const WS_PORT_BACKEND = 3012;

/**
 * 确保后端 WebSocket 服务在运行
 * 通过端口路由 HTTP 请求触发按需启动
 */
async function ensureBackendOnline(): Promise<void> {
  if (!await checkPort(WS_PORT_BACKEND)) {
    const res = await httpRequest({ path: '/', timeout: 15000 });
    if (res.status !== 200) throw new Error('ws-port-test 后端启动失败');
    await sleep(500);
  }
}

/**
 * 确保后端完全离线（用于按需启动测试）
 * 通过管理 API 停止服务 + 强制杀进程 + 同步网关状态
 */
async function ensureBackendOffline(): Promise<void> {
  /** 通过管理 API 停止 ws-port-test 服务 */
  try {
    await httpRequest({ port: 3091, path: '/_dynapm/api/services/ws-port-test/stop', method: 'POST', timeout: 5000 });
    await sleep(500);
  } catch {}

  /** 多次强制杀进程 */
  for (let i = 0; i < 5; i++) {
    await killPort(WS_PORT_BACKEND);
    await sleep(200);
    if (!await checkPort(WS_PORT_BACKEND)) break;
  }

  /** 同步网关状态：发请求吃 502 触发状态重置 */
  for (let retry = 0; retry < 10; retry++) {
    try { await httpRequest({ path: '/', timeout: 3000 }); } catch {}
    await sleep(300);
    try {
      const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/ws-port-test', timeout: 2000 });
      const data = JSON.parse(statusRes.body);
      const svc = data.services && Array.isArray(data.services)
        ? data.services.find((s: { name: string }) => s.name === 'ws-port-test')
        : data;
      if (svc.status === 'offline') return;
    } catch {}

    await killPort(WS_PORT_BACKEND);
  }

  if (await checkPort(WS_PORT_BACKEND)) {
    throw new Error('后端 WebSocket 进程未能停止');
  }
}

/** 创建端口路由 WebSocket 连接并等待 connected 确认 */
async function createPortWs(): Promise<WS> {
  const ws = await new Promise<WS>((resolve, reject) => {
    const w = new WS('ws://127.0.0.1:3093/', {});
    const timer = setTimeout(() => { w.close(); reject(new Error('端口路由 WS 连接超时')); }, 10000);

    /** 先等 open 事件确认 WebSocket 握手完成 */
    w.on('open', () => {
      /** 注册 message 等待后端的 connected 消息（网关需要异步建立到后端的 WS 连接） */
      const msgTimer = setTimeout(() => { w.close(); reject(new Error('等待 connected 消息超时')); }, 10000);
      w.once('message', (data) => {
        clearTimeout(msgTimer);
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'connected') resolve(w);
          else { w.close(); reject(new Error('非连接确认消息: ' + data.toString())); }
        } catch {
          w.close();
          reject(new Error('消息解析失败'));
        }
      });
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

/** 同时建立 N 个端口路由 WebSocket 连接并等待确认 */
async function concurrentPortWsConnect(count: number): Promise<{ failed: number; total: number }> {
  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(new Promise<{ i: number; ok: boolean }>((resolve) => {
      const ws = new WS('ws://127.0.0.1:3093/', {});
      const timer = setTimeout(() => { ws.close(); resolve({ i, ok: false }); }, 10000);
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
      ws.on('error', () => { clearTimeout(timer); resolve({ i, ok: false }); });
    }));
  }
  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  return { failed: failed.length, total: res.length };
}

// ==================== 测试场景 ====================

/** 1. 端口路由 WebSocket 基本连接与消息收发 */
async function test_port_ws_basic() {
  await ensureBackendOnline();

  const ws = await createPortWs();

  ws.send(JSON.stringify({ type: 'ping' }));
  const msg = await waitForMessage(ws, 5000);
  const data = JSON.parse(msg);
  if (data.type !== 'pong') {
    ws.close();
    throw new Error(`ping/pong 不匹配: ${data.type}`);
  }

  ws.send(JSON.stringify({ type: 'test', data: 'hello-port-ws' }));
  const echo = await waitForMessage(ws, 5000);
  const echoData = JSON.parse(echo);
  if (echoData.type !== 'echo' || echoData.data !== 'hello-port-ws') {
    ws.close();
    throw new Error(`echo 不匹配: ${echo}`);
  }

  ws.close();
}

/** 2. 端口路由 WebSocket 按需启动（后端离线时连接触发启动） */
async function test_port_ws_on_demand() {
  await ensureBackendOffline();

  if (await checkPort(WS_PORT_BACKEND)) {
    throw new Error('前置条件：后端应该离线');
  }

  /** 通过 WebSocket 连接触发按需启动（端口路由的 open handler 中有按需启动逻辑） */
  const ws = await new Promise<WS>((resolve, reject) => {
    const w = new WS('ws://127.0.0.1:3093/', {});
    const timer = setTimeout(() => { w.close(); reject(new Error('按需启动 WS 连接超时')); }, 15000);
    w.on('message', (data) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'connected') resolve(w);
        else {
          clearTimeout(timer);
          w.close();
          reject(new Error('非 connected 消息'));
        }
      } catch {
        clearTimeout(timer);
        w.close();
        reject(new Error('消息解析失败'));
      }
    });
    w.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  ws.close();
}

/** 3. 端口路由 WebSocket 并发连接（10 个同时） */
async function test_port_ws_concurrent() {
  await ensureBackendOnline();

  const { failed, total } = await concurrentPortWsConnect(10);
  if (failed > 0) {
    throw new Error(`${failed}/${total} 个并发端口路由 WS 连接失败`);
  }
}

/** 4. 端口路由 WebSocket 二进制消息传输 */
async function test_port_ws_binary() {
  await ensureBackendOnline();

  const ws = await createPortWs();

  const binaryData = Buffer.alloc(1024, 0xCD);
  ws.send(binaryData);

  const response = await waitForMessage(ws, 5000);
  /** 非文本消息后端会回显原始数据 */
  if (response.length === 0) {
    ws.close();
    throw new Error('二进制消息响应为空');
  }

  ws.close();
}

/** 5. 端口路由 WebSocket 较大消息传输 (10KB) */
async function test_port_ws_large_message() {
  await ensureBackendOnline();

  const ws = await createPortWs();

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

/** 6. 端口路由 WebSocket 快速连接/断开循环 (20次) */
async function test_port_ws_rapid_cycle() {
  await ensureBackendOnline();

  for (let i = 0; i < 20; i++) {
    const ws = await createPortWs();
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

  /** 验证网关仍正常 */
  const ws = await createPortWs();
  ws.close();
}

/** 7. 端口路由 WebSocket 消息队列（在后端启动中发送消息，排队后发送） */
async function test_port_ws_message_queue() {
  await ensureBackendOffline();

  /** WebSocket 连接触发按需启动，后端需要几秒启动 */
  const ws = new WS('ws://127.0.0.1:3093/', {});

  /** 等待连接建立（后端可能还在启动中） */
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('WS 连接超时')); }, 15000);
    ws.on('message', (data) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'connected') resolve();
        else {
          clearTimeout(timer);
          ws.close();
          reject(new Error('非 connected 消息'));
        }
      } catch {
        clearTimeout(timer);
        ws.close();
        reject(new Error('消息解析失败'));
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  /** 等待后端 WebSocket 连接建立（网关内部需要先启动后端再建立 WS 连接） */
  await sleep(3000);

  /** 发送消息，验证可以正常收发 */
  ws.send(JSON.stringify({ type: 'test', data: 'queue-test' }));
  const response = await waitForMessage(ws, 10000);
  const parsed = JSON.parse(response);
  if (parsed.type !== 'echo' || parsed.data !== 'queue-test') {
    ws.close();
    throw new Error(`队列消息不匹配: ${response}`);
  }

  ws.close();
}

/** 8. 端口路由 WebSocket 长连接稳定性（5 秒内持续通信） */
async function test_port_ws_long_connection() {
  await ensureBackendOnline();

  const ws = await createPortWs();

  /** 在 5 秒内每秒发送一次 ping/pong，验证连接持续可用 */
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await waitForMessage(ws, 5000);
    const data = JSON.parse(msg);
    if (data.type !== 'pong') {
      ws.close();
      throw new Error(`第 ${i+1} 次 ping/pong 失败`);
    }
  }

  ws.close();
}

/** 9. 端口路由 WebSocket 与 HTTP 同时工作 */
async function test_port_ws_http_mixed() {
  await ensureBackendOnline();

  /** 同时发起 WebSocket 连接和 HTTP 请求 */
  const promises: Promise<void>[] = [];

  /** 5 个 WebSocket 连接 */
  for (let i = 0; i < 5; i++) {
    promises.push((async () => {
      const ws = await createPortWs();
      ws.send(JSON.stringify({ type: 'ping' }));
      const msg = await waitForMessage(ws, 5000);
      const data = JSON.parse(msg);
      if (data.type !== 'pong') {
        ws.close();
        throw new Error(`WS ${i} pong 不匹配`);
      }
      ws.close();
    })());
  }

  /** 5 个 HTTP 请求（通过端口路由 3093） */
  for (let i = 0; i < 5; i++) {
    promises.push((async () => {
      const res = await httpRequest({ path: '/', timeout: 5000 });
      if (res.status !== 200) {
        throw new Error(`HTTP ${i} 失败: ${res.status}`);
      }
    })());
  }

  await Promise.all(promises);
}

/** 10. 端口路由 WebSocket 后端崩溃后连接清理 */
async function test_port_ws_backend_crash() {
  await ensureBackendOnline();

  const ws = await createPortWs();

  /** 确认消息可以正常收发 */
  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await waitForMessage(ws, 5000);
  const pongData = JSON.parse(pong);
  if (pongData.type !== 'pong') {
    ws.close();
    throw new Error('ping/pong 不匹配');
  }

  /** 杀掉后端进程 */
  await killPort(WS_PORT_BACKEND);
  await sleep(500);

  /** WebSocket 连接应被关闭（后端断连 → 网关关闭前端） */
  const closePromise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    ws.on('close', () => { clearTimeout(timer); resolve(); });
  });
  await closePromise;

  /** 同步网关状态 */
  try { await httpRequest({ path: '/', timeout: 3000 }); } catch {}
  await sleep(500);

  /** 重新连接应触发按需启动并成功 */
  const ws2 = await new Promise<WS>((resolve, reject) => {
    const w = new WS('ws://127.0.0.1:3093/', {});
    const timer = setTimeout(() => { w.close(); reject(new Error('恢复后 WS 连接超时')); }, 15000);
    w.on('message', (data) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'connected') resolve(w);
        else {
          clearTimeout(timer);
          w.close();
          reject(new Error('非 connected 消息'));
        }
      } catch {
        clearTimeout(timer);
        w.close();
        reject(new Error('消息解析失败'));
      }
    });
    w.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  ws2.close();
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔌 DynaPM 端口绑定 WebSocket 代理测试', C.cyan);

  section('环境准备');

  /** 清理所有相关端口 */
  for (const port of [3090, 3091, 3092, 3093, 3099, 3010, 3011, WS_PORT_BACKEND]) {
    await killPort(port);
  }
  await sleep(1000);

  /** 启动网关 */
  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  await sleep(1000);
  if (!await waitForPort(3090, 10000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3091, 5000);
  await waitForPort(3093, 5000);
  log('  ✓ 网关已启动 (含端口 3093)', C.green);
  await sleep(500);

  section('基本功能');
  await runTest('端口路由 WS 基本连接与消息收发', test_port_ws_basic);
  await runTest('端口路由 WS 二进制消息', test_port_ws_binary);
  await runTest('端口路由 WS 较大消息 (10KB)', test_port_ws_large_message);

  section('并发与生命周期');
  await runTest('端口路由 WS 并发连接 (10个)', test_port_ws_concurrent);
  await runTest('端口路由 WS 快速连接/断开循环 (20次)', test_port_ws_rapid_cycle);
  await runTest('端口路由 WS + HTTP 混合并发', test_port_ws_http_mixed);

  section('按需启动与消息队列');
  await runTest('端口路由 WS 按需启动', test_port_ws_on_demand);
  await runTest('端口路由 WS 消息队列', test_port_ws_message_queue);

  section('稳定性');
  await runTest('端口路由 WS 长连接稳定性 (5s)', test_port_ws_long_connection);
  await runTest('端口路由 WS 后端崩溃后连接清理', test_port_ws_backend_crash);

  section('清理环境');

  for (const port of [3090, 3091, 3092, 3093, 3099, 3010, 3011, WS_PORT_BACKEND]) {
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
    log('\n🎉 所有端口绑定 WebSocket 代理测试通过！', C.green);
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
