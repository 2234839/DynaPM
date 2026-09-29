/**
 * keepWarm 常驻软预热测试
 *
 * 断言：keepWarm: true 的服务在闲置检查时使用独立的 warmIdleTimeout（短阈值）判定回收，
 * 而不是通用 idleTimeout（长阈值）。
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

const GW_PORT = 3278;
const ADMIN_PORT = 3279;
const BACKEND_PORT = 3280;

/** keepWarm 独立回收阈值（短） */
const WARM_IDLE_MS = 2000;
/** 通用闲置阈值（长，远大于检查时长）：若误用此阈值则用例超时失败 */
const LONG_IDLE_MS = 600 * 1000;

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

function buildConfig(): DynaPMConfig {
  const cwd = process.cwd();
  return {
    port: GW_PORT,
    host: '127.0.0.1',
    adminApi: { enabled: true, port: ADMIN_PORT },
    logging: { enableRequestLog: false, enableWebSocketLog: false, enablePerformanceLog: false },
    services: {
      'keepwarm-svc': {
        name: 'keepwarm-svc',
        host: 'keepwarm.test',
        routes: [{ type: 'host', value: 'keepwarm.test', target: `http://127.0.0.1:${BACKEND_PORT}` }],
        base: `http://127.0.0.1:${BACKEND_PORT}`,
        idleTimeout: LONG_IDLE_MS,
        warmIdleTimeout: WARM_IDLE_MS,
        keepWarm: true,
        startTimeout: 15 * 1000,
        commands: {
          start: `nohup bun run ${cwd}/test/services/fast-server.ts ${BACKEND_PORT} >> logs/keepwarm-backend.log 2>&1 &`,
          stop: `lsof -i:${BACKEND_PORT} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9`,
          check: `lsof -i:${BACKEND_PORT} -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1`,
        },
        healthCheck: { type: 'tcp' },
      },
    },
  };
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

async function main() {
  log('\n🔥 keepWarm 常驻软预热测试', C.cyan);
  let failures = 0;

  for (const port of [GW_PORT, ADMIN_PORT, BACKEND_PORT]) await killPort(port);
  await sleep(300);

  const gateway = new Gateway(buildConfig(), pino({ enabled: false }));
  await gateway.start();
  await waitForPort(GW_PORT);
  await waitForPort(ADMIN_PORT);
  await sleep(300);

  try {
    // 1. 冷启动让服务上线
    const status = await httpRequest('/ping', 'keepwarm.test');
    assert(status === 200, `冷启动代理请求应 200，实际 ${status}`);
    assert(await checkPort(BACKEND_PORT), '冷启动后后端应在线');
    log('  ✓ 冷启动完成，后端在线', C.green);

    // 2. 闲置 warmIdleTimeout（2s）+ 检查间隔（3s）内应被回收；
    //    若误用通用 idleTimeout（10min）则后端进程不会退出
    const recycledStart = Date.now();
    let recycled = false;
    while (Date.now() - recycledStart < 10000) {
      if (!(await checkPort(BACKEND_PORT))) { recycled = true; break; }
      await sleep(300);
    }
    assert(recycled, `keepWarm 服务应在 warmIdleTimeout=${WARM_IDLE_MS}ms 后被回收（而非通用 idleTimeout）`);
    const elapsed = Date.now() - recycledStart;
    log(`  ✓ keepWarm 服务用独立阈值回收（等待 ${elapsed}ms 后后端停止）`, C.green);

    // 3. 回收后可重新按需启动
    const status2 = await httpRequest('/ping', 'keepwarm.test');
    assert(status2 === 200, `回收后重新请求应 200，实际 ${status2}`);
    log('  ✓ 回收后可重新按需启动', C.green);

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
