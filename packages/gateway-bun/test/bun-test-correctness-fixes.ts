/**
 * 正确性修复对拍测试（Bun 版网关）
 * 契约与 Node 版 test-correctness-fixes.ts 一致：
 * 1. 请求体超过 10MB 上限返回 413
 * 2. Admin API IP 白名单：伪造 XFF 被拒（真实 remoteAddress 判定）
 * 3. 全局异常处理顺序：log -> cleanup -> exit(1)
 * 4. WS 消息队列超过 1000 条上限时网关主动关闭连接
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import WS from 'ws';

import {
  C, log, section, sleep, checkPort, killPort, waitForPort, httpRequest, assert,
  runTest, summarizeAndExit, startBunGateway,
  type TestResult,
} from './helpers.js';

const execAsync = promisify(exec);

const results: TestResult[] = [];

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

async function test_admin_api_xff_spoof_rejected() {
  /** 白名单是 10.99.99.99，本机连接的真实 IP 是 127.0.0.1，伪造 XFF 应被拒绝 */
  const res = await httpRequest({
    port: 3131,
    path: '/_dynapm/api/services',
    method: 'GET',
    headers: { 'x-forwarded-for': '10.99.99.99' },
  });
  assert(res.status === 403, `伪造 XFF 的非白名单请求应 403，实际 ${res.status}，body=${res.body.slice(0, 100)}`);
}

async function test_fatal_handler_order() {
  const { createFatalErrorHandler } = await import('../src/core/fatal-error-handler.js');

  const calls: string[] = [];
  let exitCode = -1;
  const cleanup = async () => { calls.push('cleanup'); };
  const exit = (code: number) => { exitCode = code; calls.push('exit'); };

  const handler = createFatalErrorHandler(
    { error: (obj: { msg: string }) => { calls.push(`log:${obj.msg}`); } },
    cleanup,
    exit,
  );

  handler(new Error('boom'), 'uncaughtException');
  await new Promise((resolve) => setImmediate(resolve));

  assert(calls[0] === 'log:❌ 致命错误 (uncaughtException)，进程将退出', `第一步应记录错误，实际调用序列: ${calls.join(' -> ')}`);
  assert(calls[1] === 'cleanup', `第二步应执行 cleanup，实际: ${calls.join(' -> ')}`);
  assert(calls[2] === 'exit' && exitCode === 1, `第三步应 exit(1)，实际: ${calls.join(' -> ')} code=${exitCode}`);
}

async function test_fatal_handler_cleanup_throws_still_exits() {
  const { createFatalErrorHandler } = await import('../src/core/fatal-error-handler.js');

  let exitCode = -1;
  const cleanup = async () => { throw new Error('cleanup failed'); };
  const exit = (code: number) => { exitCode = code; };

  const handler = createFatalErrorHandler({ error: () => {} }, cleanup, exit);
  handler(new Error('boom'), 'unhandledRejection');
  await new Promise((resolve) => setImmediate(resolve));
  assert(exitCode === 1, `cleanup 抛错后仍应 exit(1)，实际 exitCode=${exitCode}`);
}

async function test_ws_message_queue_overflow_closes() {
  /** ws-slow 服务后端延迟 2 秒启动，保证消息先入队列 */
  const ws = new WS('ws://127.0.0.1:3130/', { headers: { host: 'ws-slow.test:3130' } });

  const closePromise = new Promise<void>((resolve) => {
    ws.on('close', () => resolve());
    ws.on('error', () => resolve());
  });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });

  /** 连发 1500 条消息（> 1000），后端尚未就绪全部入队，超限后网关应主动关闭 */
  const payload = Buffer.alloc(64, 0x62);
  for (let i = 0; i < 1500; i++) {
    if (ws.readyState !== WS.OPEN) break;
    ws.send(payload, { binary: true });
  }

  const timeout = sleep(15000).then(() => { throw new Error('等待 15s 后连接仍未被网关关闭'); });
  await Promise.race([closePromise, timeout]);
  ws.terminate();
}

async function main() {
  log('\n🛡️  ModelRep-Bun 正确性修复对拍测试', C.cyan);

  section('环境准备');
  for (const port of [3130, 3131, 3111, 3099]) {
    await killPort(port);
  }
  await sleep(500);

  log('  启动 Bun 网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.correctness-test.ts';
  const gateway = startBunGateway(DYNAPM_CONFIG);
  if (!await waitForPort(3130, 10000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3131, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(300);

  section('修复 1：请求体超限返回 413');
  await runTest('正常请求体不受影响 (200)', test_request_body_normal_ok, results);
  await runTest('超过 10MB 请求体返回 413', test_request_body_over_limit_413, results);

  section('修复 2：Admin API 真实 remoteAddress');
  await runTest('伪造 XFF 头的非白名单请求被拒绝 (403)', test_admin_api_xff_spoof_rejected, results);

  section('修复 3：全局异常处理退出逻辑');
  await runTest('handler 顺序: log -> cleanup -> exit(1)', test_fatal_handler_order, results);
  await runTest('cleanup 抛错仍保证 exit(1)', test_fatal_handler_cleanup_throws_still_exits, results);

  section('修复 4：WS 消息队列超限主动关闭');
  await runTest('1500 条消息超限后连接被网关关闭', test_ws_message_queue_overflow_closes, results);

  section('清理环境');
  gateway.kill();
  for (const port of [3130, 3131, 3111, 3099]) {
    await killPort(port);
  }
  log('  ✓ 所有进程已清理', C.green);

  summarizeAndExit(results);
}

main().catch((err) => {
  log(`测试主流程异常: ${err instanceof Error ? err.stack : err}`, C.red);
  process.exit(1);
});
