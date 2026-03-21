/**
 * DynaPM 服务启动失败恢复测试
 *
 * 覆盖按需启动生命周期中的极端场景：
 * 1. 后端崩溃后自动恢复 — 网关检测到 ECONNREFUSED → 重置 offline → 下次请求重新按需启动
 * 2. stopping 状态下请求到达 → 等待停止完成 → 重新按需启动
 * 3. 并发请求在 starting 期间全部正确响应
 * 4. 连续启停循环不泄漏资源或导致状态错误
 * 5. 后端 500 错误透传不影响服务状态
 * 6. 超大请求头不导致网关崩溃
 * 7. proxyOnly 后端重启后端口路由自动恢复
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
    const { stdout } = await execAsync(`lsof -i:${port} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}'`);
    const pids = stdout.trim().split('\n').filter(pid => pid);
    for (const pid of pids) {
      try { process.kill(parseInt(pid), 'SIGKILL'); } catch {}
    }
  } catch {}
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

/**
 * 确保后端在线：先检查端口，如果离线则通过网关触发按需启动
 */
async function ensureEchoOnline(): Promise<void> {
  if (await checkPort(3099)) return;
  const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (res.status !== 200) {
    throw new Error(`echo 按需启动失败: ${res.status}`);
  }
}

/**
 * 确保后端离线且网关状态同步为 offline
 *
 * 直接 kill 端口后，网关可能仍认为服务是 online。
 * 需要发一个请求让网关发现 ECONNREFUSED 并自动重置状态。
 */
async function ensureEchoOffline(): Promise<void> {
  if (!await checkPort(3099)) {
    /** 后端已离线，但网关状态可能还是 online，发一个请求触发状态重置 */
    try {
      await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 });
    } catch {}
    await sleep(200);
    return;
  }
  await killPort(3099);
  await sleep(300);
  /** 发一个请求让网关发现后端不可达，重置为 offline */
  try {
    await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 });
  } catch {}
  await sleep(200);
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

/**
 * 1. 后端崩溃后自动恢复
 *
 * 流程：通过网关按需启动 echo → 直接 kill 后端进程 → 请求返回 502 →
 * 网关自动重置为 offline → 下次请求重新触发按需启动 → 成功
 */
async function test_backend_crash_auto_recovery() {
  /** 确保后端通过网关按需启动（网关状态为 online） */
  await ensureEchoOnline();
  log('    后端已通过网关按需启动', C.yellow);

  /** 直接 kill 后端进程，模拟崩溃 */
  await killPort(3099);
  await sleep(300);
  if (await checkPort(3099)) {
    throw new Error('后端应该已被杀掉');
  }

  /** 第一个请求：网关认为服务 online → handleDirectProxy → ECONNREFUSED → 502 + 重置 offline */
  const res1 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 });
  if (res1.status !== 502) {
    throw new Error(`第一次请求期望 502（ECONNREFUSED），实际 ${res1.status}`);
  }

  /** 第二个请求：网关认为服务 offline → handleServiceStart → 按需启动 → 200 */
  const res2 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (res2.status !== 200) {
    throw new Error(`第二次请求期望 200（按需启动恢复），实际 ${res2.status}`);
  }

  /** 验证后端已恢复 */
  if (!await checkPort(3099)) {
    throw new Error('后端应该已恢复运行');
  }
}

/**
 * 2. stopping 状态下请求到达 → 等待停止完成 → 重新启动
 *
 * 测试 handleServiceWithWait 的逻辑
 */
async function test_request_during_stopping() {
  await ensureEchoOnline();

  /** 通过 admin API 停止 echo（异步执行，会经历 stopping → offline） */
  const stopRes = await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/stop',
    method: 'POST',
    timeout: 10000,
  });
  if (stopRes.status !== 200) {
    throw new Error(`停止服务失败: ${stopRes.status} ${stopRes.body}`);
  }

  /** 等待停止命令发出，服务可能仍在 stopping 状态 */
  await sleep(200);

  /** 在 stopping 或 offline 状态下发送请求 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 20000,
  });

  if (res.status !== 200) {
    throw new Error(`stopping 状态下请求期望 200，实际 ${res.status}`);
  }
}

/**
 * 3. 并发请求在服务 starting 期间全部到达，启动成功后全部正确响应
 *
 * 验证 startingPromises 机制
 */
async function test_concurrent_requests_during_starting() {
  /** 确保后端离线且网关状态同步为 offline */
  await ensureEchoOffline();

  /** 同时发送 5 个请求，第一个触发按需启动，其余等待 */
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: `/echo?id=${i}`,
        timeout: 20000,
      }).then(res => ({ i, status: res.status, body: res.body }))
    );
  }

  const res = await Promise.all(promises);

  for (const r of res) {
    if (r.status !== 200) {
      throw new Error(`请求 ${r.i} 返回 ${r.status}`);
    }
    const data = JSON.parse(r.body);
    if (data.params.id !== String(r.i)) {
      throw new Error(`请求 ${r.i} 的参数不匹配`);
    }
  }
}

/**
 * 4. 连续启停循环 — 服务反复启动和停止不应泄漏资源或导致状态错误
 */
async function test_rapid_start_stop_cycle() {
  for (let cycle = 0; cycle < 3; cycle++) {
    /** 确保后端离线且网关状态同步为 offline */
    await ensureEchoOffline();

    /** 触发按需启动 */
    const res = await httpRequest({
      hostname: 'echo-host.test',
      path: `/echo?cycle=${cycle}`,
      timeout: 20000,
    });

    if (res.status !== 200) {
      throw new Error(`第 ${cycle + 1} 轮启动失败: ${res.status}`);
    }

    const data = JSON.parse(res.body);
    if (data.params.cycle !== String(cycle)) {
      throw new Error(`第 ${cycle + 1} 轮参数不匹配`);
    }

    /** 等待闲置超时（10s）+ 3s buffer */
    log(`    第 ${cycle + 1} 轮完成，等待闲置超时...`, C.yellow);
    await sleep(14000);

    if (await checkPort(3099)) {
      throw new Error(`第 ${cycle + 1} 轮：服务应已闲置停止`);
    }
  }
}

/**
 * 5. 后端返回 500 错误 → 网关正确透传，不崩溃，不重置服务状态
 */
async function test_backend_500_passthrough() {
  await ensureEchoOnline();

  /** 请求后端返回 500 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/status?code=500',
    timeout: 5000,
  });

  if (res.status !== 500) {
    throw new Error(`期望 500，实际 ${res.status}`);
  }

  /** 500 不应影响后续请求 */
  const res2 = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });

  if (res2.status !== 200) {
    throw new Error(`500 后续请求期望 200，实际 ${res2.status}`);
  }

  if (!await checkPort(3099)) {
    throw new Error('服务不应因 500 被停止');
  }
}

/**
 * 6. 超大请求头不导致网关崩溃
 */
async function test_very_large_request_headers() {
  await ensureEchoOnline();

  /** 构建超大请求头（接近 uWS 默认限制） */
  const headers: Record<string, string> = {};
  for (let i = 0; i < 50; i++) {
    headers[`X-Large-Header-${i}`] = 'v'.repeat(4000);
  }

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/headers',
    headers,
    timeout: 5000,
  });

  /** 可能被 uWS 拒绝（431），但网关不应崩溃 */
  if (res.status !== 200 && res.status !== 431) {
    throw new Error(`期望 200 或 431，实际 ${res.status}`);
  }

  /** 验证网关仍存活 */
  const healthCheck = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });

  if (healthCheck.status !== 200) {
    throw new Error(`超大请求头后网关异常: ${healthCheck.status}`);
  }
}

/**
 * 7. proxyOnly 后端重启后端口路由自动恢复
 */
async function test_proxyonly_backend_restart() {
  /** 确保 echo 在线 */
  await ensureEchoOnline();

  /** 通过端口路由发送请求 */
  const res1 = await httpRequest({ port: 3092, path: '/echo', timeout: 5000 });
  if (res1.status !== 200) {
    throw new Error(`端口路由期望 200，实际 ${res1.status}`);
  }

  /** 杀死后端并同步网关状态 */
  await ensureEchoOffline();

  /** 端口路由应该返回 502 */
  const res2 = await httpRequest({ port: 3092, path: '/echo', timeout: 5000 });
  if (res2.status !== 502) {
    throw new Error(`后端不可达时期望 502，实际 ${res2.status}`);
  }

  /** 通过 hostname 路由触发按需启动（网关状态可能已被 502 重置为 offline） */
  const res3 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (res3.status !== 200) {
    throw new Error(`后端重启失败: ${res3.status}`);
  }

  /** 端口路由应自动恢复（proxyOnly 始终 online，直接代理到 3099） */
  const res4 = await httpRequest({ port: 3092, path: '/echo', timeout: 5000 });
  if (res4.status !== 200) {
    throw new Error(`后端恢复后端口路由期望 200，实际 ${res4.status}`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔄 DynaPM 服务启动失败恢复测试', C.cyan);

  section('环境准备');

  for (const port of [3090, 3091, 3092, 3099, 3010, 3011]) {
    await killPort(port);
  }
  await sleep(500);

  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3090, 5000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3091, 5000);
  await waitForPort(3092, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(500);

  section('启动失败恢复');
  await runTest('后端崩溃后自动恢复 (502→offline→重启)', test_backend_crash_auto_recovery);

  section('状态转换');
  await runTest('stopping 状态下请求等待并重新启动', test_request_during_stopping);
  await runTest('并发请求在 starting 期间全部正确响应', test_concurrent_requests_during_starting);

  section('稳定性');
  await runTest('连续 3 轮启停循环', test_rapid_start_stop_cycle);
  await runTest('后端 500 错误透传不影响服务状态', test_backend_500_passthrough);
  await runTest('超大请求头不导致网关崩溃', test_very_large_request_headers);
  await runTest('proxyOnly 后端重启后端口路由自动恢复', test_proxyonly_backend_restart);

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
    log('\n🎉 所有启动恢复测试通过！', C.green);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch(console.error);
