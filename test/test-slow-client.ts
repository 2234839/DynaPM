/**
 * 慢客户端停滞超时测试
 *
 * 断言：
 * 1. 响应转发路径：客户端收到响应头后不读 body（socket pause），
 *    背压停滞超过 proxyTimeoutMs 后网关断开客户端连接（socket close）
 * 2. 断开后服务 activeConnections 归零，服务随后能正常闲置回收停止
 * 3. 冷启动 body 拖延路径：客户端发起 POST 后迟迟不发完 body，
 *    超过 proxyTimeoutMs 后网关断开连接并中止启动等待
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import net from 'node:net';
import pino from 'pino';
import { Gateway } from '../src/core/gateway.js';
import type { DynaPMConfig } from '../src/config/types.js';

const execAsync = promisify(exec);

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m' };
function log(msg: string, color = C.reset) { console.log(`${color}${msg}${C.reset}`); }
function assert(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** 注入的短超时（毫秒）：所有用例应远小于 10s */
const PROXY_TIMEOUT_MS = 1000;

const GW_PORT = 3156;
const ADMIN_PORT = 3157;
const BACKEND_PORT = 3198;

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port, timeout: 200 }, () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function killPort(port: number) {
  try {
    await execAsync(`lsof -i:${port} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9 2>/dev/null`);
  } catch {}
}

async function waitForPort(port: number, timeout = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await checkPort(port)) return true; await sleep(100); }
  return false;
}

function httpRequest(path: string, host: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: GW_PORT, path, method, headers: { Host: `${host}:${GW_PORT}` }, timeout: 30000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('error', reject);
    req.end();
  });
}

function buildConfig(): DynaPMConfig {
  const cwd = process.cwd();
  return {
    port: GW_PORT,
    host: '127.0.0.1',
    adminApi: { enabled: true, port: ADMIN_PORT },
    logging: { enableRequestLog: false, enableWebSocketLog: false, enablePerformanceLog: false },
    timeouts: { proxyTimeoutMs: PROXY_TIMEOUT_MS },
    services: {
      'slow-client': {
        name: 'slow-client',
        host: 'slow-client.test',
        routes: [{ type: 'host', value: 'slow-client.test', target: `http://127.0.0.1:${BACKEND_PORT}` }],
        base: `http://127.0.0.1:${BACKEND_PORT}`,
        idleTimeout: 3000,
        startTimeout: 15 * 1000,
        commands: {
          start: `nohup node --experimental-strip-types ${cwd}/test/services/stream-server.ts ${BACKEND_PORT} >> logs/slow-client-backend.log 2>&1 &`,
          stop: `lsof -i:${BACKEND_PORT} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9`,
          check: `lsof -i:${BACKEND_PORT} -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1`,
        },
        healthCheck: { type: 'tcp' },
      },
    },
  };
}

/** 内部状态探针：通过 admin 无法拿 activeConnections，这里直接断言端口可再启动 */
async function assertServiceRecycled(): Promise<void> {
  /** 闲置 3s + 检查间隔 3s 内应完成回收；等后端端口被 kill 即证明回收成功 */
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const alive = await checkPort(BACKEND_PORT);
    if (!alive) return;
    await sleep(300);
  }
  throw new Error('服务未在预期时间内被闲置回收停止');
}

async function main() {
  log('\n🐢 慢客户端停滞超时测试', C.cyan);
  let failures = 0;

  for (const port of [GW_PORT, ADMIN_PORT, BACKEND_PORT]) await killPort(port);
  await sleep(300);

  const gateway = new Gateway(buildConfig(), pino({ enabled: false }));
  await gateway.start();
  await waitForPort(GW_PORT);
  await waitForPort(ADMIN_PORT);

  try {
    // ===== 用例 1：响应转发路径慢客户端 =====
    {
      log('\n[用例 1] 收到响应头后不读 body 的慢客户端被网关断开', C.cyan);

      /** 先用普通请求完成冷启动，让服务在线 */
      const warmStatus = await httpRequest('/ping', 'slow-client.test');
      assert(warmStatus === 200, `预热请求应 200，实际 ${warmStatus}`);
      log('  ✓ 服务已预热上线', C.green);

      /** 手动发原始 HTTP 请求拿大响应，收到响应头后立即 pause socket 不再消费 */
      const sock = net.createConnection({ host: '127.0.0.1', port: GW_PORT });
      sock.on('error', () => {});
      const raw = `GET /stream HTTP/1.1\r\nHost: slow-client.test:${GW_PORT}\r\nConnection: close\r\n\r\n`;
      sock.write(raw);

      const gotHeaders = await new Promise<boolean>((resolve) => {
        let buf = '';
        const onData = (d: Buffer) => {
          buf += d.toString('latin1').slice(0, 4096);
          if (buf.includes('\r\n\r\n')) {
            sock.removeListener('data', onData);
            /** 收到响应头后立刻暂停 socket：不再消费 body，制造网关侧背压 */
            sock.pause();
            resolve(true);
          }
        };
        sock.on('data', onData);
        sock.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 8000);
      });
      assert(gotHeaders, '应收到响应头');
      log('  ✓ 已收到响应头，客户端停止读取', C.green);

      /**
       * 停滞超时（proxyTimeoutMs=1s）后网关应主动断开。
       * 注意：Node 的 socket.pause() 会阻塞 close 事件投递（FIN/RST 不被消费），
       * 所以周期性短暂 resume 以消费内核事件，但立即 re-pause、不做应用层读取（保持背压）。
       */
      const t0 = Date.now();
      let closed = false;
      sock.on('close', () => { closed = true; });
      const probe = setInterval(() => {
        sock.resume();
        setImmediate(() => { if (!closed) sock.pause(); });
      }, 100);
      const ok = await new Promise<boolean>((resolve) => {
        const check = setInterval(() => {
          if (closed) { clearInterval(check); resolve(true); }
        }, 50);
        setTimeout(() => { clearInterval(check); resolve(false); }, PROXY_TIMEOUT_MS + 4000);
      });
      clearInterval(probe);
      assert(ok, `网关应在停滞 ${PROXY_TIMEOUT_MS}ms 后断开客户端`);
      log(`  ✓ 网关已在停滞超时后断开客户端连接（停滞 ${Date.now() - t0}ms 内）`, C.green);
    }

    // ===== 用例 2：服务能正常闲置回收停止 =====
    {
      log('\n[用例 2] 断开后服务能正常闲置回收停止', C.cyan);
      await assertServiceRecycled();
      log('  ✓ 后端进程已被闲置回收 kill（activeConnections 未被泄漏占用）', C.green);
    }

    // ===== 用例 3：冷启动 body 拖延慢客户端 =====
    {
      log('\n[用例 3] 冷启动期间客户端拖延发送 body 被网关断开', C.cyan);

      const sock = net.createConnection({ host: '127.0.0.1', port: GW_PORT });
      /** 发送声明了 content-length 但不发 body：卡住 collectRequestBody */
      const raw = `POST /echo HTTP/1.1\r\nHost: slow-client.test:${GW_PORT}\r\nContent-Length: 100\r\n\r\n`;
      sock.write(raw);

      const closed = await new Promise<boolean>((resolve) => {
        const t0 = Date.now();
        sock.on('close', () => resolve(Date.now() - t0 < PROXY_TIMEOUT_MS + 4000));
        setTimeout(() => resolve(false), PROXY_TIMEOUT_MS + 4000);
      });
      assert(closed, `网关应在 body 发送停滞 ${PROXY_TIMEOUT_MS}ms 后断开客户端`);
      log('  ✓ 网关已断开拖延 body 的慢客户端', C.green);
    }

    log('\n✅ 全部断言通过', C.green);
  } catch (err) {
    failures++;
    log(`❌ 测试失败: ${err instanceof Error ? err.message : String(err)}`, C.red);
  } finally {
    await gateway.cleanup().catch(() => {});
    for (const port of [GW_PORT, ADMIN_PORT, BACKEND_PORT]) await killPort(port);
  }

  process.exit(failures > 0 ? 1 : 0);
}

main();
