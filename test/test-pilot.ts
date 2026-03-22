/**
 * DynaPM Pilot 实际运行测试
 *
 * 使用 dynapm.config.ts（生产配置）启动网关，
 * 验证各服务的按需启动、代理转发、闲置停止等完整生命周期。
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
  const { hostname, port = 3000, path = '/', method = 'GET', headers = {}, body, timeout = 10000 } = options;
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

/** 管理 API 辅助 */
async function adminRequest(path: string, method = 'GET', timeout = 10000) {
  return httpRequest({ port: 4000, path, method, timeout });
}

// ==================== 测试场景 ====================

/** 1. app1 按需启动 */
async function test_app1_on_demand() {
  if (await checkPort(3001)) {
    throw new Error('前置条件：app1 应离线');
  }

  const res = await httpRequest({ hostname: 'app1.test', path: '/', timeout: 15000 });
  if (res.status !== 200) {
    throw new Error(`app1 按需启动期望 200，实际 ${res.status}`);
  }
  if (!res.body.includes('App 1')) {
    throw new Error(`app1 响应不匹配: "${res.body}"`);
  }

  if (!await checkPort(3001)) {
    throw new Error('app1 应已启动');
  }
}

/** 2. app2 按需启动（HTTP 健康检查） */
async function test_app2_on_demand() {
  if (await checkPort(3002)) {
    throw new Error('前置条件：app2 应离线');
  }

  const res = await httpRequest({ hostname: 'app2.test', path: '/', timeout: 15000 });
  if (res.status !== 200) {
    throw new Error(`app2 按需启动期望 200，实际 ${res.status}`);
  }

  if (!await checkPort(3002)) {
    throw new Error('app2 应已启动');
  }
}

/** 3. app3 按需启动 */
async function test_app3_on_demand() {
  if (await checkPort(3003)) {
    throw new Error('前置条件：app3 应离线');
  }

  const res = await httpRequest({ hostname: 'app3.test', path: '/', timeout: 15000 });
  if (res.status !== 200) {
    throw new Error(`app3 按需启动期望 200，实际 ${res.status}`);
  }

  if (!await checkPort(3003)) {
    throw new Error('app3 应已启动');
  }
}

/** 4. 多服务并发按需启动 */
async function test_multi_service_concurrent_start() {
  /** 确保所有后端离线且网关状态同步 */
  for (const port of [3001, 3002, 3003]) {
    await killPort(port);
  }
  await sleep(300);

  /** 发请求让网关发现后端不可达，重置状态 */
  for (const host of ['app1.test', 'app2.test', 'app3.test']) {
    try { await httpRequest({ hostname: host, path: '/', timeout: 5000 }); } catch {}
  }
  await sleep(200);

  /** 同时请求 3 个服务 */
  const promises = [
    httpRequest({ hostname: 'app1.test', path: '/', timeout: 20000 }).then(r => ({ name: 'app1', status: r.status })),
    httpRequest({ hostname: 'app2.test', path: '/', timeout: 20000 }).then(r => ({ name: 'app2', status: r.status })),
    httpRequest({ hostname: 'app3.test', path: '/', timeout: 20000 }).then(r => ({ name: 'app3', status: r.status })),
  ];

  const res = await Promise.all(promises);
  for (const r of res) {
    if (r.status !== 200) {
      throw new Error(`${r.name} 并发启动期望 200，实际 ${r.status}`);
    }
  }
}

/** 5. 管理 API — 列出所有服务 */
async function test_admin_list_services() {
  const res = await adminRequest('/_dynapm/api/services');
  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (!data.services || !Array.isArray(data.services)) {
    throw new Error('服务列表格式不正确');
  }

  const names = data.services.map((s: { name?: string }) => s.name);
  const expected = ['app1', 'app2', 'app3', 'sse-server', 'ws-server', 'stream-test', 'serverless-host', 'dynapm-admin'];
  for (const name of expected) {
    if (!names.includes(name)) {
      throw new Error(`缺少服务: ${name}`);
    }
  }
}

/** 6. 管理 API — 服务状态查询 */
async function test_admin_service_status() {
  /** 确保 app1 在线 */
  if (!await checkPort(3001)) {
    await httpRequest({ hostname: 'app1.test', path: '/', timeout: 15000 });
  }

  const res = await adminRequest('/_dynapm/api/services/app1');
  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.status !== 'online') {
    throw new Error(`app1 状态应为 online，实际 ${data.status}`);
  }
}

/** 7. 管理 API — 停止服务 */
async function test_admin_stop_service() {
  /** 确保 app1 在线 */
  if (!await checkPort(3001)) {
    await httpRequest({ hostname: 'app1.test', path: '/', timeout: 15000 });
  }

  const res = await adminRequest('/_dynapm/api/services/app1/stop', 'POST');
  if (res.status !== 200) {
    throw new Error(`停止 app1 期望 200，实际 ${res.status}`);
  }

  await sleep(500);
  if (await checkPort(3001)) {
    throw new Error('app1 应已被停止');
  }
}

/** 8. 管理 API — 启动服务 */
async function test_admin_start_service() {
  await killPort(3001);
  await sleep(200);

  const res = await adminRequest('/_dynapm/api/services/app1/start', 'POST');
  if (res.status !== 200) {
    throw new Error(`启动 app1 期望 200，实际 ${res.status}`);
  }

  if (!await waitForPort(3001, 5000)) {
    throw new Error('app1 应已启动');
  }
}

/** 9. 请求体转发验证 */
async function test_body_forwarding() {
  /** 确保 app1 在线 */
  await httpRequest({ hostname: 'app1.test', path: '/', timeout: 15000 });

  const testBody = JSON.stringify({ test: 'pilot-body-test', timestamp: Date.now() });
  const res = await httpRequest({
    hostname: 'app1.test',
    path: '/',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: testBody,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`POST 期望 200，实际 ${res.status}`);
  }

  if (!res.body.includes('App 1')) {
    throw new Error(`POST 响应不匹配: "${res.body}"`);
  }
}

/** 10. 404 未知服务 */
async function test_unknown_service_404() {
  const res = await httpRequest({ hostname: 'unknown.test', path: '/', timeout: 5000 });
  if (res.status !== 404) {
    throw new Error(`未知服务期望 404，实际 ${res.status}`);
  }
}

/** 11. app1 闲置超时自动停止 */
async function test_idle_timeout() {
  /** 确保 app1 在线 */
  if (!await checkPort(3001)) {
    await httpRequest({ hostname: 'app1.test', path: '/', timeout: 15000 });
  }

  log('    等待 app1 闲置超时（15秒）...', C.yellow);
  await sleep(15000);

  if (await checkPort(3001)) {
    throw new Error('app1 应已被闲置停止');
  }
}

/** 12. 闲置后重新按需启动 */
async function test_restart_after_idle() {
  if (await checkPort(3001)) {
    throw new Error('前置条件：app1 应离线');
  }

  const res = await httpRequest({ hostname: 'app1.test', path: '/', timeout: 15000 });
  if (res.status !== 200) {
    throw new Error(`闲置后重新启动期望 200，实际 ${res.status}`);
  }
}

/** 13. SSE 服务按需启动和代理 */
async function test_sse_service() {
  if (await checkPort(3010)) {
    throw new Error('前置条件：sse-server 应离线');
  }

  const res = await httpRequest({ hostname: 'sse.test', path: '/', timeout: 15000 });
  if (res.status !== 200) {
    throw new Error(`sse-server 期望 200，实际 ${res.status}`);
  }

  if (!await checkPort(3010)) {
    throw new Error('sse-server 应已启动');
  }
}

/** 14. WebSocket 服务按需启动 */
async function test_ws_service() {
  if (await checkPort(3011)) {
    throw new Error('前置条件：ws-server 应离线');
  }

  /** 触发按需启动 */
  const trigger = await httpRequest({ hostname: 'ws.test', path: '/', timeout: 15000 });
  if (trigger.status !== 200) {
    throw new Error(`ws-server 触发启动期望 200，实际 ${trigger.status}`);
  }

  if (!await checkPort(3011)) {
    throw new Error('ws-server 应已启动');
  }
}

/** 15. WebSocket 双向通信 */
async function test_ws_communication() {
  if (!await checkPort(3011)) {
    await httpRequest({ hostname: 'ws.test', path: '/', timeout: 15000 });
  }

  const ws = new WS('ws://127.0.0.1:3011/');

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  /** 发送消息并等待回显 */
  const msg = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 消息超时')), 5000);
    ws.on('message', (data) => { clearTimeout(timer); resolve(data.toString()); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.send('pilot-ws-test');
  });

  if (!msg.includes('pilot-ws-test')) {
    ws.close();
    throw new Error(`WebSocket 回显不匹配: "${msg}"`);
  }

  ws.close();
}

/** 16. 管理 API 启动已运行服务返回 400 */
async function test_admin_start_already_running() {
  /** 确保 app1 在线 */
  if (!await checkPort(3001)) {
    await httpRequest({ hostname: 'app1.test', path: '/', timeout: 15000 });
  }

  const res = await adminRequest('/_dynapm/api/services/app1/start', 'POST');
  if (res.status !== 400) {
    throw new Error(`启动已运行服务期望 400，实际 ${res.status}`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🚀 DynaPM Pilot 实际运行测试', C.cyan);

  section('环境准备');

  /** 清理所有端口 */
  for (const port of [3000, 3001, 3002, 3003, 3010, 3011, 4000, 4001, 3998, 3999]) {
    await killPort(port);
  }
  await sleep(500);

  /** 使用生产配置启动网关 */
  log('  启动网关 (dynapm.config.ts)...', C.yellow);
  exec(`DYNAPM_CONFIG=${process.cwd()}/dynapm.config.ts nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3000, 5000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(4000, 5000);
  log('  ✓ 网关已启动 (port 3000, admin 4000)', C.green);
  await sleep(500);

  section('按需启动');
  await runTest('app1 按需启动', test_app1_on_demand);
  await runTest('app2 按需启动 (HTTP 健康检查)', test_app2_on_demand);
  await runTest('app3 按需启动', test_app3_on_demand);
  await runTest('多服务并发按需启动 (app1+app2+app3)', test_multi_service_concurrent_start);

  section('管理 API');
  await runTest('列出所有服务', test_admin_list_services);
  await runTest('服务状态查询', test_admin_service_status);
  await runTest('停止服务 (app1)', test_admin_stop_service);
  await runTest('启动服务 (app1)', test_admin_start_service);
  await runTest('启动已运行服务返回 400', test_admin_start_already_running);

  section('代理功能');
  await runTest('请求体转发', test_body_forwarding);
  await runTest('未知服务 404', test_unknown_service_404);
  await runTest('SSE 服务按需启动', test_sse_service);
  await runTest('WebSocket 服务按需启动', test_ws_service);
  await runTest('WebSocket 双向通信', test_ws_communication);

  section('闲置管理');
  await runTest('app1 闲置超时自动停止', test_idle_timeout);
  await runTest('闲置后重新按需启动', test_restart_after_idle);

  section('清理环境');

  for (const port of [3000, 3001, 3002, 3003, 3010, 3011, 4000, 4001, 3998, 3999]) {
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
    log('\n🎉 所有 Pilot 测试通过！', C.green);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch(console.error);
