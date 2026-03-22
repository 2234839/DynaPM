/**
 * DynaPM CRLF 安全性验证测试
 *
 * 双层安全模型验证：
 * 1. uWS HTTP 解析器层：裸 \n 被拒绝 (400)；\r\n 形成 HTTP 头边界（标准行为）
 * 2. 网关 CRLF 清理层：对 req.forEach 迭代的每个 header value 做防御性清理
 *
 * 覆盖场景：
 * 1. 正常请求通过原始 TCP 正常工作
 * 2. uWS 拒绝包含裸 \n 的请求 (400 Bad Request)
 * 3. uWS 拒绝包含裸 \r 的请求 (400 Bad Request)
 * 4. uWS 将 \r\n+合法头 解析为独立头（网关转发给后端前 CRLF 清理不影响已分割的头）
 * 5. uWS 将 \r\n+非法行 解析为无效请求 (400 Bad Request)
 * 6. CRLF 注入不产生额外响应头（响应头注入防护）
 * 7. 大量并发 CRLF 头不会崩溃网关
 * 8. CRLF 快速路径优化：正常请求不受 CRLF 清理影响
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
  await sleep(300);
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

/** 确保 echo-host 服务在线 */
async function ensureEchoOnline(): Promise<void> {
  const res = await httpRequest({ hostname: 'echo-host.test', path: '/echo', timeout: 15000 });
  if (res.status !== 200) throw new Error('echo-host 预热失败');
}

/**
 * 通过原始 TCP 发送带原始字节的 HTTP 请求
 */
function rawTcpRequestBytes(port: number, buffers: Buffer[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('error', (err: Error) => {
        /** EPIPE 表示服务端已关闭连接（如 uWS 拒绝畸形请求），这不是测试错误 */
        if (err.message.includes('EPIPE')) {
          resolve(data);
        } else {
          reject(err);
        }
      });
      socket.on('end', () => resolve(data));
      for (const buf of buffers) {
        if (!socket.destroyed) socket.write(buf);
      }
      setTimeout(() => { socket.destroy(); resolve(data); }, 5000);
    });
    socket.on('error', reject);
  });
}

/** 解析 HTTP chunked 编码的响应体 */
function decodeChunked(body: string): string {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < body.length) {
    const lineEnd = body.indexOf('\r\n', pos);
    if (lineEnd === -1) break;
    const sizeStr = body.substring(pos, lineEnd).trim();
    const size = parseInt(sizeStr, 16);
    if (isNaN(size) || size === 0) break;
    const dataStart = lineEnd + 2;
    chunks.push(body.substring(dataStart, dataStart + size));
    pos = dataStart + size + 2;
  }
  return chunks.join('');
}

/** 解析原始 HTTP 响应，返回状态行、头和体 */
function parseRawResponse(raw: string): { statusLine: string; headers: Record<string, string>; body: string } {
  const parts = raw.split('\r\n\r\n');
  const headerSection = parts[0] || '';
  const rawBody = parts.slice(1).join('\r\n\r\n');
  const lines = headerSection.split('\r\n');
  const statusLine = lines[0] || '';
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIndex = lines[i].indexOf(':');
    if (colonIndex !== -1) {
      headers[lines[i].substring(0, colonIndex).toLowerCase()] = lines[i].substring(colonIndex + 1).trim();
    }
  }
  /** 如果响应使用 chunked 传输编码，需要解码 */
  const isChunked = Object.values(headers).some(v => v.toLowerCase().includes('chunked'));
  const body = isChunked ? decodeChunked(rawBody) : rawBody;
  return { statusLine, headers, body };
}

// ==================== 测试场景 ====================

/** 1. 正常请求通过原始 TCP 正常工作 */
async function test_normal_tcp_request() {
  await ensureEchoOnline();

  const response = await rawTcpRequestBytes(3090, [
    Buffer.from('GET /echo HTTP/1.1\r\n'),
    Buffer.from('Host: echo-host.test\r\n'),
    Buffer.from('Connection: close\r\n'),
    Buffer.from('\r\n'),
  ]);

  const { statusLine, body } = parseRawResponse(response);
  if (!statusLine.includes('200')) {
    throw new Error(`期望 200，实际 ${statusLine}`);
  }
  const data = JSON.parse(body);
  if (data.method !== 'get') {
    throw new Error(`方法不匹配: ${data.method}`);
  }
}

/** 2. uWS 拒绝包含裸 \n 的请求 */
async function test_bare_lf_rejected() {
  await ensureEchoOnline();

  /** 裸 \n 违反 HTTP 规范，uWS 直接返回 400 */
  const response = await rawTcpRequestBytes(3090, [
    Buffer.from('GET /headers HTTP/1.1\r\n'),
    Buffer.from('Host: echo-host.test\r\n'),
    Buffer.from('X-Test: value\x0aInjected: evil\r\n'),
    Buffer.from('Connection: close\r\n'),
    Buffer.from('\r\n'),
  ]);

  if (!response.includes('400')) {
    throw new Error(`裸 \\n 应被 uWS 拒绝 (400)，实际响应: ${response.substring(0, 100)}`);
  }
}

/** 3. uWS 拒绝包含裸 \r 的请求 */
async function test_bare_cr_rejected() {
  await ensureEchoOnline();

  const response = await rawTcpRequestBytes(3090, [
    Buffer.from('GET /headers HTTP/1.1\r\n'),
    Buffer.from('Host: echo-host.test\r\n'),
    Buffer.from('X-Test: value\x0dInjected: evil\r\n'),
    Buffer.from('Connection: close\r\n'),
    Buffer.from('\r\n'),
  ]);

  /** 裸 \r 要么被拒绝 (400)，要么被忽略返回空/非 200 响应 */
  const is400 = response.includes('400');
  const isNot200 = !response.includes('200');
  if (!is400 && !isNot200) {
    throw new Error(`裸 \\r 应被拒绝或忽略，实际响应: ${response.substring(0, 100)}`);
  }
}

/** 4. \r\n + 合法头被 uWS 解析为独立头（标准 HTTP 行为） */
async function test_crln_with_valid_header_parsed() {
  await ensureEchoOnline();

  /**
   * uWS 将 'X-Test: value\r\nEvilHeader: injected' 解析为两个独立头：
   * - x-test: value
   * - evilheader: injected
   * 这是标准 HTTP 解析行为（\r\n 是头分隔符）
   */
  const response = await rawTcpRequestBytes(3090, [
    Buffer.from('GET /headers HTTP/1.1\r\n'),
    Buffer.from('Host: echo-host.test\r\n'),
    Buffer.from('X-Test: value\r\nEvilHeader: injected\r\n'),
    Buffer.from('Connection: close\r\n'),
    Buffer.from('\r\n'),
  ]);

  const { statusLine, body } = parseRawResponse(response);
  if (!statusLine.includes('200')) {
    throw new Error(`期望 200，实际 ${statusLine}`);
  }
  const data = JSON.parse(body);
  /** uWS 解析为独立头，后端收到 evilheader */
  if (!data.headers['evilheader']) {
    throw new Error('期望 uWS 将 \\r\\n+合法头 解析为独立头');
  }
  /** x-test 值应只包含 'value'（不含注入内容） */
  if (data.headers['x-test'] !== 'value') {
    throw new Error(`x-test 值不正确: ${JSON.stringify(data.headers['x-test'])}`);
  }
}

/** 5. \r\n + 非法行被 uWS 拒绝 */
async function test_crln_with_invalid_line_rejected() {
  await ensureEchoOnline();

  /**
   * 'X-Variant: a\r\nb\r\nc' 中 'b' 和 'c' 不是合法头（无冒号）
   * uWS 应拒绝此请求
   */
  const response = await rawTcpRequestBytes(3090, [
    Buffer.from('GET /headers HTTP/1.1\r\n'),
    Buffer.from('Host: echo-host.test\r\n'),
    Buffer.from('X-Variant: a\r\nb\r\nc\r\n'),
    Buffer.from('Connection: close\r\n'),
    Buffer.from('\r\n'),
  ]);

  if (!response.includes('400')) {
    throw new Error(`\\r\\n+非法行 应被 uWS 拒绝 (400)，实际: ${response.substring(0, 100)}`);
  }
}

/** 6. \r\n + 多个合法注入头 */
async function test_crln_multiple_injected_headers() {
  await ensureEchoOnline();

  const response = await rawTcpRequestBytes(3090, [
    Buffer.from('GET /headers HTTP/1.1\r\n'),
    Buffer.from('Host: echo-host.test\r\n'),
    Buffer.from('X-Inject: safe\r\nEvil-Header: malicious\r\nAnother-Evil: bad\r\n'),
    Buffer.from('Connection: close\r\n'),
    Buffer.from('\r\n'),
  ]);

  const { statusLine } = parseRawResponse(response);
  if (!statusLine.includes('200')) {
    throw new Error(`期望 200，实际 ${statusLine}`);
  }

  /** 检查响应头中不包含注入的头（响应头注入防护） */
  const { headers } = parseRawResponse(response);
  if (headers['evil-header']) {
    throw new Error(`注入头出现在响应头中: ${headers['evil-header']}`);
  }
  if (headers['another-evil']) {
    throw new Error(`注入头出现在响应头中: ${headers['another-evil']}`);
  }
}

/** 7. CRLF 快速路径：正常请求性能不受影响 */
async function test_crlf_fast_path_normal() {
  await ensureEchoOnline();

  /** 通过 node:http 发送正常请求（不包含 CRLF），验证快速路径正确跳过正则替换 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/headers',
    headers: { 'X-Normal': 'hello world', 'X-Number': '12345' },
    timeout: 5000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  const data = JSON.parse(res.body);
  if (data.headers['x-normal'] !== 'hello world') {
    throw new Error(`正常头值被修改: ${JSON.stringify(data.headers['x-normal'])}`);
  }
  if (data.headers['x-number'] !== '12345') {
    throw new Error(`数字头值被修改: ${JSON.stringify(data.headers['x-number'])}`);
  }
}

/** 8. CRLF 注入不产生额外响应头 */
async function test_crlf_no_extra_response_headers() {
  await ensureEchoOnline();

  const response = await rawTcpRequestBytes(3090, [
    Buffer.from('GET /headers HTTP/1.1\r\n'),
    Buffer.from('Host: echo-host.test\r\n'),
    Buffer.from('X-Inject: safe\r\nEvil-Header: malicious-value\r\nAnother-Evil: bad\r\n'),
    Buffer.from('Connection: close\r\n'),
    Buffer.from('\r\n'),
  ]);

  const { headers } = parseRawResponse(response);

  if (headers['evil-header']) {
    throw new Error(`注入头 Evil-Header 出现在响应头中: ${headers['evil-header']}`);
  }
  if (headers['another-evil']) {
    throw new Error(`注入头 Another-Evil 出现在响应头中: ${headers['another-evil']}`);
  }
}

/** 9. 大量并发 \r\n 头不崩溃网关 */
async function test_concurrent_crln_stress() {
  await ensureEchoOnline();

  const promises = Array.from({ length: 20 }, (_, i) =>
    rawTcpRequestBytes(3090, [
      Buffer.from('GET /headers HTTP/1.1\r\n'),
      Buffer.from('Host: echo-host.test\r\n'),
      Buffer.from(`X-Crlf: value-${i}\r\nEvil: ${i}\r\n`),
      Buffer.from('Connection: close\r\n'),
      Buffer.from('\r\n'),
    ]).then(response => {
      /** 无论 uWS 接受还是拒绝，都不应崩溃 */
      if (response.length === 0) {
        throw new Error(`连接 ${i}: 空响应`);
      }
    }).catch(err => {
      throw new Error(`连接 ${i}: ${err instanceof Error ? err.message : String(err)}`);
    })
  );

  const errors: string[] = [];
  for (const p of promises) {
    try { await p; } catch (err: unknown) { errors.push(err instanceof Error ? err.message : String(err)); }
  }

  if (errors.length > 0) {
    throw new Error(`${errors.length}/20 个并发请求失败: ${errors[0]}`);
  }
}

/** 10. 响应头注入防护：\r\n 不出现在网关响应头中 */
async function test_response_header_injection_prevention() {
  await ensureEchoOnline();

  /** 发送包含 \r\n 的 Host 头值，尝试注入响应头 */
  const response = await rawTcpRequestBytes(3090, [
    Buffer.from('GET /headers HTTP/1.1\r\n'),
    Buffer.from('Host: echo-host.test\r\nX-Custom: value\r\nX-Poison: evil\r\n'),
    Buffer.from('Connection: close\r\n'),
    Buffer.from('\r\n'),
  ]);

  const { headers } = parseRawResponse(response);

  /** 网关的响应头中不应包含后端返回的 x-poison */
  if (headers['x-poison']) {
    throw new Error(`x-poison 出现在网关响应头中`);
  }
}

/** 11. CRLF 清理不影响 URL 路径中的特殊字符 */
async function test_crlf_url_path_safe() {
  await ensureEchoOnline();

  /** URL 中包含特殊字符不应被 CRLF 清理影响 */
  const res = await httpRequest({
    hostname: 'echo-host.test',
    path: '/echo?foo=bar&baz=qux',
    timeout: 5000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  const data = JSON.parse(res.body);
  if (data.params.foo !== 'bar' || data.params.baz !== 'qux') {
    throw new Error(`查询参数不正确: ${JSON.stringify(data.params)}`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔒 DynaPM CRLF 安全性验证测试', C.cyan);

  section('环境准备');

  for (const port of [3090, 3091, 3092, 3099, 3010, 3011]) {
    await killPort(port);
  }
  await sleep(500);

  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3090, 10000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3091, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(500);

  section('基础功能');
  await runTest('正常原始 TCP 请求', test_normal_tcp_request);
  await runTest('CRLF 快速路径正常请求不受影响', test_crlf_fast_path_normal);
  await runTest('URL 路径特殊字符安全', test_crlf_url_path_safe);

  section('uWS HTTP 解析器安全');
  await runTest('裸 \\n 被 uWS 拒绝 (400)', test_bare_lf_rejected);
  await runTest('裸 \\r 被 uWS 拒绝或忽略', test_bare_cr_rejected);
  await runTest('\\r\\n+非法行被 uWS 拒绝 (400)', test_crln_with_invalid_line_rejected);
  await runTest('\\r\\n+合法头被 uWS 解析为独立头', test_crln_with_valid_header_parsed);
  await runTest('\\r\\n+多个注入头解析', test_crln_multiple_injected_headers);

  section('响应安全');
  await runTest('CRLF 不产生额外响应头', test_crlf_no_extra_response_headers);
  await runTest('响应头注入防护', test_response_header_injection_prevention);

  section('压力测试');
  await runTest('20 个并发 CRLF 请求不崩溃', test_concurrent_crln_stress);

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
    log('\n🎉 所有 CRLF 安全性测试通过！', C.green);
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
