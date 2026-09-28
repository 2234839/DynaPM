/**
 * passthrough 直通模式 WS 测试（复用 test-ws-siyuan.ts 的场景思路，独立端口段 3160-3162）
 *
 * 场景（passthrough 开启，WS upgrade 走 TCP 直通、HTTP 走现有流式代理）：
 * 1. HTTP 混合请求仍正常（鉴权头透传）
 * 2. WS 升级 Authorization 头透传（原始头字节原样转发）
 * 3. WS Origin 头透传
 * 4. WS 子协议 sec-websocket-protocol 透传
 * 5. echo 小消息
 * 6. 大消息 2MB 双向转发
 * 7. 协议层 ping 透传
 * 8. 后端 4001 关闭码透传
 * 9. 活跃 WS 连接期间服务不被闲置回收（activeConnections 计数正确）
 *
 * 运行：npx tsx test/test-passthrough.ts
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { createConnection } from 'node:net';
import { WebSocket as WS, WebSocketServer } from 'ws';

const execAsync = promisify(exec);

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
function log(msg: string, color = C.reset) { console.log(`${color}${msg}${C.reset}`); }
function section(msg: string) { log(`\n${'='.repeat(60)}`, C.cyan); log(msg, C.cyan); log('='.repeat(60), C.cyan); }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

const MOCK_BACKEND_PORT = 3160;
const PROXY_PORT = 3161;
const ADMIN_PORT = 3162;

let lastUpgradeHeaders: Record<string, string> = {};
let backendOpenCount = 0;

/** 模拟后端：HTTP + WS 同端口（与思源形态一致） */
function startMockBackend(): Promise<void> {
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/check-auth') {
      const auth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: auth === 'token-pt-test' ? 0 : -1, auth: auth || null }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('passthrough-mock');
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    backendOpenCount++;
    lastUpgradeHeaders = req.headers as Record<string, string>;

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        ws.send(data, { binary: true });
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === 'echo') {
        ws.send(JSON.stringify({ type: 'echo', data: msg.data }));
      } else if (msg.type === 'big') {
        ws.send(JSON.stringify({ type: 'big', data: msg.data }));
      } else if (msg.type === 'whoami') {
        ws.send(JSON.stringify({
          type: 'whoami',
          auth: lastUpgradeHeaders['authorization'] ?? null,
          origin: lastUpgradeHeaders['origin'] ?? null,
          protocol: (req.headers['sec-websocket-protocol'] ?? null),
        }));
      } else if (msg.type === 'ping-frame') {
        ws.ping('hb');
      } else if (msg.type === 'close-4001') {
        ws.close(4001, 'passthrough-custom-close');
      }
    });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    lastUpgradeHeaders = req.headers as Record<string, string>;
    wss.handleUpgrade(req, socket as import('node:net').Socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(MOCK_BACKEND_PORT, () => {
      log(`模拟后端已启动: http://127.0.0.1:${MOCK_BACKEND_PORT}`, C.yellow);
      resolve();
    });
  });
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 200 }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function killPort(port: number) {
  try {
    await execAsync(`lsof -ti:${port} -sTCP:LISTEN | xargs -r kill -9 2>/dev/null`);
  } catch {}
}

async function waitForPort(port: number, timeout = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await checkPort(port)) return true; await sleep(100); }
  return false;
}

function httpRequest(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PROXY_PORT, path, method: 'GET', headers, timeout: 10000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectWs(path: string, headers: Record<string, string> = {}, protocols?: string[]): Promise<WS> {
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${PROXY_PORT}${path}`, protocols, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS 连接超时 10s')), 10000);
  });
}

function rpc<T = Record<string, unknown>>(ws: WS, msg: Record<string, unknown>, timeout = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc 超时: ${JSON.stringify(msg).substring(0, 60)}`)), timeout);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timer);
      if (data.length === 0) {
        reject(new Error('收到空消息（0 字节帧）'));
        return;
      }
      resolve(JSON.parse(data.toString()));
    });
    ws.send(JSON.stringify(msg));
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

async function main() {
  section('环境清理与启动');
  for (const p of [MOCK_BACKEND_PORT, PROXY_PORT, ADMIN_PORT]) await killPort(p);
  await sleep(300);

  await startMockBackend();

  const gateway = exec(`DYNAPM_CONFIG=dynapm.config.passthrough-test.ts npx tsx src/index.ts`);
  gateway.stdout?.on('data', () => {});
  gateway.stderr?.on('data', (d) => process.stderr.write(`[gateway] ${d}`));

  if (!await waitForPort(PROXY_PORT)) throw new Error('网关 passthrough 端口启动失败');
  log(`网关已启动: passthrough ${PROXY_PORT} -> ${MOCK_BACKEND_PORT}`, C.yellow);

  section('passthrough 直通模式 WS 场景测试');

  await runTest('1. HTTP 混合请求仍正常（走流式代理 + 鉴权头透传）', async () => {
    const res = await httpRequest('/check-auth', { Authorization: 'token-pt-test' });
    if (res.status !== 200) throw new Error(`状态码 ${res.status}`);
    const body = JSON.parse(res.body);
    if (body.code !== 0 || body.auth !== 'token-pt-test') throw new Error(`鉴权头丢失: ${res.body}`);
  });

  await runTest('2. WS 升级 Authorization 头透传（原始头字节原样转发）', async () => {
    const ws = await connectWs('/ws', { Authorization: 'token-pt-test', Origin: 'http://127.0.0.1:3161' });
    const reply = await rpc<{ type: string; auth: string | null }>(ws, { type: 'whoami' });
    ws.close();
    if (reply.auth !== 'token-pt-test') throw new Error(`Authorization 未透传: ${JSON.stringify(reply)}`);
  });

  await runTest('3. WS Origin 头透传', async () => {
    const ws = await connectWs('/ws', { Origin: 'http://pt.example.com' });
    const reply = await rpc<{ origin: string | null }>(ws, { type: 'whoami' });
    ws.close();
    if (reply.origin !== 'http://pt.example.com') throw new Error(`Origin 未透传: ${JSON.stringify(reply)}`);
  });

  await runTest('4. WS 子协议 sec-websocket-protocol 透传', async () => {
    const ws = await connectWs('/ws', {}, ['pt-v1']);
    const reply = await rpc<{ protocol: string | null }>(ws, { type: 'whoami' });
    ws.close();
    if (reply.protocol !== 'pt-v1') throw new Error(`子协议未透传: ${JSON.stringify(reply)}`);
  });

  await runTest('5. echo 小消息', async () => {
    const ws = await connectWs('/ws', {});
    const reply = await rpc<{ type: string; data: string }>(ws, { type: 'echo', data: 'hello-passthrough' });
    ws.close();
    if (reply.type !== 'echo' || reply.data !== 'hello-passthrough') throw new Error(`echo 失败: ${JSON.stringify(reply)}`);
  });

  await runTest('6. 大消息 2MB 双向转发', async () => {
    const ws = await connectWs('/ws', {});
    const big = 'x'.repeat(2 * 1024 * 1024);
    const reply = await rpc<{ type: string; data: string }>(ws, { type: 'big', data: big }, 15000);
    ws.close();
    if (reply.data !== big) throw new Error(`大消息损坏: 收到 ${reply.data?.length} 字节, 期望 ${big.length}`);
  });

  await runTest('7. 协议层 ping 透传（直通模式天然成立）', async () => {
    const ws = await connectWs('/ws', {});
    const pingPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('未收到协议层 ping 帧')), 8000);
      ws.once('ping', () => { clearTimeout(timer); resolve(); });
    });
    ws.send(JSON.stringify({ type: 'ping-frame' }));
    await pingPromise;
    ws.close();
  });

  await runTest('8. 后端 4001 关闭码透传', async () => {
    const ws = await connectWs('/ws', {});
    const closePromise = new Promise<{ code: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('未收到关闭事件')), 8000);
      ws.once('close', (code) => { clearTimeout(timer); resolve({ code }); });
    });
    ws.send(JSON.stringify({ type: 'close-4001' }));
    const { code } = await closePromise;
    if (code !== 4001) throw new Error(`关闭码不是 4001: ${code}`);
  });

  await runTest('9. 活跃 WS 连接期间服务不被闲置回收', async () => {
    const ws = await connectWs('/ws', {});
    for (let i = 0; i < 6; i++) {
      await rpc(ws, { type: 'echo', data: `keep-${i}` });
      await sleep(1000);
    }
    const ws2 = await connectWs('/ws', {});
    const reply = await rpc<{ type: string }>(ws2, { type: 'echo', data: 'still-alive' });
    ws.close();
    ws2.close();
    if (reply.type !== 'echo') throw new Error('服务被误回收');
  });

  section('结果汇总');
  let passed = 0;
  for (const r of results) {
    if (r.passed) passed++;
    log(`${r.passed ? '✓' : '✗'} ${r.name}${r.message ? ` — ${r.message}` : ''}`, r.passed ? C.green : C.red);
  }
  log(`\n结果: ${passed}/${results.length} passed`, passed === results.length ? C.green : C.red);

  gateway.kill();
  for (const p of [MOCK_BACKEND_PORT, PROXY_PORT, ADMIN_PORT]) await killPort(p);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (err) => {
  log(`致命错误: ${err.message}`, C.red);
  for (const p of [MOCK_BACKEND_PORT, PROXY_PORT, ADMIN_PORT]) await killPort(p);
  process.exit(1);
});
