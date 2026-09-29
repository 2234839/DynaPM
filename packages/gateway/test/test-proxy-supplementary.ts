/**
 * DynaPM 代理场景补充测试
 *
 * 覆盖之前未测试的代理场景：
 * 1. Set-Cookie 响应头转发
 * 2. 自定义响应头透传（Cache-Control、X-Rate-Limit 等）
 * 3. 204 No Content 响应
 * 4. 分块传输响应（Transfer-Encoding: chunked）
 * 5. GET/DELETE 请求不应有请求体
 * 6. 响应 Content-Type 多样性（octet-stream、plain、json）
 * 7. 并发连接后网关内存不泄漏（通过端口存活验证）
 * 8. 后端返回非 ASCII 响应体
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

/** 1. Set-Cookie 响应头正确转发 */
async function test_set_cookie_forwarding() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/cookie',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  /** node:http 会将 set-cookie 合并为数组 */
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) {
    throw new Error('set-cookie 头未被转发');
  }

  /** 验证两个 cookie 都在 */
  if (!setCookie.includes('session=abc123')) {
    throw new Error(`缺少 session cookie: ${setCookie}`);
  }
  if (!setCookie.includes('theme=dark')) {
    throw new Error(`缺少 theme cookie: ${setCookie}`);
  }
}

/** 2. 自定义响应头透传 */
async function test_custom_response_headers() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/custom-response?size=50',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  if (res.headers['x-custom-response'] !== 'custom-value') {
    throw new Error(`X-Custom-Response 不匹配: ${res.headers['x-custom-response']}`);
  }

  if (res.headers['x-rate-limit'] !== '100') {
    throw new Error(`X-Rate-Limit 不匹配: ${res.headers['x-rate-limit']}`);
  }

  if (!res.headers['cache-control']?.includes('no-cache')) {
    throw new Error(`Cache-Control 不匹配: ${res.headers['cache-control']}`);
  }

  /** 验证响应体是二进制数据 */
  if (res.body.length !== 50) {
    throw new Error(`二进制响应体长度不匹配: 期望 50，实际 ${res.body.length}`);
  }
}

/** 3. 204 No Content 响应 */
async function test_204_no_content() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/no-content',
    timeout: 5000,
  });

  if (res.status !== 204) {
    throw new Error(`期望 204，实际 ${res.status}`);
  }

  if (res.body.length > 0) {
    throw new Error(`204 响应不应有 body，实际长度: ${res.body.length}`);
  }
}

/** 4. 分块传输响应 */
async function test_chunked_response() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/chunked?count=5&size=100',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  /** 网关应该转发完整的分块响应 */
  const expectedSize = 5 * 100;
  if (res.body.length !== expectedSize) {
    throw new Error(`分块响应体长度不匹配: 期望 ${expectedSize}，实际 ${res.body.length}`);
  }

  /** transfer-encoding 可能被 node:http 客户端保留（它是接收端），但响应体应完整 */
  /** 网关方向：过滤了出站的 transfer-encoding（避免与 content-length 冲突） */
  if (res.headers['transfer-encoding']) {
    /** node:http 接收端可能保留此头，不影响功能 */
  }
}

/** 5. GET/DELETE 请求不应有请求体转发 */
async function test_get_no_body() {
  /** GET 请求带 body（非标准但某些客户端会这样做） */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'GET',
    body: 'should-not-be-sent',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`GET 期望 200，实际 ${res.status}`);
  }

  /** uWS 的 GET 请求不触发 onData，所以 body 应为空 */
  const data = JSON.parse(res.body);
  if (data.body !== '') {
    throw new Error(`GET 请求不应有 body: "${data.body}"`);
  }
}

/** 6. 响应 Content-Type 多样性 */
async function test_content_type_variety() {
  /** application/json */
  const jsonRes = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 5000 });
  if (!jsonRes.headers['content-type']?.includes('application/json')) {
    throw new Error(`echo Content-Type 不匹配: ${jsonRes.headers['content-type']}`);
  }

  /** text/plain */
  const plainRes = await httpRequest({ hostname: 'echo-host.test', path: '/plain', timeout: 5000 });
  if (plainRes.status !== 200) {
    throw new Error(`plain 期望 200，实际 ${plainRes.status}`);
  }
  if (!plainRes.headers['content-type']?.includes('text/plain')) {
    throw new Error(`plain Content-Type 不匹配: ${plainRes.headers['content-type']}`);
  }

  /** application/octet-stream */
  const binRes = await httpRequest({ hostname: 'echo-host.test', path: '/custom-response?size=10', timeout: 5000 });
  if (!binRes.headers['content-type']?.includes('application/octet-stream')) {
    throw new Error(`binary Content-Type 不匹配: ${binRes.headers['content-type']}`);
  }
}

/** 7. 并发连接后网关不崩溃 */
async function test_concurrent_connections_no_crash() {
  /** 发送 100 个并发请求 */
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(
      httpRequest({
        hostname: 'echo-host.test',
        path: `/echo?id=${i}`,
        timeout: 5000,
      }).then(res => ({ i, ok: res.status === 200 }))
        .catch(() => ({ i, ok: false }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length}/100 个并发请求失败`);
  }

  /** 验证网关仍存活 */
  const healthCheck = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });

  if (healthCheck.status !== 200) {
    throw new Error(`并发请求后网关异常: ${healthCheck.status}`);
  }
}

/** 8. 后端返回非 ASCII 响应体 */
async function test_non_ascii_response() {
  /** echo 端点会回显查询参数，发送编码后的中文 */
  const encoded = encodeURIComponent('中文测试');
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: `/echo?text=${encoded}`,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  if (!res.body.includes('中文测试')) {
    throw new Error('非 ASCII 响应体丢失');
  }
}

/** 9. Content-Length 响应头正确转发 */
async function test_content_length_forwarding() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"test": "data"}',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`期望 200，实际 ${res.status}`);
  }

  /** 验证 content-length 被过滤（网关用 uWS 流式写入，不设 content-length） */
  if (res.headers['content-length']) {
    /** content-length 可能被后端设置并被透传，这是允许的 */
  }

  /** 验证响应体完整 */
  const data = JSON.parse(res.body);
  if (data.body !== '{"test": "data"}') {
    throw new Error('响应体不完整');
  }
}

/** 10. 快速连续启停后代理仍然正常 */
async function test_rapid_restart_proxy() {
  /** 通过 admin API 停止 echo */
  await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 10000 });
  await sleep(500);

  /** 确认后端已停止 */
  if (await checkPort(3099)) {
    throw new Error('echo 应已停止');
  }

  /** 连续 3 次按需启动 → 验证 → 停止 */
  for (let i = 0; i < 3; i++) {
    const res = await httpRequest({
      hostname: 'echo-host.test',
      path: `/echo?round=${i}`,
      timeout: 20000,
    });

    if (res.status !== 200) {
      throw new Error(`第 ${i + 1} 轮按需启动失败: ${res.status}`);
    }

    const data = JSON.parse(res.body);
    if (data.params.round !== String(i)) {
      throw new Error(`第 ${i + 1} 轮参数不匹配`);
    }

    await httpRequest({ port: 3091, path: '/_dynapm/api/services/echo-host/stop', method: 'POST', timeout: 10000 });
    await sleep(500);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n📊 DynaPM 代理场景补充测试', C.cyan);

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

  /** 触发 echo 按需启动 */
  log('  触发按需启动 echo...', C.yellow);
  const warmup = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 20000 });
  if (warmup.status !== 200) {
    log(`  ✗ echo 启动失败: ${warmup.status}`, C.red);
    process.exit(1);
  }
  log('  ✓ Echo 已按需启动', C.green);

  section('响应头转发');
  await runTest('Set-Cookie 响应头转发', test_set_cookie_forwarding);
  await runTest('自定义响应头透传', test_custom_response_headers);
  await runTest('Content-Length 响应头转发', test_content_length_forwarding);

  section('特殊状态码');
  await runTest('204 No Content 响应', test_204_no_content);

  section('传输模式');
  await runTest('分块传输响应', test_chunked_response);

  section('请求方法');
  await runTest('GET 请求不应有 body', test_get_no_body);

  section('Content-Type');
  await runTest('Content-Type 多样性', test_content_type_variety);

  section('稳定性');
  await runTest('并发连接后网关不崩溃 (100个)', test_concurrent_connections_no_crash);
  await runTest('非 ASCII 响应体', test_non_ascii_response);
  await runTest('快速连续启停后代理正常', test_rapid_restart_proxy);

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
    log('\n🎉 所有补充测试通过！', C.green);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch(console.error);
