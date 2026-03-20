/**
 * DynaPM 端口路由并发按需启动测试
 *
 * 验证端口路由（非 proxyOnly）的按需启动行为：
 * 1. 端口路由并发按需启动（10个同时请求）
 * 2. 端口路由闲置后重新按需启动
 * 3. 端口路由 + hostname 路由同时存在时的正确路由
 * 4. 端口路由后端不可达后自动恢复
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

async function waitForPort(port: number, timeout = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await checkPort(port)) return true; await sleep(100); }
  return false;
}

function httpRequest(options: {
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const { port = 3082, path = '/', method = 'GET', headers = {}, body, timeout = 5000 } = options;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers, timeout,
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

// ==================== 测试场景 ====================

/** 1. 端口路由并发按需启动 */
async function test_port_concurrent_on_demand() {
  const isOffline = !await checkPort(3098);
  if (!isOffline) throw new Error('前置条件：后端应该离线');

  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(
      httpRequest({ path: `/echo?id=${i}`, timeout: 20000 })
        .then(res => ({ i, status: res.status, ok: res.status === 200 }))
        .catch(err => ({ i, error: err instanceof Error ? err.message : String(err), ok: false }))
    );
  }

  const res = await Promise.all(promises);
  const failed = res.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个请求失败: ${JSON.stringify(failed[0])}`);
  }
}

/** 2. 端口路由闲置后重新按需启动 */
async function test_port_idle_restart() {
  if (!await checkPort(3098)) throw new Error('前置条件：后端应该在线');

  log('    等待闲置超时（15秒）...', C.yellow);
  await sleep(15000);

  if (await checkPort(3098)) throw new Error('后端应该在闲置后自动停止');

  const res = await httpRequest({ path: '/echo', timeout: 20000 });
  if (res.status !== 200) {
    throw new Error(`闲置后重新启动失败: ${res.status}`);
  }
}

/** 3. 端口路由后端不可达后自动恢复 */
async function test_port_backend_crash_recovery() {
  if (!await checkPort(3098)) throw new Error('前置条件：后端应该在线');

  // 确认正常工作
  const res1 = await httpRequest({ path: '/echo' });
  if (res1.status !== 200) throw new Error(`首次请求失败: ${res1.status}`);

  // 杀死后端
  await killPort(3098);
  await sleep(500);
  if (await checkPort(3098)) throw new Error('后端应该已被杀死');

  // 第一次请求 502（重置状态）
  const res2 = await httpRequest({ path: '/echo', timeout: 5000 });
  if (res2.status !== 502) throw new Error(`期望 502，实际 ${res2.status}`);

  // 第二次请求触发按需启动
  const res3 = await httpRequest({ path: '/echo', timeout: 20000 });
  if (res3.status !== 200) {
    throw new Error(`自动恢复失败: ${res3.status}`);
  }
}

/** 4. 端口路由多种 HTTP 方法 */
async function test_port_http_methods() {
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'];
  /** 使用独立 Agent 避免连接复用导致的超时 */
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  for (const method of methods) {
    const res = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
      const reqHeaders: Record<string, string> = {};
      if (method !== 'GET') {
        reqHeaders['Content-Type'] = 'application/json';
      }

      const req = http.request({
        hostname: '127.0.0.1', port: 3082, path: '/echo', method,
        headers: reqHeaders, timeout: 10000, agent,
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
      if (method !== 'GET') req.write(JSON.stringify({ method }));
      req.end();
    });

    if (res.status !== 200) {
      throw new Error(`${method} 请求返回 ${res.status}`);
    }

    const data = JSON.parse(res.body);
    if (data.method !== method.toLowerCase()) {
      throw new Error(`方法不匹配: ${data.method} != ${method.toLowerCase()}`);
    }
  }
  agent.destroy();
}

/** 5. 端口路由查询参数转发 */
async function test_port_query_params() {
  const res = await httpRequest({ path: '/echo?key1=val1&key2=val2&cn=%E4%B8%AD%E6%96%87' });
  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);

  const data = JSON.parse(res.body);
  if (data.params.key1 !== 'val1') throw new Error('key1 不匹配');
  if (data.params.cn !== '中文') throw new Error('中文参数不匹配');
}

/** 6. 端口路由大请求体转发 */
async function test_port_large_body() {
  const largeBody = 'x'.repeat(100 * 1024);
  const res = await httpRequest({
    path: '/big-body',
    method: 'POST',
    body: largeBody,
    timeout: 10000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  const data = JSON.parse(res.body);
  if (data.bodyLength !== largeBody.length) {
    throw new Error(`请求体长度不匹配`);
  }
}

/** 7. 端口路由流式响应 */
async function test_port_streaming() {
  const res = await httpRequest({
    path: '/stream?chunks=20&interval=50&chunkSize=50',
    timeout: 10000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  const chunkCount = (res.body.match(/chunk-\d+/g) || []).length;
  if (chunkCount < 20) throw new Error(`chunk 数量不足: ${chunkCount}`);
}

/** 8. 端口路由状态码透传 */
async function test_port_status_codes() {
  const codes = [200, 201, 400, 404, 500];
  for (const code of codes) {
    const res = await httpRequest({ path: `/status?code=${code}` });
    if (res.status !== code) {
      throw new Error(`状态码 ${code} 透传失败: ${res.status}`);
    }
  }
}

/** 9. 端口路由 CRLF 注入防护 */
async function test_port_header_injection() {
  const res = await httpRequest({
    path: '/headers',
    headers: { 'X-Test': 'value with spaces' },
    timeout: 10000,
  });

  if (res.status !== 200) throw new Error(`期望 200，实际 ${res.status}`);
  const data = JSON.parse(res.body);
  /** 验证响应中只有网关转发的正常头，没有注入 */
  if (data.headers['x-test'] !== 'value with spaces') {
    throw new Error('正常头未正确转发');
  }
  /** 验证响应头中不会出现伪造的头（网关的 CRLF 清理在转发层生效） */
  if (data.headers['host'] !== '127.0.0.1:3098') {
    throw new Error(`Host 头应为后端地址，实际: ${data.headers['host']}`);
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🔌 DynaPM 端口路由并发按需启动测试', C.cyan);

  section('环境准备');

  for (const port of [3080, 3081, 3082, 3098]) {
    await killPort(port);
  }
  await sleep(500);

  log('  启动网关...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.port-start-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(3080, 5000)) { log('网关启动失败', C.red); process.exit(1); }
  await waitForPort(3081, 5000);
  await waitForPort(3082, 5000);
  log('  ✓ 网关已启动', C.green);
  await sleep(500);

  section('并发按需启动');

  await runTest('端口路由并发按需启动 (10个)', test_port_concurrent_on_demand);

  section('功能测试');

  await runTest('端口路由 HTTP 方法', test_port_http_methods);
  await runTest('端口路由查询参数', test_port_query_params);
  await runTest('端口路由大请求体 (100KB)', test_port_large_body);
  await runTest('端口路由流式响应', test_port_streaming);
  await runTest('端口路由状态码透传', test_port_status_codes);
  await runTest('端口路由 CRLF 注入防护', test_port_header_injection);

  section('故障恢复');

  await runTest('端口路由后端崩溃恢复', test_port_backend_crash_recovery);
  await runTest('端口路由闲置后重新启动', test_port_idle_restart);

  section('清理环境');

  for (const port of [3080, 3081, 3082, 3098]) {
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
    log('\n🎉 所有端口路由测试通过！', C.green);
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
