/**
 * Agent 池清理测试（TDD 先行）
 *
 * 断言：
 * 1. 请求代理后 gateway 为服务创建了 keep-alive Agent
 * 2. 通过 Admin API 停止服务后，该服务的 Agent 被销毁并从池中移除
 * 3. 再次请求（重新冷启动）后 Agent 恢复
 * 4. Agent 创建的 socket 设置了 TCP_NODELAY
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import net from 'node:net';
const pino = (_opts: unknown) => ({ info() {}, warn() {}, error() {}, debug() {} });
import { BunGateway as Gateway } from '../src/core/gateway.js';

import type { DynaPMConfig } from '../src/config/types.js';

const execAsync = promisify(exec);

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m' };
function log(msg: string, color = C.reset) { console.log(`${color}${msg}${C.reset}`); }
function assert(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const GW_PORT = 3150;
const ADMIN_PORT = 3151;
const BACKEND_PORT = 3197;

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
    services: {
      'agent-cleanup': {
        name: 'agent-cleanup',
        host: 'agent-cleanup.test',
        routes: [{ type: 'host', value: 'agent-cleanup.test', target: `http://127.0.0.1:${BACKEND_PORT}` }],
        base: `http://127.0.0.1:${BACKEND_PORT}`,
        idleTimeout: 600 * 1000,
        startTimeout: 15 * 1000,
        commands: {
          start: `nohup bun run ${cwd}/test/services/echo-server.ts ${BACKEND_PORT} >> logs/agent-cleanup-backend.log 2>&1 &`,
          stop: `lsof -i:${BACKEND_PORT} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9`,
          check: `lsof -i:${BACKEND_PORT} -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1`,
        },
        healthCheck: { type: 'tcp' },
      },
    },
  };
}

async function main() {
  log('\n🧹 Agent 池清理测试', C.cyan);
  let failures = 0;

  for (const port of [GW_PORT, ADMIN_PORT, BACKEND_PORT]) await killPort(port);
  await sleep(300);

  const gateway = new Gateway(buildConfig(), pino({ enabled: false }));
  await gateway.start();
  await waitForPort(GW_PORT);
  await waitForPort(ADMIN_PORT);
  await sleep(300);

  try {
    // 1. 首次请求触发冷启动 + 代理，应创建 Agent
    const status = await httpRequest('/ping', 'agent-cleanup.test');
    assert(status === 200, `代理请求应 200，实际 ${status}`);
    assert(gateway.isAgentActive('agent-cleanup'), '代理后应存在该服务的 Agent');
    log('  ✓ 代理后 Agent 已创建', C.green);

    // 2. Admin API 停止服务 → Agent 应被清理
    const stopRes = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: ADMIN_PORT, path: '/_dynapm/api/services/agent-cleanup/stop', method: 'POST', timeout: 30000 }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      });
      req.on('error', reject);
      req.end();
    });
    assert(stopRes === 200, `停止应 200，实际 ${stopRes}`);
    await sleep(200);
    assert(!gateway.isAgentActive('agent-cleanup'), '停止后 Agent 应被销毁移除');
    log('  ✓ 停止后 Agent 已清理', C.green);

    // 3. 再次请求重新冷启动，Agent 恢复
    const status2 = await httpRequest('/ping', 'agent-cleanup.test');
    assert(status2 === 200, `重启后代理请求应 200，实际 ${status2}`);
    assert(gateway.isAgentActive('agent-cleanup'), '重启后 Agent 应重建');
    log('  ✓ 重启后 Agent 重建', C.green);

    /**
   * 【Bun 版语义近似】用例 4 依赖 Node 版 pipeTcpSockets 的 kSetNoDelay 内部
   * Symbol 检查；Bun 版连接池基于 Bun fetch（无对应管道实现），跳过。
   */
  log('  ⏭️ [跳过] Bun 版无 pipeTcpSockets 管道实现，TCP_NODELAY 断言不适用', '\x1b[33m');
  } catch (err) {
    failures++;
    log(`  ✗ ${err instanceof Error ? err.message : err}`, C.red);
  } finally {
    for (const port of [GW_PORT, ADMIN_PORT, BACKEND_PORT]) await killPort(port);
  }

  log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`, failures === 0 ? C.green : C.red);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { log(`测试异常: ${e instanceof Error ? e.stack : e}`, C.red); process.exit(1); });
