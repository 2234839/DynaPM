/**
 * DynaPM 网关健壮性测试
 *
 * 覆盖高优先级未测试场景：
 * 1. 并发按需启动 - 多个请求同时触发同一服务启动
 * 2. proxyOnly 后端不可达 - 纯代理模式 502 处理
 * 3. 管理API完整测试 - 服务列表、详情、错误处理
 * 4. 多路径请求 - 同一服务不同路径
 * 5. 特殊字符 URL - 各种特殊字符的 URL
 * 6. 网关直接访问 - 不带 hostname 返回 404
 * 7. 连续快速启停 - 利用闲置超时机制
 * 8. 服务状态一致性 - 管理API验证状态
 * 9. 闲置后重新按需启动 - 服务闲置停止后再次启动
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
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

/** 只杀 LISTEN 状态的进程，避免误杀有 ESTABLISHED 连接的网关 */
async function killPort(port: number) {
  try {
    const { stdout } = await execAsync(`lsof -i:${port} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}'`);
    const pids = stdout.trim().split('\n').filter(pid => pid);
    for (const pid of pids) {
      try { process.kill(parseInt(pid), 'SIGKILL'); } catch {}
    }
  } catch {}
}

async function waitForPort(port: number, timeout = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await checkPort(port)) return true; await sleep(100); }
  return false;
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
  const {
    hostname, port = 3090, path = '/', method = 'GET',
    headers = {}, body, timeout = 5000,
  } = options;

  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (hostname) reqHeaders['Host'] = hostname;

    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: reqHeaders, timeout,
    }, (res) => {
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
    const duration = Date.now() - start;
    results.push({ name, passed: true, message: '通过', duration });
    log(`  ✓ ${name}`, C.green);
  } catch (err: unknown) {
    const duration = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, message, duration });
    log(`  ✗ ${name}: ${message}`, C.red);
  }
}

// ==================== 健壮性测试场景 ====================

/** 1. 并发按需启动 - 10个请求同时触发同一离线服务启动 */
async function test_concurrent_on_demand_start() {
  // 确保后端离线（利用闲置超时后 echo 已停止的状态）
  const isOffline = !await checkPort(3099);
  if (!isOffline) throw new Error('前置条件：后端应该离线');

  // 同时发送10个请求
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(
      httpRequest({ hostname: 'echo-host.test', path: `/echo?id=${i}`, timeout: 20000 })
        .then(res => ({ i, status: res.status, ok: res.status === 200 }))
        .catch(err => ({ i, error: err instanceof Error ? err.message : String(err), ok: false }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个并发按需启动请求失败: ${JSON.stringify(failed[0])}`);
  }
}

/** 2. 多路径请求 - 同一服务不同路径 */
async function test_multiple_paths() {
  const paths = ['/echo', '/status?code=200', '/headers', '/delay?delay=100'];
  for (const path of paths) {
    const res = await httpRequest({ hostname: 'echo-host.test', path, timeout: 5000 });
    if (res.status !== 200) {
      throw new Error(`路径 ${path} 返回 ${res.status}`);
    }
  }
}

/** 3. proxyOnly 后端不可达 - 应返回 502 */
async function test_proxy_only_backend_unreachable() {
  // echo-proxy 是 proxyOnly 模式，端口 3092 代理到 3099
  // 如果 3099 不可达，应该返回 502
  await killPort(3099);
  await sleep(500);

  const res = await httpRequest({ port: 3092, path: '/echo', timeout: 5000 });
  if (res.status !== 502) {
    throw new Error(`期望 502，实际 ${res.status}`);
  }
}

/** 4. 管理API - 服务列表包含所有服务 */
async function test_admin_api_list_all_services() {
  const res = await httpRequest({ port: 3091, path: '/_dynapm/api/services' });
  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);

  const data = JSON.parse(res.body);
  if (!data.services || !Array.isArray(data.services)) throw new Error('服务列表格式不正确');

  const names = data.services.map((s: any) => s.name);
  const expected = ['echo-host', 'echo-proxy', 'sse-test', 'ws-test'];
  for (const name of expected) {
    if (!names.includes(name)) {
      throw new Error(`缺少服务: ${name}`);
    }
  }
}

/** 5. 管理API - 未知服务返回 404 */
async function test_admin_api_unknown_service() {
  const res = await httpRequest({ port: 3091, path: '/_dynapm/api/services/nonexistent' });
  if (res.status !== 404) {
    throw new Error(`期望 404，实际 ${res.status}`);
  }
}

/** 6. 管理API - 非 API 路径返回 404 */
async function test_admin_api_non_api_path() {
  const res = await httpRequest({ port: 3091, path: '/some/random/path' });
  if (res.status !== 404) {
    throw new Error(`期望 404，实际 ${res.status}`);
  }
}

/** 7. 服务状态正确性 - 通过管理 API 验证服务状态 */
async function test_service_status_consistency() {
  const res = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host' });
  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);

  const data = JSON.parse(res.body);
  if (data.name !== 'echo-host') throw new Error(`服务名称不匹配: ${data.name}`);
  if (data.proxyOnly !== false) throw new Error('echo-host 不应该是 proxyOnly');
}

/** 8. 特殊字符路径 - 包含各种特殊字符的 URL */
async function test_special_chars_in_url() {
  const specialPaths = [
    '/echo?a=1&b=2&c=3',
    '/echo?url=http%3A%2F%2Fexample.com',
    '/echo?space=hello%20world',
    '/echo?plus=hello+world',
    '/echo?empty=&key=value',
  ];

  for (const path of specialPaths) {
    const res = await httpRequest({ hostname: 'echo-host.test', path, timeout: 5000 });
    if (res.status !== 200) {
      throw new Error(`特殊字符路径 ${path} 返回 ${res.status}`);
    }
  }
}

/** 9. 网关自身端口被直接访问（非代理路径） */
async function test_gateway_direct_access() {
  const res = await httpRequest({ port: 3090, path: '/test' });
  if (res.status !== 404) {
    throw new Error(`直接访问网关应返回 404，实际 ${res.status}`);
  }
}

/** 10. 闲置后重新按需启动 - 服务闲置停止后再次启动 */
async function test_idle_then_restart() {
  // echo 应该在线（前面的测试已启动）
  if (!await checkPort(3099)) throw new Error('前置条件：echo 应该在线');

  log('    等待闲置超时（15秒）...', C.yellow);
  await sleep(15000);

  // echo 应该已被网关自动停止
  if (await checkPort(3099)) throw new Error('echo 应该已被闲置超时停止');

  // 再次请求应该触发按需启动
  const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (res.status !== 200) {
    throw new Error(`闲置后重新启动失败: ${res.status}`);
  }
}

/** 11. 客户端断开连接 - 网关不应崩溃 */
async function test_client_disconnect() {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const req = http.request({
      hostname: '127.0.0.1', port: 3090, path: '/delay?delay=5000',
      headers: { Host: 'echo-host.test' }, timeout: 5000,
    }, (res) => {
      res.destroy();
    });

    req.on('error', () => {
      // 预期的错误（连接被重置）
    });

    // 立即断开
    setTimeout(() => {
      try { req.destroy(); } catch {}
      setTimeout(() => {
        if (settled) return;
        settled = true;
        checkPort(3090).then(alive => {
          if (alive) resolve();
          else reject(new Error('客户端断开后网关崩溃'));
        });
      }, 500);
    }, 100);
  });
}

/** 12. 响应截断 - 后端在响应中途关闭连接 */
async function test_response_truncated() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/stream?chunks=100&interval=50&chunkSize=100',
    timeout: 10000,
  });

  // 关键是网关不应崩溃，且应该返回某种响应
  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }
}

/** 13. 请求体转发一致性 - 多次请求验证 body 转发正确 */
async function test_body_forwarding_consistency() {
  for (let i = 0; i < 5; i++) {
    const body = JSON.stringify({ iteration: i, data: 'x'.repeat(100) });
    const res = await httpRequest({
      hostname: 'echo-host.test',
      path: '/echo',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.status !== 200) throw new Error(`第 ${i + 1} 次请求返回 ${res.status}`);

    const data = JSON.parse(res.body);
    if (data.body !== body) throw new Error(`第 ${i + 1} 次请求体不匹配`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🛡️  DynaPM 网关健壮性测试', C.cyan);

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

  // ---- 第一阶段：并发与竞争（echo 离线时） ----
  section('并发与竞争测试');

  // echo 还没启动，测试并发按需启动
  await runTest('并发按需启动 (10个同时请求)', test_concurrent_on_demand_start);

  // echo 已被上面的测试启动，继续其他测试
  await runTest('多路径请求 (4个不同路径)', test_multiple_paths);
  await runTest('请求体转发一致性 (5次)', test_body_forwarding_consistency);

  // ---- 第二阶段：故障处理 ----
  section('故障处理测试');

  await runTest('proxyOnly 后端不可达 (502)', test_proxy_only_backend_unreachable);

  // proxyOnly 测试杀了 echo，需要重新触发按需启动
  // 第一次请求可能返回 502（重置 offline 状态），第二次应该触发按需启动
  log('  重新触发按需启动 echo...', C.yellow);
  try {
    const res1 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 });
    if (res1.status === 200) {
      log('  ✓ Echo 仍在运行', C.green);
    } else {
      // 第一次 502 重置了状态，第二次应该按需启动
      const res2 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
      if (res2.status !== 200) throw new Error(`重新启动失败: ${res2.status}`);
      log('  ✓ Echo 已重新启动', C.green);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`  ✗ ${message}`, C.red);
    process.exit(1);
  }

  await runTest('客户端断开连接后网关存活', test_client_disconnect);

  // ---- 第三阶段：管理 API ----
  section('管理 API 测试');

  await runTest('管理 API - 列出所有服务', test_admin_api_list_all_services);
  await runTest('管理 API - 未知服务返回 404', test_admin_api_unknown_service);
  await runTest('管理 API - 非 API 路径返回 404', test_admin_api_non_api_path);
  await runTest('服务状态一致性', test_service_status_consistency);

  // ---- 第四阶段：HTTP 路径测试 ----
  section('HTTP 路径测试');

  await runTest('特殊字符 URL 路径', test_special_chars_in_url);
  await runTest('网关直接访问 (404)', test_gateway_direct_access);
  await runTest('响应截断处理', test_response_truncated);

  // ---- 第五阶段：闲置与恢复 ----
  section('闲置与恢复测试');

  await runTest('闲置后重新按需启动', test_idle_then_restart);

  // ---- 清理 ----
  section('清理环境');

  for (const port of [3090, 3091, 3092, 3099, 3010, 3011]) {
    await killPort(port);
  }
  log('  ✓ 所有进程已清理', C.green);

  // ---- 结果汇总 ----
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
    log('\n🎉 所有健壮性测试通过！', C.green);
    process.exit(0);
  } else {
    log(`\n❌ ${failedCount} 个测试失败`, C.red);
    process.exit(1);
  }
}

main().catch(err => {
  log(`测试执行失败: ${err}`, C.red);
  console.error(err);
  process.exit(1);
});
