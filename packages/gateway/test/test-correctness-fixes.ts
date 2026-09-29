/**
 * DynaPM 正确性修复测试（TDD 先行验证）
 *
 * 测试覆盖：
 * 1. 请求体超过 10MB 上限返回 413 且不转发到后端
 * 2. Admin API IP 白名单使用真实 remoteAddress，伪造 XFF 头被拒绝
 * 3. 全局异常处理：handler 记录错误 → cleanup → exit(1)（纯逻辑单测）
 * 4. WS 消息队列超过 1000 条上限时网关主动关闭连接
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import WS from 'ws';
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
  try { await execAsync(`lsof -i:${port} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9 2>/dev/null`); } catch {}
}

async function waitForPort(port: number, timeout = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await checkPort(port)) return true; await sleep(100); }
  return false;
}

function httpRequest(options: {
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeout?: number;
}): Promise<{ status: number; body: string }> {
  const { port = 3130, path = '/', method = 'GET', headers = {}, body, timeout = 30000 } = options;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, timeout }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
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
    results.push({ name, passed: true, message: '通过', duration: Date.now() - start });
    log(`  ✓ ${name}`, C.green);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, message, duration: Date.now() - start });
    log(`  ✗ ${name}: ${message}`, C.red);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// ==================== 测试 1：请求体超限 413 ====================

async function test_request_body_over_limit_413() {
  /** 10MB + 1KB，超过 MAX_REQUEST_BODY_SIZE */
  const oversizedBody = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x61);
  const res = await httpRequest({ port: 3130, path: '/echo', method: 'POST', headers: { Host: 'echo-host.test:3130' }, body: oversizedBody });
  assert(res.status === 413, `超限请求应返回 413，实际 ${res.status}，body=${res.body.slice(0, 100)}`);
}

async function test_request_body_normal_ok() {
  const res = await httpRequest({ port: 3130, path: '/echo?echo=ok', method: 'POST', headers: { Host: 'echo-host.test:3130' }, body: 'normal-body' });
  assert(res.status === 200, `正常请求应返回 200，实际 ${res.status}`);
}

// ==================== 测试 2：Admin API IP 白名单 ====================

async function test_admin_api_xff_spoof_rejected() {
  /** 白名单是 10.99.99.99，本机连接的真实 IP 是 127.0.0.1。
   *  伪造 XFF: 10.99.99.99 应被拒绝（改用真实 remoteAddress 后必须 403） */
  const res = await httpRequest({
    port: 3131,
    path: '/_dynapm/api/services',
    method: 'GET',
    headers: { 'x-forwarded-for': '10.99.99.99' },
  });
  assert(res.status === 403, `伪造 XFF 的非白名单请求应 403，实际 ${res.status}，body=${res.body.slice(0, 100)}`);
}

// ==================== 测试 3：全局异常处理 handler（纯逻辑单测） ====================

async function test_fatal_handler_order() {
  const { createFatalErrorHandler } = await import('../src/core/fatal-error-handler.js');

  const calls: string[] = [];
  let exitCode = -1;
  const cleanup = async () => { calls.push('cleanup'); };
  const exit = (code: number) => { exitCode = code; calls.push('exit'); };

  const handler = createFatalErrorHandler(
    { error: (obj: { msg: string }) => { calls.push(`log:${obj.msg}`); } } as never,
    cleanup,
    exit,
  );

  handler(new Error('boom'), 'uncaughtException');
  /** handler 内部是 Promise 链收尾，等待微任务队列清空 */
  await new Promise((resolve) => setImmediate(resolve));

  /** logger 注入用对象形式调用（pino 风格），首步必须是记录错误 */
  assert(calls[0] === 'log:❌ 致命错误 (uncaughtException)，进程将退出', `第一步应记录错误，实际调用序列: ${calls.join(' -> ')}`);

  assert(calls[1] === 'cleanup', `第二步应执行 cleanup，实际: ${calls.join(' -> ')}`);
  assert(calls[2] === 'exit' && exitCode === 1, `第三步应 exit(1)，实际: ${calls.join(' -> ')} code=${exitCode}`);
}

async function test_fatal_handler_cleanup_throws_still_exits() {
  const { createFatalErrorHandler } = await import('../src/core/fatal-error-handler.js');

  let exitCode = -1;
  const cleanup = async () => { throw new Error('cleanup failed'); };
  const exit = (code: number) => { exitCode = code; };

  const handler = createFatalErrorHandler({ error: () => {} } as never, cleanup, exit);
  handler(new Error('boom'), 'unhandledRejection');
  await new Promise((resolve) => setImmediate(resolve));
  assert(exitCode === 1, `cleanup 抛错后仍应 exit(1)，实际 exitCode=${exitCode}`);
}

// ==================== 测试 4：WS 消息队列超限主动关闭 ====================

async function test_ws_message_queue_overflow_closes() {
  /** ws-slow 服务后端延迟 2 秒启动，保证消息先入队列 */
  const ws = new WS('ws://127.0.0.1:3130/', { headers: { host: 'ws-slow.test:3130' } });

  let closed = false;
  const closePromise = new Promise<void>((resolve) => {
    ws.on('close', () => { closed = true; resolve(); });
    ws.on('error', () => { closed = true; resolve(); });
  });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });

  /** 连接建立后立即连发 1500 条消息（> MAX_WS_MESSAGE_QUEUE_SIZE=1000），
   *  后端尚未就绪，全部入队，超限后网关应主动 ws.close() */
  const payload = Buffer.alloc(64, 0x62);
  for (let i = 0; i < 1500; i++) {
    if (ws.readyState !== WS.OPEN) break;
    ws.send(payload, { binary: true });
  }

  const timeout = sleep(15000).then(() => { throw new Error(`等待 15s 后连接仍未被网关关闭 (closed=${closed})`); });
  await Promise.race([closePromise, timeout]);
  ws.terminate();
}

// ==================== 主流程 ====================

async function main() {
  log('\n🛡️  DynaPM 正确性修复测试', C.cyan);

  section('环境准备');

  for (const port of [3130, 3131, 3111]) {
    await killPort(port);
  }
  await sleep(500);

  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.correctness-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3130, 10000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3131, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(300);

  section('修复 1：请求体超限返回 413');
  await runTest('正常请求体不受影响 (200)', test_request_body_normal_ok);
  await runTest('超过 10MB 请求体返回 413', test_request_body_over_limit_413);

  section('修复 2：Admin API 真实 remoteAddress');
  await runTest('伪造 XFF 头的非白名单请求被拒绝 (403)', test_admin_api_xff_spoof_rejected);

  section('修复 3：全局异常处理退出逻辑');
  await runTest('handler 顺序: log -> cleanup -> exit(1)', test_fatal_handler_order);
  await runTest('cleanup 抛错仍保证 exit(1)', test_fatal_handler_cleanup_throws_still_exits);

  section('修复 4：WS 消息队列超限主动关闭');
  await runTest('1500 条消息超限后连接被网关关闭', test_ws_message_queue_overflow_closes);

  section('清理环境');

  for (const port of [3130, 3131, 3111, 3099]) {
    await killPort(port);
  }
  log('  ✓ 所有进程已清理', C.green);

  section('测试结果汇总');

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;

  for (const r of results) {
    const color = r.passed ? C.green : C.red;
    log(`${r.passed ? '✓' : '✗'} ${r.name} (${r.duration}ms)${r.passed ? '' : ' - ' + r.message}`, color);
  }

  log(`\n总计: ${results.length} | 通过: ${passed} | 失败: ${failed}`, passed === results.length ? C.green : C.red);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`测试主流程异常: ${err instanceof Error ? err.stack : err}`, C.red);
  process.exit(1);
});
