/**
 * 测试共享工具
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { createConnection } from 'node:net';

export const execAsync = promisify(exec);

/** 终端配色 */
export const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

/** 带颜色输出 */
export function log(msg: string, color = C.reset) { console.log(`${color}${msg}${C.reset}`); }

/** 分节标题 */
export function section(msg: string) {
  log(`\n${'='.repeat(60)}`, C.cyan);
  log(msg, C.cyan);
  log('='.repeat(60), C.cyan);
}

/** 睡眠 */
export function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

/** 检查端口是否可连 */
export function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 200 }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/** 强杀占用端口的进程 */
export async function killPort(port: number) {
  try { await execAsync(`lsof -i:${port} -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9 2>/dev/null`); } catch { /* 忽略 */ }
}

/** 等待端口就绪 */
export async function waitForPort(port: number, timeout = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await checkPort(port)) return true; await sleep(100); }
  return false;
}

/** Node http.request 封装 */
export function httpRequest(options: {
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeout?: number;
}): Promise<{ status: number; body: string }> {
  const { port = 3130, path = '/', method = 'GET', headers = {}, body, timeout = 30000 } = options;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, timeout }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

/** 断言 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 测试用例执行器 */
export interface TestResult { name: string; passed: boolean; message: string; duration: number }

/**
 * 运行单个测试用例并记录结果
 */
export async function runTest(name: string, fn: () => Promise<void>, results: TestResult[]) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, message: '通过', duration: Date.now() - start });
    log(`  ✓ ${name}`, C.green);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, message, duration: Date.now() - start });
    log(`  ✗ ${name}: ${message}`, C.red);
  }
}

/** 汇总并退出 */
export function summarizeAndExit(results: TestResult[]) {
  section('测试结果汇总');
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  for (const r of results) {
    log(`${r.passed ? '✓' : '✗'} ${r.name} (${r.duration}ms)${r.passed ? '' : ' - ' + r.message}`, r.passed ? C.green : C.red);
  }
  log(`\n总计: ${results.length} | 通过: ${passed} | 失败: ${failed}`, passed === results.length ? C.green : C.red);
  process.exit(failed > 0 ? 1 : 0);
}

/**
 * 以 Bun 启动网关（DYNAPM_CONFIG 指向配置）
 * @returns 子进程
 */
export function startBunGateway(configPath: string, logTag = '[gw]'): ReturnType<typeof exec> {
  const child = exec(`DYNAPM_CONFIG=${configPath} bun run ${process.cwd()}/src/index.ts`);
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (d) => process.stderr.write(`${logTag} ${d}`));
  return child;
}
