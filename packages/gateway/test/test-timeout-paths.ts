/**
 * DynaPM 超时路径测试（验证先行：注入短超时覆盖三条硬编码超时路径）
 *
 * 1. 启动超时：startTimeout=300ms + 后端永不监听 → 客户端收到 503，服务状态回到 offline
 * 2. 代理超时：后端 hang 住不响应 + proxyTimeoutMs=800 → 客户端收到 504
 * 3. stopping 等待超时：stop 命令 hang 住（sleep 60）+ stopWaitMs=800 → 请求收到 503 超时响应而非永久挂起
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
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
    const socket = require('node:net').createConnection({ host: '127.0.0.1', port, timeout: 200 }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function killPort(port: number) {
  try { await execAsync(`lsof -ti:${port} -sTCP:LISTEN | xargs -r kill -9 2>/dev/null`); } catch {}
}

async function waitForPort(port: number, timeout = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await checkPort(port)) return true; await sleep(100); }
  return false;
}

/** 从 admin API 读取服务状态 */
async function getServiceStatus(name: string): Promise<string> {
  const res = await httpRequest({ port: 3141, path: `/_dynapm/api/services/${name}` });
  return (JSON.parse(res.body) as { status: string }).status;
}

function httpRequest(options: {
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeout?: number;
}): Promise<{ status: number; body: string }> {
  const { port = 3140, path = '/', method = 'GET', headers = {}, body, timeout = 5000 } = options;
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

// ==================== 测试 1：启动超时 → 503 + 状态复位 offline ====================

async function test_start_timeout_503_and_offline() {
  const start = Date.now();
  const res = await httpRequest({ port: 3140, path: '/', headers: { Host: 'timeout-start.test:3140' } });
  const duration = Date.now() - start;

  assert(res.status === 503, `启动超时应返回 503，实际 ${res.status}，body=${res.body.slice(0, 100)}`);
  assert(duration < 5000, `启动超时应快速失败（注入 300ms），实际耗时 ${duration}ms`);

  /** 启动失败后状态必须复位为 offline（bug 修复验证：原实现卡在 starting） */
  await sleep(100);
  const status = await getServiceStatus('timeout-start.test');
  assert(status === 'offline', `启动超时后服务状态应为 offline，实际 ${status}`);
}

// ==================== 测试 2：代理超时 → 504 ====================

async function test_proxy_timeout_504() {
  /** 预启动 hang server（网关通过 start 命令拉起，这里等它就绪） */
  const start = Date.now();
  const res = await httpRequest({ port: 3140, path: '/', headers: { Host: 'timeout-proxy.test:3140' }, timeout: 8000 });
  const duration = Date.now() - start;

  assert(res.status === 504, `后端 hang 住应触发代理超时 504，实际 ${res.status}，body=${res.body.slice(0, 100)}`);
  assert(duration < 5000, `代理超时应约 800ms（注入值），实际 ${duration}ms`);
}

// ==================== 测试 3：stopping 等待超时 → 503 而非永久挂起 ====================

async function test_stopping_wait_timeout_503() {
  /** 先让服务 online（触发 start 命令拉起 echo server） */
  const warm = await httpRequest({ port: 3140, path: '/', headers: { Host: 'timeout-stop.test:3140' }, timeout: 8000 });
  assert(warm.status === 200, `预热请求应 200，实际 ${warm.status}，body=${warm.body.slice(0, 100)}`);

  /** 触发 stop（stop 命令 sleep 60 挂起，stopTimeoutMs=5000 尚未到期）。
   *  不 await：stop POST 会阻塞到 stop 命令结束，必须 fire-and-forget */
  void httpRequest({ port: 3141, path: '/_dynapm/api/services/timeout-stop.test/stop', method: 'POST' }).catch(() => {});
  await sleep(100);
  const stoppingStatus = await getServiceStatus('timeout-stop.test');
  assert(stoppingStatus === 'stopping', `stop 挂起时状态应为 stopping，实际 ${stoppingStatus}`);

  /** stopping 期间发请求，注入的 stopWaitMs=800ms 后应收到 503 超时响应 */
  const start = Date.now();
  const res = await httpRequest({ port: 3140, path: '/', headers: { Host: 'timeout-stop.test:3140' }, timeout: 8000 });
  const duration = Date.now() - start;

  assert(res.status === 503, `stopping 超时应返回 503，实际 ${res.status}，body=${res.body.slice(0, 100)}`);
  assert(duration < 5000, `stopping 超时应约 800ms（注入值），实际 ${duration}ms`);
}

// ==================== 主流程 ====================

async function main() {
  log('\n⏱️  DynaPM 超时路径测试', C.cyan);

  section('环境准备');

  for (const port of [3140, 3141, 3150, 3151, 3152]) {
    await killPort(port);
  }
  await sleep(500);

  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.timeout-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3140, 10000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3141, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(300);

  section('超时 1：启动超时（startTimeout=300ms + 后端永不监听）');
  await runTest('启动超时返回 503 且状态复位 offline', test_start_timeout_503_and_offline);

  section('超时 2：代理超时（proxyTimeoutMs=800 + 后端 hang）');
  await runTest('后端 hang 住返回 504', test_proxy_timeout_504);

  section('超时 3：stopping 等待超时（stopWaitMs=800 + stop 命令挂起）');
  await runTest('stopping 超时返回 503 而非永久挂起', test_stopping_wait_timeout_503);

  section('清理环境');

  for (const port of [3140, 3141, 3150, 3151, 3152]) {
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
