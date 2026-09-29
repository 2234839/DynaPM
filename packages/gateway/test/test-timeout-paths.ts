/**
 * DynaPM-Bun 超时路径对拍测试（契约 = packages/gateway/test/test-timeout-paths.ts）
 *
 * 1. 启动超时：startTimeout=300ms + 后端永不监听 → 客户端收到 503，服务状态复位 offline
 * 2. 代理超时：后端 hang 住不响应 + proxyTimeoutMs=800 → 客户端收到 504
 * 3. stopping 等待超时：stop 命令 hang 住（sleep 60）+ stopWaitMs=800 → 503 而非永久挂起
 */

import { exec } from 'node:child_process';
import * as http from 'node:http';
import { checkPort, killPort, waitForPort, httpRequest, runTest, summarizeAndExit, section, log, C, sleep, startBunGateway, type TestResult } from './helpers.js';

const results: TestResult[] = [];

/** 从 admin API 读取服务状态 */
async function getServiceStatus(name: string): Promise<string> {
  const res = await httpRequest({ port: 3141, path: `/_dynapm/api/services/${name}` });
  return (JSON.parse(res.body) as { status: string }).status;
}

// ==================== 测试 1：启动超时 → 503 + 状态复位 offline ====================

async function test_start_timeout_503_and_offline() {
  /** 启动超时应快速失败（注入 300ms） */
  const start = Date.now();
  const res = await httpRequest({ port: 3140, path: '/', headers: { Host: 'timeout-start.test:3140' }, timeout: 8000 });
  const duration = Date.now() - start;

  if (res.status !== 503) throw new Error(`启动超时应返回 503，实际 ${res.status}，body=${res.body.slice(0, 100)}`);
  if (duration >= 5000) throw new Error(`启动超时应快速失败（注入 300ms），实际耗时 ${duration}ms`);

  /** 启动失败后状态必须复位为 offline */
  await sleep(100);
  const status = await getServiceStatus('timeout-start.test');
  if (status !== 'offline') throw new Error(`启动超时后服务状态应为 offline，实际 ${status}`);
}

// ==================== 测试 2：代理超时 → 504 ====================

async function test_proxy_timeout_504() {
  const start = Date.now();
  const res = await httpRequest({ port: 3140, path: '/', headers: { Host: 'timeout-proxy.test:3140' }, timeout: 8000 });
  const duration = Date.now() - start;

  if (res.status !== 504) throw new Error(`后端 hang 住应触发代理超时 504，实际 ${res.status}，body=${res.body.slice(0, 100)}`);
  if (duration >= 5000) throw new Error(`代理超时应约 800ms（注入值），实际 ${duration}ms`);
}

// ==================== 测试 3：stopping 等待超时 → 503 而非永久挂起 ====================

async function test_stopping_wait_timeout_503() {
  /** 先让服务 online */
  const warm = await httpRequest({ port: 3140, path: '/', headers: { Host: 'timeout-stop.test:3140' }, timeout: 8000 });
  if (warm.status !== 200) throw new Error(`预热请求应 200，实际 ${warm.status}，body=${warm.body.slice(0, 100)}`);

  /** 触发 stop（stop 命令 sleep 60 挂起），fire-and-forget */
  void httpRequest({ port: 3141, path: '/_dynapm/api/services/timeout-stop.test/stop', method: 'POST', timeout: 70000 }).catch(() => {});
  await sleep(100);
  const stoppingStatus = await getServiceStatus('timeout-stop.test');
  if (stoppingStatus !== 'stopping') throw new Error(`stop 挂起时状态应为 stopping，实际 ${stoppingStatus}`);

  /** stopping 期间发请求，注入的 stopWaitMs=800ms 后应收到 503 超时响应 */
  const start = Date.now();
  const res = await httpRequest({ port: 3140, path: '/', headers: { Host: 'timeout-stop.test:3140' }, timeout: 8000 });
  const duration = Date.now() - start;

  if (res.status !== 503) throw new Error(`stopping 超时应返回 503，实际 ${res.status}，body=${res.body.slice(0, 100)}`);
  if (duration >= 5000) throw new Error(`stopping 超时应约 800ms（注入值），实际 ${duration}ms`);
}

// ==================== 主流程 ====================

async function main() {
  log('\n⏱️  DynaPM-Bun 超时路径对拍测试', C.cyan);

  section('环境准备');
  for (const port of [3140, 3141, 3150, 3151, 3152]) {
    await killPort(port);
  }
  await sleep(500);

  log('  启动 Bun 网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.timeout-test.ts';
  const gateway = startBunGateway(DYNAPM_CONFIG);
  if (!await waitForPort(3140, 10000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3141, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(300);

  section('超时 1：启动超时（startTimeout=300ms + 后端永不监听）');
  await runTest('启动超时返回 503 且状态复位 offline', test_start_timeout_503_and_offline, results);

  section('超时 2：代理超时（proxyTimeoutMs=800 + 后端 hang）');
  await runTest('后端 hang 住返回 504', test_proxy_timeout_504, results);

  section('超时 3：stopping 等待超时（stopWaitMs=800 + stop 命令挂起）');
  await runTest('stopping 超时返回 503 而非永久挂起', test_stopping_wait_timeout_503, results);

  section('清理环境');
  gateway.kill('SIGKILL');
  for (const port of [3140, 3141, 3150, 3151, 3152]) {
    await killPort(port);
  }
  log('  ✓ 所有进程已清理', C.green);

  summarizeAndExit(results);
}

main().catch((err) => {
  log(`测试主流程异常: ${err instanceof Error ? err.stack : err}`, C.red);
  process.exit(1);
});
