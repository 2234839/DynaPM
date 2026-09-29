/**
 * WebSocket 客户端测试
 * 使用真正的 WebSocket 客户端测试网关的 WebSocket 代理功能
 */

import WebSocket from 'ws';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** 禁用代理的 execAsync 选项 */
const noProxyEnv = {
  env: {
    ...process.env,
    http_proxy: '',
    https_proxy: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '*',
    no_proxy: '*',
  },
};

/** 颜色输出 */
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

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

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 测试 WebSocket 连接
 */
async function testWebSocketConnection(): Promise<boolean> {
  return new Promise(async (resolve) => {
    info('连接到 WebSocket 服务器: ws://127.0.0.1:3000');

    // 设置 15 秒超时
    const timeout = setTimeout(() => {
      error('WebSocket 连接超时');
      ws.close();
      resolve(false);
    }, 15000);

    const ws = new WebSocket('ws://127.0.0.1:3000/', {
      headers: {
        'Host': 'ws.test',
      },
    });

    let testPassed = false;

    ws.on('open', () => {
      success('WebSocket 连接已建立');
      info('发送测试消息');

      // 发送 ping 消息
      ws.send(JSON.stringify({ type: 'ping' }));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        info(`收到消息: ${JSON.stringify(message)}`);

        if (message.type === 'connected') {
          success('收到连接确认消息');
          // 发送另一个测试消息
          ws.send(JSON.stringify({ type: 'test', data: 'hello' }));
        } else if (message.type === 'echo') {
          success('收到 echo 响应');
          testPassed = true;
          // 关闭连接
          ws.close();
        }
      } catch (err) {
        error(`解析消息失败: ${err}`);
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      info(`WebSocket 连接关闭: code=${code}, reason=${reason.toString()}`);
      resolve(testPassed);
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      error(`WebSocket 错误: ${err.message}`);
      resolve(false);
    });
  });
}

/**
 * 主函数
 */
async function main() {
  log('\n🚀 WebSocket 客户端测试', colors.blue);

  // 检查网关是否运行
  info('检查网关状态...');
  try {
    await execAsync('lsof -ti:3000 >/dev/null 2>&1', noProxyEnv);
    success('网关正在运行');
  } catch {
    error('网关未运行，请先启动网关: node dist/src/index.js');
    process.exit(1);
  }

  // 确保 WebSocket 服务离线
  info('确保 WebSocket 服务离线...');
  try {
    await execAsync('lsof -ti:3011 | xargs -r kill -9 2>/dev/null', noProxyEnv);
    await sleep(500);
    success('WebSocket 服务已停止');
  } catch {
    info('WebSocket 服务未运行');
  }

  // 运行测试
  log('\n开始测试...\n', colors.blue);

  const result = await testWebSocketConnection();

  // 输出结果
  log('\n' + '='.repeat(60), colors.blue);
  if (result) {
    success('WebSocket 测试通过！');
    process.exit(0);
  } else {
    error('WebSocket 测试失败');
    process.exit(1);
  }
}

main().catch(err => {
  error(`测试失败: ${err.message}`);
  console.error(err);
  process.exit(1);
});
