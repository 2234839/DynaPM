/**
 * DynaPM-Bun 模拟思源笔记特征 WS 场景对拍测试
 * （契约 = packages/gateway/test/test-ws-siyuan.ts，9 场景不变）
 *
 * 后端：ws 库 WebSocketServer 内嵌于本测试进程（bun 可解析 ws 依赖）
 * 网关：startBunGateway + dynapm.config.ws-siyuan-test.ts
 * 端口：后端 3140 / 代理 3151 / 网关 3150 / 管理 3152
 */

import { createConnection } from 'node:net';
import * as http from 'node:http';
import { WebSocket as WS, WebSocketServer } from 'ws';
import { checkPort, killPort, waitForPort, section, log, C, sleep, startBunGateway } from './helpers.js';

/** 模拟思源后端端口 */
const MOCK_BACKEND_PORT = 3140;
/** 网关代理端口 */
const PROXY_PORT = 3151;
/** 网关主端口 */
const GATEWAY_PORT = 3150;
/** 管理端口 */
const ADMIN_PORT = 3152;

/** 后端记录的最近一次 upgrade 请求头 */
let lastUpgradeHeaders: Record<string, string> = {};

/**
 * 启动模拟思源后端：HTTP + WS 同端口混合服务
 */
function startMockBackend(): Promise<void> {
  const wss2 = new WebSocketServer({ noServer: true });
  wss2.on('connection', (ws, req) => {
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
          protocol: (lastUpgradeHeaders['sec-websocket-protocol'] ?? null),
        }));
      } else if (msg.type === 'ping-frame') {
        ws.ping('hb');
      } else if (msg.type === 'close-4001') {
        ws.close(4001, 'siyuan-custom-close');
      }
    });
  });

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/check-auth') {
      const auth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: auth === 'token-siyuan-test' ? 0 : -1, auth: auth || null }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('siyuan-mock');
  });

  httpServer.on('upgrade', (req, socket, head) => {
    lastUpgradeHeaders = req.headers as Record<string, string>;
    wss2.handleUpgrade(req, socket as import('node:net').Socket, head, (ws) => {
      wss2.emit('connection', ws, req);
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(MOCK_BACKEND_PORT, () => {
      log(`模拟思源后端已启动: http://127.0.0.1:${MOCK_BACKEND_PORT}`, C.yellow);
      resolve();
    });
  });
}

async function killPort(port: number) {
  try { await (await import('node:child_process')).exec(`lsof -ti:${port} -sTCP:LISTEN | xargs -r kill -9 2>/dev/null`); } catch {}
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

/** 连接网关代理的 WS */
function connectWs(path: string, headers: Record<string, string> = {}, protocols?: string[]): Promise<WS> {
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${PROXY_PORT}${path}`, protocols, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS 连接超时 10s')), 10000);
  });
}

/** 发送 JSON 并等待匹配响应 */
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
  log('\n📣 DynaPM-Bun 思源特征 WS 场景对拍测试', C.cyan);
  section('环境清理与启动');
  for (const p of [MOCK_BACKEND_PORT, PROXY_PORT, GATEWAY_PORT, ADMIN_PORT]) await killPort(p);
  await sleep(300);

  await startMockBackend();

  const gateway = startBunGateway(process.cwd() + '/dynapm.config.ws-siyuan-test.ts');
  if (!await waitForPort(PROXY_PORT)) throw new Error('网关代理端口启动失败');
  log(`网关已启动: 代理 ${PROXY_PORT} -> ${MOCK_BACKEND_PORT}`, C.yellow);

  section('思源特征 WS 场景测试');

  await runTest('1. HTTP /check-auth 鉴权头透传', async () => {
    const res = await httpRequest('/check-auth', { Authorization: 'token-siyuan-test' });
    if (res.status !== 200) throw new Error(`状态码 ${res.status}`);
    const body = JSON.parse(res.body);
    if (body.code !== 0 || body.auth !== 'token-siyuan-test') throw new Error(`鉴权头丢失: ${res.body}`);
  });

  await runTest('2. WS 升级 Authorization 头透传', async () => {
    const ws = await connectWs('/ws', { Authorization: 'token-siyuan-test', Origin: 'http://127.0.0.1:3151' });
    const reply = await rpc<{ type: string; auth: string | null }>(ws, { type: 'whoami' });
    ws.close();
    if (reply.auth !== 'token-siyuan-test') throw new Error(`Authorization 未透传: ${JSON.stringify(reply)}`);
  });

  await runTest('3. WS Origin 头透传', async () => {
    const ws = await connectWs('/ws', { Origin: 'http://siyuan.example.com' });
    const reply = await rpc<{ origin: string | null }>(ws, { type: 'whoami' });
    ws.close();
    if (reply.origin !== 'http://siyuan.example.com') throw new Error(`Origin 未透传: ${JSON.stringify(reply)}`);
  });

  await runTest('4. WS 子协议 sec-websocket-protocol 透传', async () => {
    const ws = await connectWs('/ws', {}, ['siyuan-v1']);
    const reply = await rpc<{ protocol: string | null }>(ws, { type: 'whoami' });
    ws.close();
    if (reply.protocol !== 'siyuan-v1') throw new Error(`子协议未透传: ${JSON.stringify(reply)}`);
  });

  await runTest('5. echo 小消息', async () => {
    const ws = await connectWs('/ws', {});
    const reply = await rpc<{ type: string; data: string }>(ws, { type: 'echo', data: 'hello-siyuan' });
    ws.close();
    if (reply.type !== 'echo' || reply.data !== 'hello-siyuan') throw new Error(`echo 失败: ${JSON.stringify(reply)}`);
  });

  await runTest('6. 大消息 2MB 双向转发', async () => {
    const ws = await connectWs('/ws', {});
    const big = 'x'.repeat(2 * 1024 * 1024);
    const reply = await rpc<{ type: string; data: string }>(ws, { type: 'big', data: big }, 15000);
    ws.close();
    if (reply.data !== big) throw new Error(`大消息损坏: 收到 ${reply.data?.length} 字节, 期望 ${big.length}`);
  });

  await runTest('7. 协议层 ping/pong 心跳', async () => {
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

  gateway.kill('SIGKILL');
  for (const p of [MOCK_BACKEND_PORT, PROXY_PORT, GATEWAY_PORT, ADMIN_PORT]) await killPort(p);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (err) => {
  log(`致命错误: ${err instanceof Error ? err.message : String(err)}`, C.red);
  for (const p of [MOCK_BACKEND_PORT, PROXY_PORT, GATEWAY_PORT, ADMIN_PORT]) await killPort(p);
  process.exit(1);
});
