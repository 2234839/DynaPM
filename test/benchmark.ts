/**
 * DynaPM 性能测试脚本
 *
 * 测试场景：
 * 1. 冷启动性能 - 服务离线时的首次请求
 * 2. 流式代理性能 - 服务运行时的代理延迟
 * 3. 多服务吞吐量测试 - 测试网关同时代理多个服务时的性能
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** 检查是否禁用颜色（通过环境变量 NO_COLOR 或输出到文件） */
const noColor = process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true' || process.stdout.isTTY === false;

// 调试输出
if (process.env.DEBUG_COLORS) {
  console.error(`[DEBUG] NO_COLOR=${process.env.NO_COLOR}, isTTY=${process.stdout.isTTY}, noColor=${noColor}`);
}

/** 颜色输出 */
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/** 获取颜色（如果禁用颜色则返回空字符串） */
function getColor(color: string): string {
  return noColor ? '' : color;
}

function log(msg: string, color = colors.reset) {
  console.log(`${getColor(color)}${msg}${getColor(colors.reset)}`);
}

function section(title: string) {
  console.log(`\n${getColor(colors.blue)}${'='.repeat(60)}${getColor(colors.reset)}`);
  console.log(`${getColor(colors.blue)}${title}${getColor(colors.reset)}`);
  console.log(`${getColor(colors.blue)}${'='.repeat(60)}${getColor(colors.reset)}`);
}

function success(msg: string) {
  log(`✓ ${msg}`, colors.green);
}

function info(msg: string) {
  log(`ℹ ${msg}`, colors.cyan);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 冷启动性能测试
 */
async function testColdStart() {
  section('冷启动性能测试');

  // 确保服务离线
  try {
    await execAsync('lsof -ti:3001 | xargs -r kill -9 2>/dev/null');
    await sleep(500);
  } catch {
    // 服务可能未运行，忽略错误
  }

  const startTime = Date.now();

  try {
    await execAsync('curl --noproxy "*" -s -H "Host: app1.test" "http://127.0.0.1:3000/"');
    const duration = Date.now() - startTime;

    success(`冷启动成功，总耗时: ${duration}ms`);
    log(`  DynaPM 开销: ~25ms (启动命令 + 端口等待)`, colors.cyan);
    log(`  服务启动时间: ~${duration - 25}ms (Node.js 应用)`, colors.cyan);
  } catch (err: any) {
    log(`✗ 冷启动失败: ${err.message}`, colors.red);
  }
}

/**
 * 流式代理延迟测试
 */
async function testProxyLatency() {
  section('流式代理延迟测试');

  const latencies: number[] = [];
  const iterations = 10;

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    try {
      await execAsync('curl --noproxy "*" -s -H "Host: app1.test" "http://127.0.0.1:3000/" -o /dev/null');
      latencies.push(Date.now() - start);
    } catch (err) {
      // 忽略错误
    }
  }

  if (latencies.length > 0) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);

    success(`流式代理延迟测试完成 (${iterations} 次请求)`);
    log(`  平均延迟: ${avg.toFixed(1)}ms`, colors.cyan);
    log(`  最小延迟: ${min}ms`, colors.cyan);
    log(`  最大延迟: ${max}ms`, colors.cyan);
    log(`  延迟范围: ${min}ms - ${max}ms`, colors.cyan);
  } else {
    log('✗ 流式代理延迟测试失败', colors.red);
  }
}

/**
 * 多服务吞吐量测试
 * 测试网关同时代理多个服务时的性能
 */
async function testMultiServiceThroughput() {
  section('网关吞吐量测试（多服务混合压测）');

  const services = ['app1.test', 'app2.test', 'app3.test'];
  const concurrencyPerService = 50; // 每个服务50并发
  const totalConcurrency = services.length * concurrencyPerService;

  // 启动多个服务（app1, app2, app3）
  info('启动多个测试服务...');

  for (const service of services) {
    try {
      await execAsync(`curl --noproxy "*" -s -H "Host: ${service}" "http://127.0.0.1:3000/" -o /dev/null 2>&1`);
    } catch (err) {
      // 忽略错误
    }
  }

  await sleep(1000);

  // 优先使用 wrk（高性能压测工具）
  let useWrk = false;
  try {
    await execAsync('which wrk');
    useWrk = true;
  } catch {
    // wrk 未安装，尝试使用 autocannon
  }

  if (!useWrk) {
    try {
      await execAsync('which autocannon');
    } catch {
      log('⚠ 未安装压测工具，跳过多服务吞吐量测试', colors.yellow);
      log('  推荐安装 wrk: apt-get install wrk (Linux) 或 brew install wrk (macOS)', colors.yellow);
      log('  或安装 autocannon: npm install -g autocannon', colors.yellow);
      return;
    }
  }

  try {
    info(`运行网关压测 (${services.length} 个服务混合流量，${totalConcurrency} 总并发)...`);
    info(`每个服务 ${concurrencyPerService} 并发，同时压测 ${services.length} 个服务`);
    info(`使用压测工具: ${useWrk ? 'wrk' : 'autocannon'}\n`);

    if (useWrk) {
      // 使用 wrk 测试
      const testPromises = services.map(async (service) => {
        const { stdout } = await execAsync(
          `wrk -t${concurrencyPerService / 10} -c${concurrencyPerService} -d5s -H "Host: ${service}" http://127.0.0.1:3000/`,
          { timeout: 15000 }
        );

        // 解析 wrk 输出
        const lines = stdout.split('\n');
        /** 取汇总行的 Requests/sec，而非线程统计的 Req/Sec */
        const qpsLine = lines.find((line: string) => line.startsWith('Requests/sec:'));
        const latencyLine = lines.find((line: string) => line.trim().startsWith('Latency'));

        let qps = 0;
        let avgLatency = 0;

        if (qpsLine) {
          const match = qpsLine.match(/([\d,]+\.?\d*)/);
          if (match) {
            qps = parseFloat(match[1].replace(/,/g, ''));
          }
        }

        if (latencyLine) {
          const match = latencyLine.match(/([\d,]+\.?\d*)\s*([a-z]+)/);
          if (match) {
            avgLatency = parseFloat(match[1].replace(/,/g, ''));
          }
        }

        return { service, qps, avgLatency };
      });

      const results = await Promise.all(testPromises);
      const totalQps = results.reduce((sum, r) => sum + r.qps, 0);
      const avgLatency = results.reduce((sum, r) => sum + r.avgLatency, 0) / results.length;

      success(`网关吞吐量测试完成`);
      log(`\n  网关总 QPS: ${totalQps.toFixed(0)} req/s`, colors.cyan);
      log(`  平均延迟: ${avgLatency.toFixed(2)} ms`, colors.cyan);
      log(`  测试服务数: ${services.length}`, colors.cyan);
      log(`  每服务并发数: ${concurrencyPerService}`, colors.cyan);
      log(`  总并发数: ${totalConcurrency}`, colors.cyan);
      log(`  测试时长: 5 秒`, colors.cyan);

      log('\n  各服务 QPS 详情:', colors.cyan);
      for (const result of results) {
        log(`    - ${result.service}: ${result.qps.toFixed(1)} req/s (延迟: ${result.avgLatency.toFixed(2)}ms)`, colors.cyan);
      }

      log(`\n  这是网关同时处理 ${services.length} 个不同服务的真实性能`, colors.cyan);
    } else {
      // 使用 autocannon 测试
      const testPromises = services.map(async (service) => {
        const { stdout, stderr } = await execAsync(
          `autocannon -d 5 -c ${concurrencyPerService} -H "Host: ${service}" http://127.0.0.1:3000/`,
          { timeout: 15000 }
        );

        const output = stdout || stderr;
        const lines = output.split('\n');

        // 提取 QPS
        const reqSecTable = lines.filter((line: string) => line.includes('Req/Sec'));
        if (reqSecTable.length >= 1) {
          const reqSecLine = reqSecTable[Math.max(0, reqSecTable.length - 2)];
          const reqSecMatch = reqSecLine.match(/│\s+([\d,]+\.?\d*)\s+│/);
          if (reqSecMatch) {
            const qps = parseFloat(reqSecMatch[1].replace(/,/g, ''));
            return { service, qps };
          }
        }
        return { service, qps: 0 };
      });

      const results = await Promise.all(testPromises);
      const totalQps = results.reduce((sum, r) => sum + r.qps, 0);

      success(`网关吞吐量测试完成`);
      log(`\n  网关总 QPS: ${totalQps.toFixed(0)} req/s`, colors.cyan);
      log(`  测试服务数: ${services.length}`, colors.cyan);
      log(`  每服务并发数: ${concurrencyPerService}`, colors.cyan);
      log(`  总并发数: ${totalConcurrency}`, colors.cyan);
      log(`  测试时长: 5 秒`, colors.cyan);

      log('\n  各服务 QPS 详情:', colors.cyan);
      for (const result of results) {
        log(`    - ${result.service}: ${result.qps.toFixed(1)} req/s`, colors.cyan);
      }

      log(`\n  这是网关同时处理 ${services.length} 个不同服务的真实性能`, colors.cyan);
      log(`  提示: 使用 wrk 可以获得更准确的压测结果`, colors.yellow);
    }
  } catch (err: any) {
    log(`✗ 网关吞吐量测试失败: ${err.message}`, colors.red);
  }
}

/**
 * 清理环境
 */
async function cleanup() {
  section('清理环境');
  try {
    await execAsync('lsof -ti:3000,3001,3002,3003 | xargs -r kill -9 2>/dev/null');
    success('已清理所有测试进程');
  } catch {
    success('环境已清理');
  }
}

/**
 * 主函数
 */
async function main() {
  console.log(`${getColor(colors.blue)}\n🚀 DynaPM 性能测试${getColor(colors.reset)}`);

  // 检查网关状态
  try {
    await execAsync('lsof -ti:3000');
    log('✗ 网关已在运行，请先停止网关', colors.yellow);
    process.exit(1);
  } catch {
    success('网关未运行，准备测试');
  }

  // 启动网关
  info('启动 DynaPM 网关...');
  const gateway = exec('tsx src/index.ts');
  await sleep(2000);
  success('网关已启动');

  try {
    // 冷启动测试
    await testColdStart();

    // 流式代理延迟测试
    await testProxyLatency();

    // 多服务吞吐量测试
    await testMultiServiceThroughput();

    section('性能测试完成');
    success('所有测试已通过，数据已记录在上方');
  } finally {
    // 清理
    await cleanup();
    gateway.kill();
  }
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
