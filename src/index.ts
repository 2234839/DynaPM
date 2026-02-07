import { Gateway } from './core/gateway.js';
import { loadDynaPMConfig } from './config/loader.js';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 格式化时间为北京时间（UTC+8）
 */
function formatTimestamp(): string {
  // 获取 UTC 时间并转换为北京时间（UTC+8）
  const utcDate = new Date();
  const beijingDate = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000);

  const year = beijingDate.getFullYear();
  const month = String(beijingDate.getMonth() + 1).padStart(2, '0');
  const day = String(beijingDate.getDate()).padStart(2, '0');
  const hours = String(beijingDate.getHours()).padStart(2, '0');
  const minutes = String(beijingDate.getMinutes()).padStart(2, '0');
  const seconds = String(beijingDate.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 创建日志写入流
 */
function createLogger() {
  // 创建 logs 目录
  const logDir = join(process.cwd(), 'logs');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (err) {
    // 目录可能已存在
  }

  const logFile = join(logDir, 'dynapm.log');
  const stream = createWriteStream(logFile, { flags: 'w' }); // 改为 'w' 模式，每次启动清空旧日志

  // 重写 console.log 和 console.error
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: any[]) => {
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const timestamp = formatTimestamp();
    const logMessage = `[${timestamp}] ${message}\n`;

    originalLog(logMessage.trim());
    stream.write(logMessage);
  };

  console.error = (...args: any[]) => {
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const timestamp = formatTimestamp();
    const logMessage = `[${timestamp}] ERROR: ${message}\n`;

    originalError(logMessage.trim());
    stream.write(logMessage);
  };

  return stream;
}

/**
 * DynaPM主函数
 * 加载配置并启动网关
 */
async function main() {
  const logger = createLogger();

  try {
    // 加载配置
    const config = await loadDynaPMConfig();

    // 创建并启动网关
    const gateway = new Gateway(config);
    await gateway.start();
  } catch (error) {
    console.error('启动失败:', error);
    logger.end();
    process.exit(1);
  }
}

main();
