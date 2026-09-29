import { Gateway } from './core/gateway.js';
import { createFatalErrorHandler } from './core/fatal-error-handler.js';
import { loadDynaPMConfig } from './config/loader.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

/**
 * 创建高性能日志系统
 * 使用 pino 异步日志，避免阻塞事件循环
 */
function createLogger() {
  // 创建 logs 目录（recursive: true 时目录已存在不会抛异常）
  const logDir = join(process.cwd(), 'logs');
  mkdirSync(logDir, { recursive: true });

  const logFile = join(logDir, 'dynapm.log');

  // 创建 pino logger（异步写入，性能优化）
  const logger = pino(
    {
      level: 'info',
      // 使用更简洁的时间格式
      timestamp: pino.stdTimeFunctions.isoTime,
      // 序列化错误对象
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
      // 不需要自定义的 key
      base: undefined,
    },
    pino.destination({
      dest: logFile,
      sync: false, // 异步写入（关键优化）
      minLength: 0, // 立即写入，不缓冲
    })
  );

  return logger;
}

/**
 * DynaPM主函数
 * 加载配置并启动网关
 */
async function main() {
  const logger = createLogger();

  // 全局错误处理：记录错误 → 尽力清理 → 退出进程（exit 1）
  const gatewayRef: { current: Gateway | null } = { current: null };
  const fatalHandler = createFatalErrorHandler(
    logger,
    async () => {
      const gateway = gatewayRef.current;
      if (gateway) {
        await gateway.cleanup();
      }
    },
    (code) => process.exit(code),
  );

  process.on('uncaughtException', (err: Error) => fatalHandler(err, 'uncaughtException'));

  process.on('unhandledRejection', (reason: unknown) => fatalHandler(reason, 'unhandledRejection'));

  // 启动日志
  logger.info({ msg: 'DynaPM 网关启动中...' });

  try {
    // 加载配置
    const config = await loadDynaPMConfig();

    // 创建并启动网关
    const gateway = new Gateway(config, logger);
    gatewayRef.current = gateway;
    await gateway.start();

    logger.info({ msg: 'DynaPM 网关已启动', port: config.port || 3000 });

    // 注册退出处理
    const cleanup = async (signal: string) => {
      logger.info({ msg: `⚠️ 收到 ${signal} 信号，正在清理...` });
      await gateway.cleanup();
      process.exit(0);
    };

    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('exit', () => {
      logger.info({ msg: '👋 DynaPM 网关已退出' });
    });
  } catch (error) {
    logger.error({ msg: '启动失败', error });
    process.exit(1);
  }
}

main();
