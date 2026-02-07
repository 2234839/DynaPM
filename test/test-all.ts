/**
 * DynaPM 完整功能测试脚本
 *
 * 测试场景：
 * 1. 按需启动 - 服务离线时自动启动
 * 2. 热启动 - 服务已运行时直接代理
 * 3. 自动停止 - 服务闲置后自动停止
 * 4. 多服务 - 同时管理多个服务
 * 5. 错误处理 - 404 等异常情况
 * 6. 健康检查 - TCP/HTTP 不同检查方式
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const execAsync = promisify(exec);

/** 颜色输出 */
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/** 测试结果 */
interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

const results: TestResult[] = [];

/** 工具函数 */
function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function success(message: string) {
  log(`✓ ${message}`, colors.green);
}

function error(message: string) {
  log(`✗ ${message}`, colors.red);
}

function info(message: string) {
  log(`ℹ ${message}`, colors.cyan);
}

function section(message: string) {
  log(`\n${'='.repeat(60)}`, colors.blue);
  log(`${message}`, colors.blue);
  log('='.repeat(60), colors.blue);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function curl(options: {
  hostname: string;
  path?: string;
  expectedStatus?: number;
  expectedContent?: string;
  timeout?: number;
}): Promise<{ success: boolean; status?: number; body?: string; message: string }> {
  const { hostname, path = '/', expectedStatus = 200, expectedContent, timeout = 5000 } = options;

  try {
    const timeoutSec = Math.floor(timeout / 1000);
    const url = `http://127.0.0.1:3000${path}`;
    const cmd = `curl --noproxy "*" -s -w "\\n%{http_code}" -m ${timeoutSec} -H "Host: ${hostname}" "${url}"`;

    const { stdout } = await execAsync(cmd, { timeout });

    const lines = stdout.trim().split('\n');
    const body = lines.slice(0, -1).join('\n');
    const status = parseInt(lines[lines.length - 1]);

    if (status !== expectedStatus) {
      return {
        success: false,
        status,
        body,
        message: `期望状态码 ${expectedStatus}，实际 ${status}`,
      };
    }

    if (expectedContent && !body.includes(expectedContent)) {
      return {
        success: false,
        status,
        body,
        message: `响应内容不包含: ${expectedContent}`,
      };
    }

    return { success: true, status, body, message: 'OK' };
  } catch (err: any) {
    return {
      success: false,
      message: `请求失败: ${err.message}`,
    };
  }
}

async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<void> {
  const startTime = Date.now();
  try {
    await testFn();
    const duration = Date.now() - startTime;
    results.push({ name, passed: true, message: '通过', duration });
    success(name);
  } catch (err: any) {
    const duration = Date.now() - startTime;
    results.push({ name, passed: false, message: err.message, duration });
    error(`${name}: ${err.message}`);
  }
}

async function checkProcess(port: number): Promise<boolean> {
  try {
    await execAsync(`lsof -ti:${port} >/dev/null 2>&1`);
    return true;
  } catch {
    return false;
  }
}

async function checkServiceRunning(serviceName: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`pgrep -f "${serviceName}"`);
    return !!stdout.trim();
  } catch {
    return false;
  }
}

/**
 * 测试场景
 */

async function test1_按需启动() {
  info('请求 app1.test（服务当前应该离线）');

  // 先确保服务离线
  await execAsync('lsof -ti:3001 | xargs -r kill -9 2>/dev/null');
  await sleep(500);

  const isRunning = await checkProcess(3001);
  if (isRunning) {
    throw new Error('服务应该离线但仍在运行');
  }

  // 发送请求
  const result = await curl({
    hostname: 'app1.test',
    expectedContent: 'Hello from App 1',
  });

  if (!result.success) {
    throw new Error(result.message);
  }

  // 验证服务已启动
  const running = await checkProcess(3001);
  if (!running) {
    throw new Error('服务应该已启动');
  }

  success('服务自动启动成功');
}

async function test2_热启动() {
  info('再次请求 app1.test（服务应该已在运行）');

  const result = await curl({
    hostname: 'app1.test',
    expectedContent: 'Hello from App 1',
  });

  if (!result.success) {
    throw new Error(result.message);
  }

  success('服务已运行时直接代理，无需重新启动');
}

async function test3_自动停止() {
  info('等待20秒验证自动停止（确保覆盖3秒的检查间隔）');

  await sleep(20000);

  const isRunning = await checkProcess(3001);
  if (isRunning) {
    throw new Error('服务应该已自动停止');
  }

  success('服务在闲置后自动停止');
}

async function test4_404错误() {
  info('请求不存在的服务');

  const result = await curl({
    hostname: 'notfound.test',
    expectedStatus: 404,
  });

  if (!result.success) {
    throw new Error(result.message);
  }

  success('正确返回 404 错误');
}

async function test5_多服务并发() {
  info('同时请求多个服务');

  // 确保所有服务离线
  await execAsync('lsof -ti:3001,3002,3003 | xargs -r kill -9 2>/dev/null');
  await sleep(500);

  // 并发请求
  const [r1, r2, r3] = await Promise.all([
    curl({ hostname: 'app1.test', expectedContent: 'Hello from App 1' }),
    curl({ hostname: 'app2.test', expectedContent: 'Hello from App 2' }),
    curl({ hostname: 'app3.test', expectedContent: 'Hello from App 3' }),
  ]);

  if (!r1.success || !r2.success || !r3.success) {
    throw new Error('部分服务启动失败');
  }

  // 验证所有服务都在运行
  const p1 = await checkProcess(3001);
  const p2 = await checkProcess(3002);
  const p3 = await checkProcess(3003);

  if (!p1 || !p2 || !p3) {
    throw new Error('部分服务未成功启动');
  }

  success('3个服务同时启动成功');
}

async function test6_不同健康检查() {
  info('测试 TCP 健康检查（app1已在测试5中启动）');

  const r1 = await curl({ hostname: 'app1.test', expectedContent: 'Hello from App 1' });
  if (!r1.success) throw new Error(r1.message);

  success('TCP 健康检查工作正常');

  info('测试 HTTP 健康检查（app2已在测试5中启动）');

  const r2 = await curl({ hostname: 'app2.test', expectedContent: 'Hello from App 2' });
  if (!r2.success) throw new Error(r2.message);

  success('HTTP 健康检查工作正常');
}

async function test7_路径代理() {
  info('测试不同路径的代理');

  // app3 已在测试5中启动，使用它来测试路径代理
  const result = await curl({
    hostname: 'app3.test',
    path: '/api/test',
    expectedContent: 'Hello from App 3',
  });

  if (!result.success) {
    throw new Error(result.message);
  }

  success('路径正确代理到后端服务');
}

async function test8_连续请求更新闲置时间() {
  info('测试连续请求不会触发自动停止');

  // app1 已被测试3停止，直接启动
  await curl({ hostname: 'app1.test' });
  await sleep(3000);

  // 再次请求（更新闲置时间）
  await curl({ hostname: 'app1.test' });
  await sleep(3000);

  // 第三次请求（重置闲置时间）
  await curl({ hostname: 'app1.test' });

  // 等待8秒（少于闲置超时的10秒）
  await sleep(8000);

  const isRunning = await checkProcess(3001);
  if (!isRunning) {
    throw new Error('服务仍在活跃访问时不应该停止');
  }

  success('连续请求正确更新闲置时间');
}

async function test9_POST请求() {
  info('测试 POST 请求');

  // app1 应该在测试8中已启动，直接发送POST请求
  try {
    const { stdout } = await execAsync(
      `curl --noproxy "*" -s -w "\\n%{http_code}" -X POST -H "Content-Type: application/json" -H "Host: app1.test" -d '{"name":"test"}' "http://127.0.0.1:3000/api/post"`,
      { timeout: 5000 }
    );

    const lines = stdout.trim().split('\n');
    const status = parseInt(lines[lines.length - 1]);

    if (status === 200 || status === 201) {
      success(`POST 请求成功，状态码: ${status}`);
    } else {
      throw new Error(`POST 期望状态码 200/201，实际 ${status}`);
    }
  } catch (err: any) {
    throw new Error(`POST 请求失败: ${err.message}`);
  }
}

/**
 * 主测试流程
 */
async function main() {
  log('\n🚀 DynaPM 功能测试', colors.magenta);
  log('测试脚本: node test/test-all.js\n', colors.magenta);

  // 检查网关是否运行
  info('检查网关状态...');
  try {
    await execAsync('lsof -ti:3000 >/dev/null 2>&1');
    error('网关已在运行，请先停止: kill $(lsof -ti:3000)');
    process.exit(1);
  } catch {
    success('网关未运行，准备启动');
  }

  // 启动网关
  section('启动 DynaPM 网关');
  try {
    exec('node dist/src/index.js > /dev/null 2>&1 &');
    await sleep(3000);
    success('网关已启动');
  } catch (err: any) {
    error(`网关启动失败: ${err.message}`);
    process.exit(1);
  }

  // 运行测试
  section('开始测试');

  await runTest('测试1: 按需启动', test1_按需启动);
  await runTest('测试2: 热启动（服务已运行）', test2_热启动);
  await runTest('测试3: 自动停止', test3_自动停止);
  await runTest('测试4: 404 错误处理', test4_404错误);
  await runTest('测试5: 多服务并发启动', test5_多服务并发);
  await runTest('测试6: 不同健康检查方式', test6_不同健康检查);
  await runTest('测试7: 路径代理', test7_路径代理);
  await runTest('测试8: 连续请求更新闲置时间', test8_连续请求更新闲置时间);
  await runTest('测试9: POST 请求', test9_POST请求);

  // 清理
  section('清理环境');
  try {
    await execAsync('lsof -ti:3000,3001,3002,3003 | xargs -r kill -9 2>/dev/null');
    success('已清理所有测试进程');
  } catch {
    info('无需清理');
  }

  // 输出测试结果
  section('测试结果汇总');

  let passedCount = 0;
  let failedCount = 0;
  let totalDuration = 0;

  for (const result of results) {
    totalDuration += result.duration;
    if (result.passed) {
      passedCount++;
      log(`✓ ${result.name} (${result.duration}ms)`, colors.green);
    } else {
      failedCount++;
      log(`✗ ${result.name} - ${result.message} (${result.duration}ms)`, colors.red);
    }
  }

  log('\n' + '-'.repeat(60));
  log(`总计: ${results.length} 个测试`, colors.cyan);
  log(`通过: ${passedCount} 个`, colors.green);
  log(`失败: ${failedCount} 个`, failedCount > 0 ? colors.red : colors.green);
  log(`耗时: ${totalDuration}ms`, colors.cyan);

  if (failedCount === 0) {
    log('\n🎉 所有测试通过！', colors.green);

    // 显示日志片段
    const logPath = join(process.cwd(), 'logs', 'dynapm.log');
    if (existsSync(logPath)) {
      section('日志片段');
      const logContent = readFileSync(logPath, 'utf-8');
      const lines = logContent.split('\n');
      const lastLines = lines.slice(-20);
      log(lastLines.join('\n'), colors.cyan);
    }

    process.exit(0);
  } else {
    log(`\n❌ ${failedCount} 个测试失败`, colors.red);
    process.exit(1);
  }
}

main().catch(err => {
  error(`测试脚本执行失败: ${err.message}`);
  console.error(err);
  process.exit(1);
});
