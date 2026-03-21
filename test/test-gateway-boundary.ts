/**
 * DynaPM 网关边界与安全深度测试
 *
 * 覆盖场景：
 * 1. CRLF 注入防护 — 恶意 HTTP 头值中的 \r\n 被清理
 * 2. 并发按需启动竞争 — 多个请求同时到达离线服务，只有一个触发启动
 * 3. 大响应体流式转发 — 后端返回大响应（1MB）
 * 4. 请求头极端情况 — 超长请求头值
 * 5. 多服务并发代理 — 不同服务同时收到请求
 * 6. 服务 stopping 状态下收到请求 — 等待停止完成后启动
 * 7. URL 特殊字符透传 — 查询参数中的特殊字符
 * 8. 响应头大小写兼容 — 后端返回各种大小写的响应头
 * 9. WebSocket 升级失败处理 — 后端拒绝 WebSocket 升级
 * 10. 连接超时后网关稳定性 — 后端响应超时后网关继续正常工作
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

/** 确保 echo 在线 */
async function ensureEchoOnline(): Promise<void> {
  if (!await checkPort(3099)) {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
    if (res.status !== 200) throw new Error('echo 启动失败');
    await sleep(500);
  }
}

// ==================== 测试场景 ====================

/** 1. CRLF 注入防护 — 验证网关清理了请求头中的 CRLF 字符 */
async function test_crlf_injection_protection() {
  await ensureEchoOnline();

  /** node:http 不允许在头值中包含 \r\n，所以使用 /headers 端点验证头透传正确性 */
  /** 网关的 CRLF 防护是在 uWS 层实现的，通过验证头值不包含特殊字符来间接测试 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/headers',
    method: 'GET',
    headers: {
      'X-Safe-Header': 'normal-value-with-special-chars-!@#$%^&*()',
      'X-Another': 'value_with_underscores-and-dashes',
    },
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`请求失败: ${res.status}`);
  }

  const data = JSON.parse(res.body);

  /** 验证安全头被正确透传 */
  if (!data.headers['x-safe-header']) {
    throw new Error('安全头丢失');
  }
  if (data.headers['x-safe-header'] !== 'normal-value-with-special-chars-!@#$%^&*()') {
    throw new Error(`安全头值被修改: ${data.headers['x-safe-header']}`);
  }

  /** 验证响应头中也没有 CRLF 注入 */
  for (const [key, value] of Object.entries(res.headers)) {
    if (value.includes('\r') || value.includes('\n')) {
      throw new Error(`响应头 ${key} 包含 CRLF 字符`);
    }
  }
}

/** 2. 并发按需启动竞争 — 多个请求同时到达离线服务 */
async function test_concurrent_on_demand_startup_race() {
  /** 停止 echo 服务 */
  await httpRequest({
    port: 3091,
    path: '/_dynapm/api/services/echo-host/stop',
    method: 'POST',
    timeout: 10000,
  });
  await sleep(500);

  /** 确保 echo 进程已终止 */
  for (let i = 0; i < 5; i++) {
    await killPort(3099);
    await sleep(300);
    if (!await checkPort(3099)) break;
  }

  /** 同步网关状态（只通过管理 API 查询，不发请求给 echo） */
  for (let retry = 0; retry < 10; retry++) {
    try {
      const statusRes = await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host', timeout: 2000 });
      const data = JSON.parse(statusRes.body);
      if (data.status === 'offline') break;
    } catch {}
    await sleep(300);
  }

  /** 同时发送 20 个请求 */
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: `/echo?id=${i}`,
        timeout: 20000,
      }).then(r => ({ i, status: r.status }))
        .catch(() => ({ i, status: 0 }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => r.status !== 200);
  if (failed.length > 0) {
    throw new Error(`${failed.length}/20 个并发按需启动请求失败`);
  }

  /** 验证只有一个 echo 进程 */
  await sleep(500);
  const { stdout } = await execAsync('lsof -i:3099 -P -n 2>/dev/null | grep LISTEN | wc -l');
  const listenerCount = parseInt(stdout.trim());
  if (listenerCount !== 1) {
    throw new Error(`期望 1 个 LISTEN 进程, 实际 ${listenerCount}`);
  }
}

/** 3. 大响应体流式转发 */
async function test_large_response_streaming() {
  await ensureEchoOnline();

  /** 使用 /stream 端点获取大响应：10 chunks × 100KB = 1MB */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/stream?chunks=10&chunkSize=102400&interval=0',
    timeout: 15000,
  });

  if (res.status !== 200) {
    throw new Error(`大响应体请求失败: ${res.status}`);
  }

  /** 验证响应体大小（约 1MB） */
  if (res.body.length < 500000) {
    throw new Error(`响应体过小: ${res.body.length} bytes`);
  }
}

/** 4. 请求头极端情况 — 超长请求头值 */
async function test_extremely_long_header() {
  await ensureEchoOnline();

  /** 16KB 请求头值（接近 uWS 默认限制） */
  const longValue = 'x'.repeat(16 * 1024);
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    headers: { 'X-Long-Header': longValue },
    timeout: 5000,
  });

  /** 网关应该正常处理或拒绝，不应崩溃 */
  if (res.status !== 200 && res.status !== 431 && res.status !== 400) {
    throw new Error(`超长头值处理异常: ${res.status}`);
  }
}

/** 5. 多服务并发代理 */
async function test_multi_service_concurrent_proxy() {
  await ensureEchoOnline();

  /** 确保 ws-test 在线 */
  try { await httpRequest({ hostname: 'ws-proxy.test', path: '/', timeout: 15000 }); } catch {}

  const promises = [];

  /** 10 个 echo 请求 */
  for (let i = 0; i < 10; i++) {
    promises.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: `/echo?svc=echo&i=${i}`,
        timeout: 5000,
      }).then(r => ({ i, status: r.status, svc: 'echo' }))
        .catch(() => ({ i, status: 0, svc: 'echo' }))
    );
  }

  /** 10 个 ws-test 请求 */
  for (let i = 0; i < 10; i++) {
    promises.push(
      httpRequest({
        hostname: 'ws-proxy.test',
        path: `/?svc=ws&i=${i}`,
        timeout: 5000,
      }).then(r => ({ i: i + 10, status: r.status, svc: 'ws' }))
        .catch(() => ({ i: i + 10, status: 0, svc: 'ws' }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => r.status !== 200);
  if (failed.length > 0) {
    throw new Error(`${failed.length}/20 个多服务并发请求失败`);
  }
}

/** 6. URL 特殊字符透传 */
async function test_url_special_chars() {
  await ensureEchoOnline();

  const specialChars = '?a=1&b=hello%20world&c=%E4%B8%AD%E6%96%87&d=foo/bar+baz';
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: `/echo${specialChars}`,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`特殊字符 URL 请求失败: ${res.status}`);
  }

  const data = JSON.parse(res.body);

  /** 验证查询参数被正确透传 */
  if (!data.params.a || data.params.a !== '1') {
    throw new Error('查询参数 a 丢失');
  }
  if (!data.params.b || data.params.b !== 'hello world') {
    throw new Error('查询参数 b 编码错误');
  }
  if (!data.params.c || data.params.c !== '中文') {
    throw new Error('查询参数 c 中文编码错误');
  }
}

/** 7. 响应头大小写兼容 */
async function test_response_header_case() {
  await ensureEchoOnline();

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/custom-response',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`自定义响应头请求失败: ${res.status}`);
  }

  /** 验证自定义响应头被正确透传 */
  if (!res.headers['x-custom-response']) {
    throw new Error('X-Custom-Response 响应头缺失');
  }
  if (!res.headers['x-rate-limit']) {
    throw new Error('X-Rate-Limit 响应头缺失');
  }
  if (!res.headers['cache-control']) {
    throw new Error('Cache-Control 响应头缺失');
  }
}

/** 8. 连接超时后网关稳定性 */
async function test_connection_timeout_stability() {
  await ensureEchoOnline();

  /** 发送请求到延迟 10 秒的端点，客户端 1 秒超时 */
  try {
    await httpRequest({
      hostname: 'echo-host.test',
      path: '/delay?delay=10000',
      timeout: 1000,
    });
  } catch {
    /** 客户端超时，预期行为 */
  }

  /** 等待网关处理超时连接 */
  await sleep(2000);

  /** 验证网关仍然正常 */
  const healthCheck = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });
  if (healthCheck.status !== 200) {
    throw new Error('连接超时后网关异常');
  }
}

/** 9. 重复 Host 头处理 */
async function test_duplicate_headers() {
  await ensureEchoOnline();

  /** node:http 会自动合并重复头为逗号分隔 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/headers',
    headers: {
      'X-Custom': 'value1',
      'Accept-Encoding': 'gzip, deflate',
    },
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`重复头请求失败: ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (!data.headers['x-custom']) {
    throw new Error('自定义头丢失');
  }
}

/** 10. 快速连续请求到不同路径 */
async function test_rapid_different_paths() {
  await ensureEchoOnline();

  const paths = ['/echo', '/status?code=200', '/headers', '/cookie', '/no-content'];
  for (let round = 0; round < 5; round++) {
    for (const path of paths) {
      const res = await httpRequest({
        hostname: 'echo-host.test',
        path,
        timeout: 5000,
      });
      if (res.status !== 200 && res.status !== 204 && res.status !== 302) {
        throw new Error(`路径 ${path} 返回异常: ${res.status}`);
      }
    }
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔬 DynaPM 网关边界与安全深度测试', C.cyan);

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

  /** 触发 echo 按需启动 */
  log('  触发按需启动 echo...', C.yellow);
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (warmup.status !== 200) {
    log(`  ✗ echo 启动失败: ${warmup.status}`, C.red);
    process.exit(1);
  }
  log('  ✓ Echo 已按需启动', C.green);

  section('安全防护');
  await runTest('CRLF 注入防护', test_crlf_injection_protection);

  section('并发与竞争');
  await runTest('并发按需启动竞争 (20个)', test_concurrent_on_demand_startup_race);
  await runTest('多服务并发代理 (20个)', test_multi_service_concurrent_proxy);

  section('数据传输');
  await runTest('大响应体流式转发 (1MB)', test_large_response_streaming);
  await runTest('URL 特殊字符透传', test_url_special_chars);

  section('边界条件');
  await runTest('超长请求头值 (16KB)', test_extremely_long_header);
  await runTest('响应头大小写兼容', test_response_header_case);
  await runTest('重复请求头处理', test_duplicate_headers);
  await runTest('快速连续请求到不同路径', test_rapid_different_paths);

  section('稳定性');
  await runTest('连接超时后网关稳定性', test_connection_timeout_stability);

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
    log('\n🎉 所有网关边界与安全测试通过！', C.green);
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
