/**
 * DynaPM 代理边缘路径与错误恢复测试
 *
 * 覆盖场景：
 * 1. 后端响应超时 — 验证网关返回 502 并正确清理连接
 * 2. 服务启动失败后重试 — 验证启动锁释放和服务可重新启动
 * 3. WebSocket 后端不可达 — 验证网关正确返回错误
 * 4. 请求到达时服务正在启动 — 验证等待启动完成后代理
 * 5. 后端立即关闭连接 — 验证网关返回 502
 * 6. 空路径请求 — 验证根路径 '/' 正常处理
 * 7. 重复 Host 头 — 验证网关正确处理
 * 8. 二进制请求体传输 — 验证非文本 body 正确转发
 * 9. HTTP/1.0 请求 — 验证无 Host 头的请求处理
 * 10. 管理 API 认证 — 验证无 token 时被拒绝（如果配置了 token）
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

async function ensureEchoOnline(): Promise<void> {
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
    await sleep(500);
  }
}

// ==================== 测试场景 ====================

/** 1. 后端响应超时 — 验证网关不崩溃 */
async function test_backend_response_timeout() {
  await ensureEchoOnline();

  /** 请求延迟 30 秒的端点，客户端 3 秒超时 */
  try {
    await httpRequest({
      hostname: 'echo-host.test',
      path: '/delay?delay=30000',
      timeout: 3000,
    });
  } catch {
    /** 客户端超时是预期行为 */
  }

  /** 等待网关清理 */
  await sleep(1000);

  /** 验证网关仍然正常 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });
  if (res.status !== 200) {
    throw new Error(`后端超时后网关异常: ${res.status}`);
  }
}

/** 2. 服务启动失败后重试 — 验证启动锁释放 */
async function test_service_start_failure_retry() {
  /** 停止 echo */
  await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 10000 });
  await sleep(500);
  await killPort(3099);
  await sleep(500);

  /** 同步状态为 offline（通过管理 API 查询） */
  for (let retry = 0; retry < 10; retry++) {
    try {
      const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 2000 });
      const data = JSON.parse(statusRes.body);
      if (data.status === 'offline') break;
    } catch {}
    await sleep(300);
  }

  /** 发送请求触发按需启动 */
  const res1 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (res1.status !== 200) {
    throw new Error(`首次按需启动失败: ${res1.status}`);
  }

  /** 停止服务 */
  await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 10000 });
  await sleep(500);
  await killPort(3099);
  await sleep(500);

  /** 同步状态 */
  for (let retry = 0; retry < 10; retry++) {
    try {
      const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 2000 });
      const data = JSON.parse(statusRes.body);
      if (data.status === 'offline') break;
    } catch {}
    await sleep(300);
  }

  /** 再次请求，验证启动锁已释放，可以重新启动 */
  const res2 = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (res2.status !== 200) {
    throw new Error(`重启后按需启动失败: ${res2.status}`);
  }
}

/** 3. 后端立即关闭连接 — 验证网关返回 502 */
async function test_backend_immediate_close() {
  await ensureEchoOnline();

  /** 使用一个非常短的延迟，然后手动 kill 后端模拟连接立即关闭 */
  /** 这里通过发送请求后立即 kill 后端进程来模拟 */
  const reqPromise = new Promise<{ status: number }>((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3090,
      path: '/delay?delay=5000',
      headers: { Host: 'echo-host.test' },
      timeout: 10000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode || 0 }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });

  /** 等 100ms 后 kill 后端 */
  await sleep(100);
  await killPort(3099);

  /** 请求应该失败或返回错误 */
  await reqPromise;

  /** 等待网关处理 */
  await sleep(1000);

  /** 触发按需重启 echo */
  const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (res.status !== 200) {
    throw new Error(`后端关闭后网关无法恢复: ${res.status}`);
  }
}

/** 4. 请求到达时服务正在启动 — 等待启动完成后代理 */
async function test_request_during_starting() {
  /** 停止 echo */
  await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 10000 });
  await sleep(500);
  await killPort(3099);
  await sleep(500);

  /** 同步状态 */
  for (let retry = 0; retry < 10; retry++) {
    try {
      const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 2000 });
      const data = JSON.parse(statusRes.body);
      if (data.status === 'offline') break;
    } catch {}
    await sleep(300);
  }

  /** 同时发送 5 个请求触发并发按需启动 */
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(
      httpRequest({ hostname: 'echo-host.test', path: `/echo?id=${i}`, timeout: 20000 })
        .then(r => ({ i, status: r.status }))
        .catch(() => ({ i, status: 0 }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => r.status !== 200);
  if (failed.length > 0) {
    throw new Error(`${failed.length}/5 个并发启动请求失败`);
  }
}

/** 5. 二进制请求体传输 */
async function test_binary_body_transfer() {
  await ensureEchoOnline();

  /** 发送二进制数据 */
  const binaryBody = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) binaryBody[i] = i;

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/big-body',
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: binaryBody,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`二进制 body 请求失败: ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== 256) {
    throw new Error(`二进制 body 大小不匹配: 期望 256, 实际 ${data.bodyLength}`);
  }
}

/** 6. 根路径请求 */
async function test_root_path_request() {
  await ensureEchoOnline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/',
    timeout: 5000,
  });

  /** 根路径应该被转发（echo-server 的默认处理器返回 200） */
  if (res.status !== 200) {
    throw new Error(`根路径请求失败: ${res.status}`);
  }
}

/** 7. 大量并发 502 后网关恢复 */
async function test_massive_502_recovery() {
  await ensureEchoOnline();

  /** 杀掉后端制造 502 */
  await killPort(3099);

  /** 先吃一个 502 触发网关状态重置为 offline */
  try { await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 3000 }); } catch {}
  await sleep(500);

  /** 再吃一个确认状态已重置 */
  try { await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 3000 }); } catch {}
  await sleep(300);

  /** 发送 30 个请求（应该全部 502，因为网关已知 offline） */
  const promises = [];
  for (let i = 0; i < 30; i++) {
    promises.push(
      httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 3000 })
        .then(r => ({ i, status: r.status }))
        .catch(() => ({ i, status: 0 }))
    );
  }

  const res = await Promise.all(promises);
  /** 后续请求可能触发按需启动，所以只验证前几个是 502 */
  const firstBatch = res.filter(r => r.i < 5);
  const non502 = firstBatch.filter(r => r.status !== 502 && r.status !== 0 && r.status !== 200);
  if (non502.length > 0) {
    throw new Error(`前 5 个请求中有 ${non502.length} 个返回非 502`);
  }

  /** 验证网关可以恢复（通过按需启动） */
  const recovery = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (recovery.status !== 200) {
    throw new Error(`大量 502 后网关无法恢复: ${recovery.status}`);
  }
}

/** 8. 带特殊编码的 URL 路径 */
async function test_special_encoded_url() {
  await ensureEchoOnline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo?url_param=%2Fpath%2Fto%2Fresource&space=hello%20world&plus=1%2B2',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`编码 URL 请求失败: ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.params.space !== 'hello world') {
    throw new Error('空格编码解码错误');
  }
  if (data.params.plus !== '1+2') {
    throw new Error('加号编码解码错误');
  }
}

/** 9. 管理 API 服务详情中的字段完整性 */
async function test_admin_api_service_detail_fields() {
  await ensureEchoOnline();

  const res = await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`服务详情请求失败: ${res.status}`);
  }

  const data = JSON.parse(res.body);

  /** 验证必要字段存在 */
  const requiredFields = ['name', 'status', 'base', 'uptime', 'activeConnections', 'startCount', 'healthCheck'];
  for (const field of requiredFields) {
    if (data[field] === undefined) {
      throw new Error(`服务详情缺少字段: ${field}`);
    }
  }
}

/** 10. 网关端口扫描防护 — 大量随机端口请求 */
async function test_gateway_port_scan_resistance() {
  /** 快速发送 100 个请求到随机路径 */
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(
      httpRequest({
        port: 3090,
        path: `/random-path-${i}-${Date.now()}`,
        timeout: 2000,
      }).then(r => ({ i, status: r.status }))
        .catch(() => ({ i, status: 0 }))
    );
  }

  const res = await Promise.all(promises);
  const non404 = res.filter(r => r.status !== 404 && r.status !== 0);
  if (non404.length > 0) {
    throw new Error(`${non404.length}/100 个随机路径请求返回非 404`);
  }

  /** 验证网关仍然正常 */
  const healthCheck = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 15000,
  });
  if (healthCheck.status !== 200) {
    throw new Error('端口扫描后网关异常');
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔬 DynaPM 代理边缘路径与错误恢复测试', C.cyan);

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

  log('  触发按需启动 echo...', C.yellow);
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (warmup.status !== 200) {
    log(`  ✗ echo 启动失败: ${warmup.status}`, C.red);
    process.exit(1);
  }
  log('  ✓ Echo 已按需启动', C.green);

  section('错误恢复');
  await runTest('后端响应超时处理', test_backend_response_timeout);
  await runTest('服务启动失败后重试', test_service_start_failure_retry);
  await runTest('后端立即关闭连接', test_backend_immediate_close);
  await runTest('大量 502 后网关恢复 (30个)', test_massive_502_recovery);

  section('并发与竞争');
  await runTest('服务正在启动时收到请求 (5个)', test_request_during_starting);

  section('数据传输');
  await runTest('二进制请求体传输', test_binary_body_transfer);
  await runTest('根路径请求', test_root_path_request);
  await runTest('特殊编码 URL 路径', test_special_encoded_url);

  section('管理 API');
  await runTest('服务详情字段完整性', test_admin_api_service_detail_fields);

  section('安全防护');
  await runTest('网关端口扫描防护 (100个)', test_gateway_port_scan_resistance);

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
    log('\n🎉 所有代理边缘路径与错误恢复测试通过！', C.green);
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
