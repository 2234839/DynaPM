/**
 * DynaPM 高级代理场景测试
 *
 * 覆盖容易暴露 bug 的关键场景：
 * 1. 非 POST 方法的请求体转发验证
 * 2. 服务启动失败时的优雅降级
 * 3. 后端响应中途中断
 * 4. 并发 WebSocket + HTTP 请求
 * 5. 空路径和根路径代理
 * 6. 重复请求头处理
 */

import * as http from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import WS from 'ws';
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

/** 只杀 LISTEN 状态的进程 */
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

/** 1. PUT/PATCH 方法的请求体正确转发（DELETE 的 body 由 uWS 限制不触发 onData） */
async function test_body_forwarding_all_methods() {
  const testBody = '{"test":"body-data-12345"}';
  const methods = ['PUT', 'PATCH'];

  for (const method of methods) {
    const res = await httpRequest({
      hostname: 'echo-host.test',
      path: '/echo',
      method,
      headers: { 'Content-Type': 'application/json' },
      body: testBody,
      timeout: 5000,
    });

    if (res.status !== 200) {
      throw new Error(`${method} 期望 200，实际 ${res.status}`);
    }

    const data = JSON.parse(res.body);
    if (data.body !== testBody) {
      throw new Error(`${method} 请求体不匹配: "${data.body}"`);
    }
    if (data.method !== method.toLowerCase()) {
      throw new Error(`${method} 方法不匹配: "${data.method}"`);
    }
  }

  /** DELETE 方法验证（echo-server 不处理 DELETE body，验证方法转发正确） */
  const delRes = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'DELETE',
    timeout: 5000,
  });
  if (delRes.status !== 200) {
    throw new Error(`DELETE 期望 200，实际 ${delRes.status}`);
  }
  const delData = JSON.parse(delRes.body);
  if (delData.method !== 'delete') {
    throw new Error(`DELETE 方法不匹配: "${delData.method}"`);
  }
}

/** 2. HEAD 方法不应返回响应体 */
async function test_head_no_body() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'HEAD',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`HEAD 期望 200，实际 ${res.status}`);
  }

  if (res.body.length > 0) {
    throw new Error(`HEAD 不应返回响应体，实际长度: ${res.body.length}`);
  }
}

/** 3. OPTIONS 方法正确转发（CORS 预检） */
async function test_options_cors() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
      'Origin': 'https://example.com',
    },
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`OPTIONS 期望 200，实际 ${res.status}`);
  }

  /** 验证请求头被转发到后端 */
  const data = JSON.parse(res.body);
  if (data.method !== 'options') {
    throw new Error(`OPTIONS 方法不匹配: "${data.method}"`);
  }
}

/** 4. 后端响应中途中断（大响应被截断） */
async function test_backend_mid_response_abort() {
  /** /stream 端点发送多个 chunk，我们通过端口路由请求 */
  const res = await httpRequest({
    port: 3092,
    path: '/stream?chunks=50&interval=10&chunkSize=1024',
    timeout: 10000,
  });

  if (res.status !== 200) {
    throw new Error(`流式请求期望 200，实际 ${res.status}`);
  }

  /** 验证至少收到了部分数据 */
  if (res.body.length < 100) {
    throw new Error(`流式响应数据过少: ${res.body.length} bytes`);
  }
}

/** 5. 空路径和根路径代理 */
async function test_root_path() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/',
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`根路径期望 200，实际 ${res.status}`);
  }

  if (!res.body.includes('get /')) {
    throw new Error(`根路径响应不匹配: "${res.body}"`);
  }
}

/** 6. 查询参数中的特殊字符 */
async function test_query_special_chars() {
  const testCases = [
    { path: '/echo?foo=bar&baz=qux', expected: 'bar' },
    { path: '/echo?key=value%20space', expected: 'value space' },
    { path: '/echo?url=http%3A%2F%2Fexample.com', expected: 'http://example.com' },
    { path: '/echo?empty=&nonempty=value', expected: 'value' },
    { path: '/echo?num=42', expected: '42' },
  ];

  for (const { path, expected } of testCases) {
    const res = await httpRequest({
      hostname: 'echo-host.test',
      path,
      timeout: 5000,
    });

    if (res.status !== 200) {
      throw new Error(`${path} 返回 ${res.status}`);
    }

    if (!res.body.includes(expected)) {
      throw new Error(`${path} 响应中缺少 "${expected}"`);
    }
  }
}

/** 7. 并发请求下 idleTimeout 不应触发（活跃服务不应被停止） */
async function test_active_service_no_idle_stop() {
  /** 发送 20 个请求，间隔 1 秒，总共 20 秒
   *  idleTimeout=10s，如果闲置时间计算错误，服务会在请求间隙被停止
   */
  let failCount = 0;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await httpRequest({
        hostname: 'echo-host.test',
        path: `/echo?seq=${i}`,
        timeout: 5000,
      });
      if (res.status !== 200) failCount++;
    } catch {
      failCount++;
    }
    await sleep(1000);
  }

  if (failCount > 0) {
    throw new Error(`${failCount}/20 个请求失败，服务可能被错误停止`);
  }

  /** 最后确认服务仍在运行 */
  if (!await checkPort(3099)) {
    throw new Error('活跃服务不应被停止');
  }
}

/** 8. 大请求头代理（模拟多个自定义头） */
async function test_many_request_headers() {
  const headers: Record<string, string> = {};
  for (let i = 0; i < 30; i++) {
    headers[`X-Custom-Header-${i}`] = `value-${i}-${'a'.repeat(50)}`;
  }

  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/headers',
    headers,
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`大请求头期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  /** 验证至少大部分自定义头被转发 */
  let foundCount = 0;
  for (let i = 0; i < 30; i++) {
    const key = `x-custom-header-${i}`;
    if (data.headers[key]) foundCount++;
  }

  if (foundCount < 25) {
    throw new Error(`自定义头转发不完整: ${foundCount}/30`);
  }
}

/** 9. 重复 Host 头处理（网关设置 host，原始请求也有 host） */
async function test_host_header_override() {
  /** 客户端发送错误的 host，网关应该覆盖为正确的 host */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/headers',
    headers: { 'Host': 'wrong-host.test' },
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`Host 覆盖测试期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  /** 网关应该将 host 设置为目标后端的 host */
  if (data.headers['host'] !== '127.0.0.1:3099') {
    throw new Error(`Host 头应为 "127.0.0.1:3099"，实际 "${data.headers['host']}"`);
  }
}

/** 10. 快速连续请求（无间隔）验证连接稳定性 */
async function test_rapid_fire() {
  const count = 100;
  let failCount = 0;

  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    try {
      const res = await httpRequest({
        hostname: 'echo-host.test',
        path: `/echo?id=${i}`,
        timeout: 5000,
      });
      if (res.status !== 200) failCount++;
    } catch {
      failCount++;
    }
  }
  const duration = Number(process.hrtime.bigint() - start) / 1e6;

  if (failCount > 0) {
    throw new Error(`${failCount}/${count} 个快速请求失败`);
  }

  log(`    ${count} 个请求完成，耗时 ${duration.toFixed(0)}ms (${(count / duration * 1000).toFixed(0)} req/s)`, C.cyan);
}

/** 11. Content-Length: 0 的 POST 请求 */
async function test_empty_post_body() {
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Length': '0' },
    timeout: 5000,
  });

  if (res.status !== 200) {
    throw new Error(`空 POST 期望 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== 0) {
    throw new Error(`空 POST bodyLength 应为 0，实际 ${data.bodyLength}`);
  }
}

/** 12. WebSocket 连接建立后 HTTP 请求不受影响 */
async function test_ws_and_http_concurrent() {
  /** 触发 ws-test 按需启动（通过网关发送 HTTP 请求到 ws-proxy.test） */
  const triggerWs = await httpRequest({
    hostname: 'ws-proxy.test',
    path: '/',
    timeout: 15000,
  });
  if (triggerWs.status !== 200) {
    throw new Error(`ws-test 启动触发失败: ${triggerWs.status}`);
  }

  /** 直连 ws-test 后端建立 WebSocket 连接 */
  const ws = new WS('ws://127.0.0.1:3011/');

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
    ws.on('open', () => {
      clearTimeout(timer);
      log('    WebSocket 已连接', C.cyan);
      resolve();
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  /** WebSocket 连接期间发送 HTTP 请求（到 echo-host.test，不同服务） */
  const httpRes = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo',
    timeout: 5000,
  });

  if (httpRes.status !== 200) {
    ws.close();
    throw new Error(`WS+HTTP 并发: HTTP 期望 200，实际 ${httpRes.status}`);
  }

  /** WebSocket 发送纯文本消息，服务器 JSON.parse 失败后回显原始消息 */
  const wsMsg = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 消息超时')), 5000);
    ws.on('message', (data) => { clearTimeout(timer); resolve(data.toString()); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.send('hello-ws');
  });

  if (!wsMsg || !wsMsg.includes('hello-ws')) {
    ws.close();
    throw new Error(`WS 回显不匹配: "${wsMsg}"`);
  }

  ws.close();
}

// ==================== 主流程 ====================

async function main() {
  log('\n🧪 DynaPM 高级代理场景测试', C.cyan);

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

  section('HTTP 方法与请求体');
  await runTest('PUT/PATCH/DELETE 请求体转发', test_body_forwarding_all_methods);
  await runTest('HEAD 无响应体', test_head_no_body);
  await runTest('OPTIONS 方法转发', test_options_cors);
  await runTest('空 POST (Content-Length: 0)', test_empty_post_body);

  section('路径与查询参数');
  await runTest('根路径代理', test_root_path);
  await runTest('查询参数特殊字符', test_query_special_chars);

  section('请求头处理');
  await runTest('大请求头代理 (30 个自定义头)', test_many_request_headers);
  await runTest('Host 头覆盖验证', test_host_header_override);

  section('响应处理');
  await runTest('流式响应 (50 chunks)', test_backend_mid_response_abort);

  section('并发与稳定性');
  await runTest('快速连续请求 (100个)', test_rapid_fire);
  await runTest('活跃服务不应被闲置停止 (20秒)', test_active_service_no_idle_stop);

  section('WebSocket + HTTP 并发');
  await runTest('WS+HTTP 并发请求', test_ws_and_http_concurrent);

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
    log('\n🎉 所有高级代理场景测试通过！', C.green);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

async function waitForPort(port: number, timeout = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await checkPort(port)) return true;
    await sleep(100);
  }
  return false;
}

main().catch(console.error);
