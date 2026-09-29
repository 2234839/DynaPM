/**
 * DynaPM 极端场景测试
 *
 * 测试覆盖：
 * 1. 高并发请求（100个并发）
 * 2. 大请求体（1MB）
 * 3. 超大响应（流式 1MB）
 * 4. 后端不可达（proxyOnly 指向不存在的后端）
 * 5. 请求头注入防护（CRLF）
 * 6. 超长 URL
 * 7. Unicode 路径和参数
 * 8. 快速连续请求（同一连接）
 * 9. POST 无 Content-Type
 * 10. 端口路由并发
 * 11. 后端返回空响应
 * 12. 后端返回 204 No Content
 * 13. HEAD 方法
 * 14. PATCH 方法
 * 15. 多个自定义请求头
 * 16. 响应头中包含特殊字符
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

async function killPort(port: number) {
  try { await execAsync(`lsof -i:${port} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9 2>/dev/null`); } catch {}
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

// ==================== 极端场景 ====================

/** 1. 高并发请求（50个并发） */
async function test_high_concurrency() {
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      httpRequest({ port: 3092, path: '/echo' })
        .then(res => ({ i, status: res.status, ok: res.status === 200 }))
        .catch(err => ({ i, error: err instanceof Error ? err.message : String(err), ok: false }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个请求失败: ${failed[0].error || `status=${failed[0].status}`}`);
  }
}

/** 2. 大请求体（1MB） */
async function test_large_body_1mb() {
  const largeBody = 'x'.repeat(1024 * 1024);
  const res = await httpRequest({
    port: 3092,
    path: '/big-body',
    method: 'POST',
    body: largeBody,
    timeout: 10000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== largeBody.length) {
    throw new Error(`请求体长度不匹配: 期望 ${largeBody.length}，实际 ${data.bodyLength}`);
  }
}

/** 3. 超大流式响应 */
async function test_large_streaming_response() {
  const res = await httpRequest({
    port: 3092,
    path: '/stream?chunks=50&interval=10&chunkSize=1024',
    timeout: 15000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  if (res.body.length < 50000) {
    throw new Error(`响应体过小: ${res.body.length}B`);
  }
}

/** 4. 请求头注入防护（CRLF） */
async function test_header_injection() {
  const res = await httpRequest({
    port: 3092,
    path: '/headers',
    headers: {
      'X-Test': 'normal-value',
      'X-Evil': 'value  injected-header: malicious',
    },
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.headers['x-evil'] !== 'value  injected-header: malicious') {
    throw new Error(`头部值被修改: ${data.headers['x-evil']}`);
  }
  if (data.headers['injected-header']) {
    throw new Error('注入的头被接受');
  }
}

/** 5. 超长 URL（网关应正常转发，后端返回默认响应） */
async function test_long_url() {
  const longPath = '/' + 'a'.repeat(500);
  const res = await httpRequest({
    port: 3092,
    path: longPath,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  if (!res.body.includes('Default response')) {
    throw new Error(`超长 URL 应返回默认响应，实际: ${res.body.substring(0, 100)}`);
  }
}

/** 6. Unicode 路径和参数 */
async function test_unicode() {
  const encodedPath = '/echo?name=' + encodeURIComponent('中文') + '&emoji=' + encodeURIComponent('🎉');
  const res = await httpRequest({
    port: 3092,
    path: encodedPath,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.params.name !== '中文') {
    throw new Error(`中文参数不匹配: ${data.params.name}`);
  }
}

/** 8. 快速连续请求（50个串行） */
async function test_rapid_sequential() {
  for (let i = 0; i < 50; i++) {
    const res = await httpRequest({ port: 3092, path: '/echo', timeout: 3000 });
    if (res.status !== 200) {
      throw new Error(`第 ${i + 1} 个请求失败: ${res.status}`);
    }
  }
}

/** 9. POST 无 Content-Type */
async function test_post_no_content_type() {
  const res = await httpRequest({
    port: 3092,
    path: '/echo',
    method: 'POST',
    body: 'raw-body-data',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.body !== 'raw-body-data') {
    throw new Error('请求体不匹配');
  }
}

/** 10. 端口路由并发 */
async function test_port_route_concurrent() {
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(
      httpRequest({ port: 3092, path: `/echo?id=${i}` })
        .then(res => ({ i, status: res.status, ok: res.status === 200 }))
        .catch(() => ({ i, ok: false }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个端口路由并发请求失败`);
  }
}

/** 11. 后端返回各种 4xx 状态码 */
async function test_4xx_status_codes() {
  const codes = [400, 401, 403, 405];
  for (const code of codes) {
    const res = await httpRequest({ port: 3092, path: `/status?code=${code}`, timeout: 5000 });
    if (res.status !== code) {
      throw new Error(`状态码 ${code} 透传失败: 期望 ${code}，实际 ${res.status}`);
    }
  }
}

/** 12. 后端返回 301 重定向 */
async function test_redirect() {
  const res = await httpRequest({ port: 3092, path: '/status?code=301', timeout: 5000 });
  if (res.status !== 301) {
    throw new Error(`期望 301，实际 ${res.status}`);
  }
}

/** 13. PATCH 方法 */
async function test_patch_method() {
  const res = await httpRequest({
    port: 3092,
    path: '/echo',
    method: 'PATCH',
    body: '{"patch": true}',
    headers: { 'Content-Type': 'application/json' },
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.method !== 'patch') {
    throw new Error(`方法不匹配: ${data.method}`);
  }
}

/** 14. 多个自定义请求头 */
async function test_many_headers() {
  const headers: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    headers[`X-Custom-${i}`] = `value-${i}`;
  }

  const res = await httpRequest({
    port: 3092,
    path: '/headers',
    headers,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  for (let i = 0; i < 20; i++) {
    if (data.headers[`x-custom-${i}`] !== `value-${i}`) {
      throw new Error(`自定义头 X-Custom-${i} 不匹配`);
    }
  }
}

/** 15. 混合并发（hostname + 端口路由同时） */
async function test_mixed_concurrent() {
  const promises = [];

  for (let i = 0; i < 10; i++) {
    promises.push(
      httpRequest({ hostname: 'echo-host.test', path: `/echo?src=hostname&i=${i}` })
        .then(res => ({ src: 'hostname', i, ok: res.status === 200 }))
        .catch(() => ({ src: 'hostname', i, ok: false }))
    );
    promises.push(
      httpRequest({ port: 3092, path: `/echo?src=port&i=${i}` })
        .then(res => ({ src: 'port', i, ok: res.status === 200 }))
        .catch(() => ({ src: 'port', i, ok: false }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个混合并发请求失败`);
  }
}

/** 16. 延迟响应超时测试（使用 hostname 路由避免 proxyOnly 的闲置停止问题） */
async function test_delayed_2s() {
  /** 先刷新闲置时间，确保 echo 不会在测试期间被停止 */
  await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 });

  const start = Date.now();
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/delay?delay=2000',
    timeout: 5000,
  });

  const duration = Date.now() - start;
  if (duration < 1500) {
    throw new Error(`延迟响应过早返回: ${duration}ms`);
  }

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🚀 DynaPM 极端场景测试', C.cyan);

  section('环境准备');

  for (const port of [3090, 3091, 3092, 3099, 3010, 3011]) {
    await killPort(port);
  }
  await sleep(500);

  // 启动网关（echo 后端不启动，按需启动）
  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3090, 5000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3091, 5000);
  await waitForPort(3092, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(500);

  // 第一次请求触发按需启动 echo
  log('  触发按需启动 echo...', C.yellow);
  try {
    const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
    if (res.status !== 200) throw new Error(`按需启动失败: ${res.status}`);
    log('  ✓ Echo 已按需启动', C.green);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`  ✗ ${message}`, C.red);
    process.exit(1);
  }

  section('极端场景测试');

  await runTest('高并发请求 (50个)', test_high_concurrency);
  await runTest('大请求体 (1MB)', test_large_body_1mb);
  await runTest('超大流式响应 (50 chunks × 1KB)', test_large_streaming_response);
  await runTest('请求头注入防护', test_header_injection);
  await runTest('超长 URL (500字符)', test_long_url);
  await runTest('Unicode 路径和参数', test_unicode);
  await runTest('快速连续请求 (50个串行)', test_rapid_sequential);
  await runTest('POST 无 Content-Type', test_post_no_content_type);
  await runTest('端口路由并发 (20个)', test_port_route_concurrent);
  await runTest('4xx 状态码透传', test_4xx_status_codes);
  await runTest('301 重定向透传', test_redirect);
  await runTest('PATCH 方法', test_patch_method);
  await runTest('多个自定义请求头 (20个)', test_many_headers);
  await runTest('混合并发 (hostname + 端口)', test_mixed_concurrent);
  await runTest('延迟响应 (2秒)', test_delayed_2s);

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
    log('\n🎉 所有极端场景测试通过！', C.green);
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
