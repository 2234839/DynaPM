/**
 * DynaPM 全面代理功能测试
 *
 * 测试场景覆盖：
 * 1. Hostname 路由 - 基本代理
 * 2. 端口路由 - 纯代理模式
 * 3. 按需启动 - 服务离线时自动启动
 * 4. 热代理 - 服务在线时直接转发
 * 5. 请求头转发 - 验证 Host 和自定义头正确转发
 * 6. 请求体转发 - GET/POST/PUT/DELETE 方法与请求体
 * 7. 响应头转发 - 验证后端响应头正确返回
 * 8. 自定义状态码 - 404/500/503 等状态码透传
 * 9. 流式响应 - 分块传输编码
 * 10. 延迟响应 - 验证超时处理
 * 11. 404 路由 - 不存在的 hostname
 * 12. 管理API - 服务列表和状态查询
 * 13. SSE 代理 - Server-Sent Events 流式代理
 * 14. WebSocket 代理 - 双向通信代理
 * 15. 大请求体 - 大量数据流式转发
 * 16. 闲置超时 - 自动停止闲置服务
 * 17. 多路由服务 - 同时有 hostname 和 port 路由
 * 18. 查询参数转发 - URL 查询参数透传
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import * as http from 'node:http';
import { WebSocket } from 'ws';

const execAsync = promisify(exec);

// ==================== 常量 ====================

/** 颜色输出 */
const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/** 测试配置 */
const CFG = {
  gatewayHost: '127.0.0.1',
  gatewayPort: 3090,
  adminPort: 3091,
  proxyPort: 3092,
  echoHost: 'echo-host.test',
  wsHost: 'ws-proxy.test',
  sseHost: 'sse-proxy.test',
  echoServerPort: 3099,
  sseServerPort: 3010,
  wsServerPort: 3011,
};

/** 测试结果 */
interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

const results: TestResult[] = [];

// ==================== 工具函数 ====================

function log(msg: string, color = C.reset) {
  console.log(`${color}${msg}${C.reset}`);
}

function section(msg: string) {
  log(`\n${'='.repeat(60)}`, C.blue);
  log(msg, C.blue);
  log('='.repeat(60), C.blue);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** HTTP 请求封装 */
async function httpRequest(options: {
  hostname?: string;
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const {
    hostname,
    port = CFG.gatewayPort,
    path = '/',
    method = 'GET',
    headers = {},
    body,
    timeout = 10000,
  } = options;

  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (hostname) {
      reqHeaders['Host'] = hostname;
    }

    const req = http.request({
      hostname: CFG.gatewayHost,
      port,
      path,
      method,
      headers: reqHeaders,
      timeout,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString();
        const resHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) {
            resHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }
        }
        resolve({ status: res.statusCode || 0, headers: resHeaders, body: bodyStr });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/** 检查端口是否可用 */
function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 200 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** 杀死占用端口的进程（仅 LISTEN 状态） */
async function killPort(port: number) {
  try {
    await execAsync(`lsof -i:${port} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9 2>/dev/null`);
  } catch {
    // 进程可能不存在
  }
}

/** 等待端口可用 */
async function waitForPort(port: number, timeout = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await checkPort(port)) return true;
    await sleep(100);
  }
  return false;
}

/** 运行单个测试 */
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

/** 1. Hostname 路由基本代理 */
async function test_hostname_basic_proxy() {
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.url !== '/echo') {
    throw new Error(`路径不匹配: ${data.url}`);
  }
}

/** 2. 端口路由纯代理 */
async function test_port_proxy() {
  const res = await httpRequest({
    port: CFG.proxyPort,
    path: '/echo',
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.url !== '/echo') {
    throw new Error(`路径不匹配: ${data.url}`);
  }
}

/** 3. 按需启动 */
async function test_on_demand_start() {
  // 确认后端服务离线
  const isOffline = !await checkPort(CFG.echoServerPort);
  if (!isOffline) {
    throw new Error('前置条件：后端服务应该离线');
  }

  // 通过网关请求应该自动启动后端
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
    timeout: 15000,
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}，body: ${res.body.substring(0, 200)}`);
  }

  // 验证后端已启动
  const isOnline = await checkPort(CFG.echoServerPort);
  if (!isOnline) {
    throw new Error('后端服务应该已启动');
  }
}

/** 4. 热代理（服务在线时直接转发） */
async function test_hot_proxy() {
  // 确保后端在线
  if (!await checkPort(CFG.echoServerPort)) {
    throw new Error('前置条件：后端服务应该在线');
  }

  const start = Date.now();
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
  });

  // 热代理应该很快（不需要启动时间）
  const duration = Date.now() - start;
  if (duration > 1000) {
    throw new Error(`热代理响应过慢: ${duration}ms`);
  }

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }
}

/** 5. 请求头转发验证 */
async function test_header_forwarding() {
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/headers',
    headers: {
      'X-Custom-Header': 'test-value',
      'X-Another': 'another-value',
    },
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.headers['x-custom-header'] !== 'test-value') {
    throw new Error('自定义头未正确转发');
  }
  if (data.headers['x-another'] !== 'another-value') {
    throw new Error('第二个自定义头未正确转发');
  }

  // 验证 Host 头被正确替换为后端地址
  if (data.headers['host'] !== '127.0.0.1:3099') {
    throw new Error(`Host 头应为后端地址，实际: ${data.headers['host']}`);
  }
}

/** 6. 请求体转发 */
async function test_body_forwarding() {
  // POST 请求体
  const postBody = JSON.stringify({ name: 'test', value: 123 });
  const postRes = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: postBody,
  });

  if (postRes.status !== 200) {
    throw new Error(`POST 期望状态码 200，实际 ${postRes.status}`);
  }

  const postData = JSON.parse(postRes.body);
  if (postData.method !== 'post') {
    throw new Error(`方法不匹配: ${postData.method}`);
  }
  if (postData.body !== postBody) {
    throw new Error('POST 请求体不匹配');
  }

  // PUT 请求体
  const putBody = 'raw-put-body-content';
  const putRes = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
    method: 'PUT',
    body: putBody,
  });

  if (putRes.status !== 200) {
    throw new Error(`PUT 期望状态码 200，实际 ${putRes.status}`);
  }

  const putData = JSON.parse(putRes.body);
  if (putData.method !== 'put') {
    throw new Error(`方法不匹配: ${putData.method}`);
  }
  if (putData.body !== putBody) {
    throw new Error('PUT 请求体不匹配');
  }
}

/** 7. 响应头转发 */
async function test_response_header_forwarding() {
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  // 验证后端设置的自定义响应头被转发
  if (res.headers['x-echo-method'] !== 'get') {
    throw new Error(`X-Echo-Method 头不匹配: ${res.headers['x-echo-method']}`);
  }
  if (res.headers['x-echo-body-length'] !== '0') {
    throw new Error(`X-Echo-Body-Length 头不匹配: ${res.headers['x-echo-body-length']}`);
  }
}

/** 8. 状态码透传 */
async function test_status_code_passthrough() {
  const statusCodes = [200, 201, 400, 404, 500, 503];

  for (const code of statusCodes) {
    const res = await httpRequest({
      hostname: CFG.echoHost,
      path: `/status?code=${code}`,
    });

    if (res.status !== code) {
      throw new Error(`状态码 ${code} 透传失败: 期望 ${code}，实际 ${res.status}`);
    }
  }
}

/** 9. 流式响应 */
async function test_streaming_response() {
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/stream?chunks=5&interval=50&chunkSize=50',
    timeout: 10000,
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  // 验证收到了所有 chunk
  const chunkCount = (res.body.match(/chunk-\d+/g) || []).length;
  if (chunkCount < 5) {
    throw new Error(`收到的 chunk 数量不足: 期望 >= 5，实际 ${chunkCount}`);
  }
}

/** 10. 延迟响应 */
async function test_delayed_response() {
  const start = process.hrtime.bigint();
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/delay?delay=500',
    timeout: 5000,
  });
  const duration = Number(process.hrtime.bigint() - start) / 1e6;

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.delayed !== true) {
    throw new Error('延迟响应标志不正确');
  }

  if (duration < 400) {
    throw new Error(`延迟响应时间过短: ${Math.round(duration)}ms`);
  }
}

/** 11. 404 路由 - 不存在的 hostname */
async function test_404_unknown_hostname() {
  const res = await httpRequest({
    hostname: 'unknown-service.test',
    path: '/test',
  });

  if (res.status !== 404) {
    throw new Error(`期望状态码 404，实际 ${res.status}`);
  }

  if (!res.body.includes('not found') && !res.body.includes('Not Found')) {
    throw new Error('404 响应内容不正确');
  }
}

/** 12. 管理API - 服务列表 */
async function test_admin_api_services() {
  const res = await httpRequest({
    port: CFG.adminPort,
    path: '/_dynapm/api/services',
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (!data.services || !Array.isArray(data.services)) {
    throw new Error('服务列表格式不正确');
  }

  // 验证至少有 echo-proxy 服务（纯代理模式应该在线）
  const echoProxy = data.services.find((s: any) => s.name === 'echo-proxy');
  if (!echoProxy) {
    throw new Error('找不到 echo-proxy 服务');
  }
  if (echoProxy.proxyOnly !== true) {
    throw new Error('echo-proxy 应该是 proxyOnly 模式');
  }
}

/** 13. 管理API - 服务详情 */
async function test_admin_api_service_detail() {
  const res = await httpRequest({
    port: CFG.adminPort,
    path: '/_dynapm/api/services/echo-proxy',
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.name !== 'echo-proxy') {
    throw new Error('服务名称不匹配');
  }
  if (data.proxyOnly !== true) {
    throw new Error('proxyOnly 标志不正确');
  }
}

/** 14. 查询参数转发 */
async function test_query_params_forwarding() {
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo?key1=value1&key2=value2&encoded=%E4%B8%AD%E6%96%87',
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.params.key1 !== 'value1') {
    throw new Error('查询参数 key1 不匹配');
  }
  if (data.params.key2 !== 'value2') {
    throw new Error('查询参数 key2 不匹配');
  }
  if (data.params.encoded !== '中文') {
    throw new Error('URL 编码的中文参数不匹配');
  }
}

/** 15. 大请求体流式转发 */
async function test_large_body_forwarding() {
  // 生成 100KB 的请求体
  const largeBody = 'x'.repeat(100 * 1024);

  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/big-body',
    method: 'POST',
    body: largeBody,
    timeout: 10000,
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== largeBody.length) {
    throw new Error(`请求体长度不匹配: 期望 ${largeBody.length}，实际 ${data.bodyLength}`);
  }
}

/** 16. 分块传输响应 */
async function test_chunked_response() {
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/chunked?count=5&size=50',
    timeout: 10000,
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  // 验证响应体长度（5 个 50 字节的 chunk）
  const expectedLength = 5 * 50;
  if (res.body.length !== expectedLength) {
    throw new Error(`分块响应长度不匹配: 期望 ${expectedLength}，实际 ${res.body.length}`);
  }
}

/** 17. OPTIONS 方法 */
async function test_options_method() {
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
    method: 'OPTIONS',
  });

  if (res.status !== 200) {
    throw new Error(`OPTIONS 期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.method !== 'options') {
    throw new Error(`方法不匹配: ${data.method}`);
  }
}

/** 18. DELETE 方法 */
async function test_delete_method() {
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
    method: 'DELETE',
  });

  if (res.status !== 200) {
    throw new Error(`DELETE 期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.method !== 'delete') {
    throw new Error(`方法不匹配: ${data.method}`);
  }
}

/** 19. 空请求体处理 */
async function test_empty_body() {
  const res = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
    method: 'POST',
  });

  if (res.status !== 200) {
    throw new Error(`期望状态码 200，实际 ${res.status}`);
  }

  const data = JSON.parse(res.body);
  if (data.bodyLength !== 0) {
    throw new Error(`空请求体长度不匹配: ${data.bodyLength}`);
  }
}

/** 20. SSE 代理 */
async function test_sse_proxy() {
  return new Promise<void>((resolve, reject) => {
    const req = http.request({
      hostname: CFG.gatewayHost,
      port: CFG.gatewayPort,
      path: '/events',
      method: 'GET',
      headers: { Host: CFG.sseHost },
      timeout: 15000,
    });

    let output = '';
    let timeoutHandle: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      req.destroy();
    };

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        cleanup();
        reject(new Error(`SSE 期望状态码 200，实际 ${res.statusCode}`));
        return;
      }

      res.on('data', (chunk) => {
        output += chunk.toString();
      });

      res.on('end', () => {
        if (!output.includes('event: connected')) {
          cleanup();
          reject(new Error('SSE 响应缺少 connected 事件'));
          return;
        }
        if (!output.includes('event: message')) {
          cleanup();
          reject(new Error('SSE 响应缺少 message 事件'));
          return;
        }
        resolve();
      });
    });

    req.on('error', (err) => {
      cleanup();
      reject(new Error(`SSE 请求错误: ${err.message}`));
    });

    req.end();

    // SSE 服务器发送 10 个事件后关闭，设置 15 秒超时
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error('SSE 测试超时'));
    }, 15000);
  });
}

/** 21. WebSocket 代理 */
async function test_websocket_proxy() {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://${CFG.gatewayHost}:${CFG.gatewayPort}/`, {
      headers: { Host: CFG.wsHost },
    });

    let connected = false;
    let receivedEcho = false;
    let timeoutHandle: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    ws.on('open', () => {
      connected = true;
      // 等待后端 WebSocket 连接建立
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'test', data: 'hello-proxy' }));
      }, 2000);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          // 连接确认
        } else if (msg.type === 'echo') {
          receivedEcho = true;
          cleanup();
          resolve();
        }
      } catch {
        // 忽略解析错误
      }
    });

    ws.on('error', (err) => {
      cleanup();
      reject(new Error(`WebSocket 错误: ${err.message}`));
    });

    ws.on('close', () => {
      cleanup();
      if (!connected) {
        reject(new Error('WebSocket 连接失败'));
      } else if (!receivedEcho) {
        reject(new Error('WebSocket 未收到 echo 响应'));
      }
    });

    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket 测试超时'));
    }, 20000);
  });
}

/** 22. 多种 Content-Type 请求体 */
async function test_content_type_body() {
  // JSON
  const jsonBody = '{"key":"value"}';
  const jsonRes = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonBody,
  });
  const jsonData = JSON.parse(jsonRes.body);
  if (jsonData.body !== jsonBody) {
    throw new Error('JSON 请求体不匹配');
  }

  // 纯文本
  const textBody = 'plain text body';
  const textRes = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: textBody,
  });
  const textData = JSON.parse(textRes.body);
  if (textData.body !== textBody) {
    throw new Error('文本请求体不匹配');
  }

  // 表单数据
  const formBody = 'field1=value1&field2=value2';
  const formRes = await httpRequest({
    hostname: CFG.echoHost,
    path: '/echo',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
  const formData = JSON.parse(formRes.body);
  if (formData.body !== formBody) {
    throw new Error('表单请求体不匹配');
  }
}

/** 23. 闲置超时 */
async function test_idle_timeout() {
  // echo 可能因前面的 WebSocket 测试闲置超时被停止，先确保在线
  if (!await checkPort(CFG.echoServerPort)) {
    log('    echo 离线，重新触发按需启动...', C.yellow);
    const res = await httpRequest({ hostname: CFG.echoHost, path: '/echo', timeout: 20000 });
    if (res.status !== 200) {
      throw new Error(`重新启动 echo 失败: ${res.status}`);
    }
  }

  // 等待闲置超时（配置为 10 秒，加上 3 秒检查间隔的余量）
  log('    等待闲置超时（15秒）...', C.yellow);
  await sleep(15000);

  // echo-host 是非 proxyOnly 模式，应该被停止
  const isOffline = !await checkPort(CFG.echoServerPort);
  if (!isOffline) {
    throw new Error('echo-host 服务应该在闲置后自动停止');
  }
}

// ==================== 主流程 ====================

async function main() {
  log('\n🚀 DynaPM 全面代理功能测试', C.cyan);
  log(`网关端口: ${CFG.gatewayPort}，管理端口: ${CFG.adminPort}，代理端口: ${CFG.proxyPort}`, C.cyan);

  // ---- 环境准备 ----
  section('环境准备');

  // 清理旧进程
  for (const port of [CFG.gatewayPort, CFG.adminPort, CFG.proxyPort, CFG.echoServerPort, CFG.sseServerPort, CFG.wsServerPort]) {
    await killPort(port);
  }
  await sleep(500);

  // 启动网关（使用 proxy-test 配置），echo 后端不启动
  log('  启动网关（echo 后端不启动）...', C.yellow);
  const DYNAPM_CONFIG = process.cwd() + '/dynapm.config.proxy-test.ts';
  exec(`DYNAPM_CONFIG=${DYNAPM_CONFIG} nohup node dist/src/index.js > /dev/null 2>&1 &`);
  if (!await waitForPort(CFG.gatewayPort, 5000)) {
    log('  ✗ 网关启动失败', C.red);
    process.exit(1);
  }
  log('  ✓ 网关已启动', C.green);

  if (!await waitForPort(CFG.adminPort, 5000)) {
    log('  ✗ 管理 API 启动失败', C.red);
    process.exit(1);
  }
  log('  ✓ 管理 API 已启动', C.green);

  if (!await waitForPort(CFG.proxyPort, 5000)) {
    log('  ✗ 代理端口启动失败', C.red);
    process.exit(1);
  }
  log('  ✓ 代理端口已启动', C.green);

  await sleep(1000);

  // ---- 运行测试 ----
  section('按需启动与闲置管理');

  // echo 后端离线，测试按需启动
  await runTest('按需启动 (服务离线时自动启动)', test_on_demand_start);
  await runTest('热代理 (服务在线时直接转发)', test_hot_proxy);

  section('代理功能测试');

  await runTest('Hostname 路由基本代理', test_hostname_basic_proxy);
  await runTest('端口路由纯代理', test_port_proxy);
  await runTest('请求头转发验证', test_header_forwarding);
  await runTest('请求体转发 (POST/PUT)', test_body_forwarding);
  await runTest('响应头转发', test_response_header_forwarding);
  await runTest('状态码透传 (200/201/400/404/500/503)', test_status_code_passthrough);
  await runTest('流式响应', test_streaming_response);
  await runTest('延迟响应 (500ms)', test_delayed_response);
  await runTest('404 未知 hostname', test_404_unknown_hostname);
  await runTest('查询参数转发', test_query_params_forwarding);
  await runTest('大请求体流式转发 (100KB)', test_large_body_forwarding);
  await runTest('分块传输响应', test_chunked_response);
  await runTest('OPTIONS 方法', test_options_method);
  await runTest('DELETE 方法', test_delete_method);
  await runTest('空请求体处理', test_empty_body);
  await runTest('多种 Content-Type 请求体', test_content_type_body);

  section('管理 API 测试');

  await runTest('管理 API - 服务列表', test_admin_api_services);
  await runTest('管理 API - 服务详情', test_admin_api_service_detail);

  section('SSE/WebSocket 代理测试');

  await runTest('SSE 流式代理', test_sse_proxy);
  await runTest('WebSocket 双向代理', test_websocket_proxy);

  section('闲置超时测试');

  await runTest('闲置超时自动停止', test_idle_timeout);

  // ---- 清理 ----
  section('清理环境');

  for (const port of [CFG.gatewayPort, CFG.adminPort, CFG.proxyPort, CFG.echoServerPort, CFG.sseServerPort, CFG.wsServerPort]) {
    await killPort(port);
  }
  log('  ✓ 所有进程已清理', C.green);

  // ---- 结果汇总 ----
  section('测试结果汇总');

  let passedCount = 0;
  let failedCount = 0;
  let totalDuration = 0;

  for (const result of results) {
    totalDuration += result.duration;
    if (result.passed) {
      passedCount++;
    } else {
      failedCount++;
    }
  }

  log(`\n总计: ${results.length} 个测试`, C.cyan);
  log(`通过: ${passedCount} 个`, C.green);
  if (failedCount > 0) {
    log(`失败: ${failedCount} 个`, C.red);
    for (const r of results) {
      if (!r.passed) {
        log(`  ✗ ${r.name}: ${r.message}`, C.red);
      }
    }
  }
  log(`耗时: ${totalDuration}ms`, C.cyan);

  if (failedCount === 0) {
    log('\n🎉 所有测试通过！', C.green);
    process.exit(0);
  } else {
    log(`\n❌ ${failedCount} 个测试失败`, C.red);
    process.exit(1);
  }
}

main().catch(err => {
  log(`测试脚本执行失败: ${err.message}`, C.red);
  console.error(err);
  process.exit(1);
});
