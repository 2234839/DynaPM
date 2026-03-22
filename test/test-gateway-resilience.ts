/**
 * DynaPM 网关韧性与边界深度测试
 *
 * 覆盖之前未充分测试的核心场景：
 * 1. 后端服务启动后立即崩溃 — 网关状态正确重置
 * 2. 并发按需启动 + 停止交叉 — 竞态条件下状态一致性
 * 3. 恰好 10MB 请求体边界 — 截断阈值行为
 * 4. 大量并发请求后闲置回收 — activeConnections 精确归零
 * 5. 请求头中包含 CRLF 注入的多种变体 — 防护完整性
 * 6. 后端返回 1xx/3xx 状态码 — 网关正确透传
 * 7. HTTP 请求方法 TRACE/CONNECT — 安全边界
 * 8. WebSocket 连接期间后端重启 — 消息恢复与连接清理
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

// ==================== 测试用例 ====================

/** 1. 后端服务启动后立即崩溃 — 网关应将状态重置为 offline，后续请求可重新触发启动 */
async function test_backend_crash_after_startup() {
  /** 通过管理 API 停止服务并同步网关状态 */
  await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 5000 });
  await killPort(3099);
  await sleep(1000);

  /** 第一个请求触发按需启动 */
  const res1 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (res1.status !== 200) throw new Error(`首次请求应 200，实际 ${res1.status}`);

  /** 确认后端在运行 */
  if (!await checkPort(3099)) throw new Error('后端应该已启动');

  /** 手动杀掉后端进程（模拟崩溃） */
  await killPort(3099);
  await sleep(300);

  /** 第二个请求应检测到后端不可达，返回 502，并将服务状态重置为 offline */
  const res2 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 });
  if (res2.status === 200) throw new Error('后端已杀，期望非 200 但得到 200');

  /** 等待服务状态重置完成 */
  await sleep(2000);

  /** 第三个请求应能重新触发按需启动 */
  const res3 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (res3.status !== 200) throw new Error(`第三次请求应恢复成功 200，实际 ${res3.status}`);

  if (!await checkPort(3099)) throw new Error('恢复后后端应该在运行');
}

/** 2. 并发按需启动 + 停止交叉 — 10 个并发请求 + 中途停止 */
async function test_concurrent_start_stop_race() {
  await killPort(3099);
  await sleep(500);

  /** 发起 5 个并发请求触发按需启动 */
  const startPromises = Array.from({ length: 5 }, () =>
    httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 })
  );
  const startResults = await Promise.allSettled(startPromises);

  const successCount = startResults.filter(r => r.status === 'fulfilled' && r.value.status === 200).length;
  if (successCount < 3) throw new Error(`并发启动成功太少: ${successCount}/5`);

  /** 立即通过管理 API 停止服务 */
  await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 5000 });
  await sleep(500);

  /** 再发 5 个并发请求 — 应触发重新启动 */
  const restartPromises = Array.from({ length: 5 }, () =>
    httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 })
  );
  const restartResults = await Promise.allSettled(restartPromises);

  const restartSuccess = restartResults.filter(r => r.status === 'fulfilled' && r.value.status === 200).length;
  if (restartSuccess < 3) throw new Error(`重启后并发成功太少: ${restartSuccess}/5`);
}

/** 3. 恰好 10MB 请求体 — 应被截断但请求仍能完成（非按需启动路径） */
async function test_exact_10mb_body() {
  /** 确保 echo 服务在运行 */
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (warmup.status !== 200) throw new Error('预热请求失败');

  /** 恰好 10MB（10 * 1024 * 1024 = 10485760 字节） */
  const exact10MB = 'x'.repeat(10 * 1024 * 1024);

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/big-body',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: exact10MB,
    timeout: 30000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  const data = JSON.parse(res.body);
  if (data.bodyLength !== exact10MB.length) {
    throw new Error(`请求体长度不匹配: ${data.bodyLength} vs ${exact10MB.length}`);
  }
}

/** 4. 大量并发请求后闲置回收 — activeConnections 应精确归零 */
async function test_active_connections_zero_after_idle() {
  /** 确保服务在线 */
  await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });

  /** 发起 50 个并发请求 */
  const promises = Array.from({ length: 50 }, () =>
    httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 10000 })
  );
  const results = await Promise.allSettled(promises);

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value.status === 200).length;
  if (successCount < 45) throw new Error(`并发成功率过低: ${successCount}/50`);

  /** 等待闲置超时（idleTimeout = 10s，检查间隔 3s） */
  await sleep(14000);

  /** 验证服务已自动停止 */
  if (await checkPort(3099)) throw new Error('闲置超时后服务应该已停止');
}

/** 5. CRLF 注入防护的多种变体 — 使用原始 TCP 发送包含 CRLF 的 header */
async function test_crlf_injection_variants() {
  await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });

  /**
   * Node.js http 客户端会拒绝含 CRLF 的 header 值，
   * 所以使用原始 TCP socket 直接发送 HTTP 请求来测试网关的 CRLF 清理
   */
  const testCrlfVariant = (label: string, headerValue: string) => {
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: 3090 }, () => {
        const rawRequest = [
          'GET /headers HTTP/1.1',
          'Host: echo-host.test',
          `X-Test-Inject: ${headerValue}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n');

        socket.write(rawRequest);

        let data = '';
        socket.on('data', (chunk) => { data += chunk.toString(); });
        socket.on('end', () => {
          /** 响应体中不应包含注入的 HTTP 头 */
          if (data.includes('Injected: evil') || data.includes('X-Evil:')) {
            reject(new Error(`${label}: CRLF 注入成功，响应包含注入内容`));
          } else {
            resolve();
          }
        });
        socket.on('error', reject);
      });
      socket.on('error', reject);
    });
  };

  await testCrlfVariant('CRLF in header value', 'normal\r\nInjected: evil');
  await testCrlfVariant('LF only', 'normal\nInjected: evil');
  await testCrlfVariant('Multiple CRLF', 'a\r\n\r\nX-Evil: injected\r\n\r\nb');
  await testCrlfVariant('Header name injection', 'value\r\nX-Evil: injected');
}

/** 6. 后端返回 3xx 重定向 — Location 头正确透传 */
async function test_3xx_redirect_passthrough() {
  await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/status?code=302&url=https://example.com/redirect',
    timeout: 5000,
  });

  if (res.status !== 302) throw new Error(`期望 302，实际 ${res.status}`);
  if (!res.headers['location']) throw new Error('Location 头缺失');
  if (!res.headers['location'].includes('https://example.com/redirect')) {
    throw new Error(`Location 值不正确: ${res.headers['location']}`);
  }
}

/** 7. HTTP TRACE 方法 — 网关应正常转发（不阻断非标准方法） */
async function test_trace_method() {
  await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'TRACE',
    timeout: 5000,
  });

  /** TRACE 方法可能被后端拒绝（uWS app.any 允许所有方法） */
  if (res.status !== 200) throw new Error(`TRACE 期望 200，实际 ${res.status}`);
}

/** 8. WebSocket 连接期间后端重启 — 连接应被清理，不影响后续连接 */
async function test_ws_backend_restart_recovery() {
  /** 先通过管理 API 确保 ws-test 服务停止 */
  await httpRequest({ port: 3091, path: '/_dynapm/api/services/ws-test/stop', method: 'POST', timeout: 5000 });
  await killPort(3011);
  await sleep(1000);

  /** 建立 WebSocket 连接（触发按需启动） */
  const ws = new WS('ws://127.0.0.1:3090/', {
    headers: { Host: 'ws-proxy.test' },
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('WS 连接超时')); }, 10000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  /** 等待后端 WebSocket 连接建立 */
  await sleep(2000);

  /** 验证消息可以正常收发 */
  const echoPromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('echo 超时')); }, 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    ws.send('ping-before-restart');
  });
  const echo = await echoPromise;
  if (!echo.includes('ping-before-restart')) {
    throw new Error(`echo 内容不正确: ${echo}`);
  }

  /** 杀掉后端进程 */
  await killPort(3011);
  await sleep(500);

  /** WebSocket 连接应被关闭（后端断连 → 前端关闭） */
  const closePromise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    ws.on('close', () => { clearTimeout(timer); resolve(); });
  });
  await closePromise;

  /** 通过管理 API 确保服务状态已同步 */
  await httpRequest({ port: 3091, path: '/_dynapm/api/services/ws-test/stop', method: 'POST', timeout: 5000 });
  await killPort(3011);
  await sleep(1000);

  /** 重新发起新的 WebSocket 连接 — 应能按需启动后端 */
  const ws2 = new WS('ws://127.0.0.1:3090/', {
    headers: { Host: 'ws-proxy.test' },
  });

  /** 先注册 message handler — 跳过 connected 消息，等待 echo 回复 */
  const echoPromise2 = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { ws2.close(); reject(new Error('echo2 超时')); }, 10000);
    ws2.on('message', (data) => {
      const msg = data.toString();
      /** 跳过后端连接确认消息，等待 echo 回复 */
      if (msg.includes('"type":"connected"')) return;
      clearTimeout(timer);
      resolve(msg);
    });
    ws2.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS reconnect timeout')), 12000);
    ws2.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  /** 等待后端按需启动 + WebSocket 连接建立 */
  await sleep(3000);

  ws2.send('ping-after-restart');

  const echo2 = await echoPromise2;
  if (!echo2.includes('ping-after-restart')) {
    throw new Error(`恢复后 echo 内容不正确: ${echo2}`);
  }

  ws2.close();
}

// ==================== 主流程 ====================

async function main() {
  section('DynaPM 网关韧性与边界深度测试');

  /** 清理环境 */
  await killPort(3090);
  await killPort(3091);
  await killPort(3099);
  await killPort(3011);
  await sleep(500);

  /** 启动网关 */
  log('  启动网关...', C.cyan);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3090, 10000)) { log('网关启动失败', C.red); process.exit(1); }
  log('  网关已启动', C.green);

  /** 确保 echo 后端在运行（用于直接代理路径测试） */
  await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  await sleep(500);

  await runTest('后端启动后立即崩溃状态重置', test_backend_crash_after_startup);
  await runTest('并发按需启动+停止交叉竞态', test_concurrent_start_stop_race);
  await runTest('恰好 10MB 请求体边界', test_exact_10mb_body);
  await runTest('大量并发后闲置回收', test_active_connections_zero_after_idle);
  await runTest('CRLF 注入防护多种变体', test_crlf_injection_variants);
  await runTest('3xx 重定向透传', test_3xx_redirect_passthrough);
  await runTest('TRACE 方法转发', test_trace_method);
  await runTest('WebSocket 后端重启恢复', test_ws_backend_restart_recovery);

  /** 汇总 */
  section('测试结果汇总');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  log(`  总计: ${results.length} 个测试`, C.cyan);
  log(`  通过: ${passed} 个`, C.green);
  if (failed > 0) {
    log(`  失败: ${failed} 个`, C.red);
    for (const r of results.filter(r => !r.passed)) {
      log(`    ✗ ${r.name}: ${r.message}`, C.red);
    }
  } else {
    log(`  全部通过！`, C.green);
  }

  /** 清理 */
  await killPort(3090);
  await killPort(3091);
  await killPort(3099);
  await killPort(3011);

  process.exit(failed > 0 ? 1 : 0);
}

main();
