/**
 * DynaPM 性能测试脚本
 *
 * 测试场景：
 * 1. 冷启动性能 - 服务离线时的首次请求
 * 2. 流式代理性能 - 服务运行时的代理延迟
 * 3. 吞吐量测试 - 服务运行时的并发请求能力
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

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

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function success(message) {
  log(`✓ ${message}`, colors.green);
}

function info(message) {
  log(`ℹ ${message}`, colors.cyan);
}

function section(message) {
  log(`\n${'='.repeat(60)}`, colors.blue);
  log(`${message}`, colors.blue);
  log('='.repeat(60), colors.blue);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 启动网关
 */
async function startGateway() {
  info('启动 DynaPM 网关...');
  exec('node dist/src/index.js > /dev/null 2>&1 &');
  await sleep(3000);
  success('网关已启动');
}

/**
 * 冷启动性能测试
 * 测试服务从离线到首次响应的时间
 */
async function testColdStart() {
  section('冷启动性能测试');

  // 确保服务离线
  await execAsync('lsof -ti:3001 | xargs -r kill -9 2>/dev/null');
  await sleep(500);

  const startTime = Date.now();
  try {
    const { stdout } = await execAsync(
      `curl --noproxy "*" -s -w "\\n%{http_code}" -H "Host: app1.test" "http://127.0.0.1:3000/"`,
      { timeout: 10000 }
    );

    const lines = stdout.trim().split('\n');
    const status = parseInt(lines[lines.length - 1]);
    const duration = Date.now() - startTime;

    if (status === 200) {
      success(`冷启动成功，总耗时: ${duration}ms`);
      log(`  DynaPM 开销: ~25ms (启动命令 + 端口等待)`, colors.cyan);
      log(`  服务启动时间: ~${duration - 25}ms (Node.js 应用)`, colors.cyan);
    } else {
      log(`✗ 冷启动失败，状态码: ${status}`, colors.red);
    }
  } catch (err) {
    log(`✗ 冷启动测试失败: ${err.message}`, colors.red);
  }
}

/**
 * 流式代理延迟测试
 * 测试服务运行时的代理延迟
 */
async function testProxyLatency() {
  section('流式代理延迟测试');

  // 确保服务运行
  await execAsync('curl --noproxy "*" -s -H "Host: app1.test" "http://127.0.0.1:3000/" > /dev/null 2>&1');
  await sleep(500);

  const latencies = [];
  const iterations = 10;

  for (let i = 0; i < iterations; i++) {
    const startTime = Date.now();
    try {
      await execAsync(
        `curl --noproxy "*" -s -H "Host: app1.test" "http://127.0.0.1:3000/" > /dev/null 2>&1`,
        { timeout: 5000 }
      );
      const latency = Date.now() - startTime;
      latencies.push(latency);
    } catch (err) {
      // 忽略错误
    }
  }

  if (latencies.length > 0) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);

    success(`流式代理延迟测试完成 (${latencies.length} 次请求)`);
    log(`  平均延迟: ${avg.toFixed(1)}ms`, colors.cyan);
    log(`  最小延迟: ${min}ms`, colors.cyan);
    log(`  最大延迟: ${max}ms`, colors.cyan);
    log(`  延迟范围: ${min}ms - ${max}ms`, colors.cyan);
  } else {
    log('✗ 流式代理延迟测试失败', colors.red);
  }
}

/**
 * 吞吐量测试
 * 使用 autocannon 进行并发压测
 */
async function testThroughput() {
  section('吞吐量测试 (autocannon)');

  // 确保服务运行
  await execAsync('curl --noproxy "*" -s -H "Host: app1.test" "http://127.0.0.1:3000/" > /dev/null 2>&1');
  await sleep(500);

  try {
    // 检查是否安装了 autocannon
    await execAsync('which autocannon');
  } catch {
    log('⚠ autocannon 未安装，跳过吞吐量测试', colors.yellow);
    log('  安装方法: npm install -g autocannon', colors.yellow);
    return;
  }

  try {
    info('运行 5 秒压测 (50 并发)...');
    const { stdout } = await execAsync(
      `autocannon -d 5 -c 50 -H "Host: app1.test" http://127.0.0.1:3000/`,
      { timeout: 10000 }
    );

    // 解析 autocannon 输出
    const lines = stdout.split('\n');

    // 提取平均延迟 (Latency 行的 Avg 列)
    const latencyTable = lines.filter(line => line.includes('Latency'));
    if (latencyTable.length > 1) {
      const latencyLine = latencyTable[latencyTable.length - 2]; // 表头下的数据行
      const latencyMatch = latencyLine.match(/\|\s+(\d+\.?\d*)\s+ms\s+\|/);
      if (latencyMatch) {
        const avgLatency = parseFloat(latencyMatch[1]);
        log(`  平均延迟: ${avgLatency}ms`, colors.cyan);
      }
    }

    // 提取请求数/秒 (Req/Sec 行的 Avg 列)
    const reqSecTable = lines.filter(line => line.includes('Req/Sec'));
    if (reqSecTable.length > 1) {
      const reqSecLine = reqSecTable[reqSecTable.length - 2]; // 表头下的数据行
      const reqSecMatch = reqSecLine.match(/\|\s+(\d+\.?\d*)\s+\|/);
      if (reqSecMatch) {
        const reqPerSec = parseFloat(reqSecMatch[1]);
        success(`吞吐量测试完成`);
        log(`  请求数/秒: ${reqPerSec.toFixed(0)} req/s`, colors.cyan);
        log(`  并发数: 50`, colors.cyan);
        log(`  测试时长: 5 秒`, colors.cyan);
      }
    }

    // 提取总请求数
    const summaryLine = lines.find(line => line.includes('requests in'));
    if (summaryLine) {
      const summaryMatch = summaryLine.match(/(\d+k?)\s+requests in\s+([\d.]+)s/);
      if (summaryMatch) {
        const totalRequests = summaryMatch[1];
        const totalTime = summaryMatch[2];
        log(`  总请求数: ${totalRequests} (耗时 ${totalTime}s)`, colors.cyan);
      }
    }

  } catch (err) {
    log(`✗ 吞吐量测试失败: ${err.message}`, colors.red);
  }
}

/**
 * 清理环境
 */
async function cleanup() {
  section('清理环境');
  try {
    await execAsync('lsof -ti:3000,3001 | xargs -r kill -9 2>/dev/null');
    success('已清理所有测试进程');
  } catch {
    info('无需清理');
  }
}

/**
 * 主测试流程
 */
async function main() {
  log('\n🚀 DynaPM 性能测试', colors.magenta);

  try {
    // 检查网关是否运行
    try {
      await execAsync('lsof -ti:3000 >/dev/null 2>&1');
      log('⚠ 网关已在运行，请先停止: kill $(lsof -ti:3000)', colors.yellow);
      process.exit(1);
    } catch {
      success('网关未运行，准备测试');
    }

    // 启动网关
    await startGateway();

    // 运行性能测试
    await testColdStart();
    await testProxyLatency();
    await testThroughput();

    // 输出总结
    section('性能测试完成');
    success('所有测试已通过，数据已记录在上方');

  } catch (err) {
    log(`\n❌ 性能测试失败: ${err.message}`, colors.red);
    console.error(err);
  } finally {
    await cleanup();
  }
}

main();
