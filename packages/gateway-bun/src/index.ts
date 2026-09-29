import { BunGateway } from './core/gateway.js';
import { createFatalErrorHandler } from './core/fatal-error-handler.js';
import { loadDynaPMConfig } from './config/loader.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 简单结构化日志（Bun 版不依赖 pino：输出 [ModelRep-Bun] 前缀 JSON 行到 stdout，
 * 兼容 pino 风格的 { msg } 调用）
 */
function createLogger() {
  const emit = (level: string) => (obj: { msg: string; error?: unknown; service?: string }) => {
    const line = {
      level,
      time: new Date().toISOString(),
      msg: obj.msg,
      ...(obj.error !== undefined ? { error: obj.error } : {}),
    };
    if (level === 'error') {
      console.error(JSON.stringify(line));
    } else if (level === 'warn') {
      console.warn(JSON.stringify(line));
    } else {
      console.log(JSON.stringify(line));
    }
  };
  return {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

/**
 * ModelRep（原 DynaPM）Bun 版主函数
 */
async function main() {
  const logger = createLogger();

  const gatewayRef: { current: BunGateway | null } = { current: null };
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

  logger.info({ msg: 'ModelRep-Bun 网关启动中...' });

  try {
    const config = await loadDynaPMConfig();
    const gateway = new BunGateway(config, logger);
    gatewayRef.current = gateway;
    await gateway.start();

    logger.info({ msg: 'ModelRep-Bun 网关已启动', service: String(config.port || 3000) });

    const cleanup = async (signal: string) => {
      logger.info({ msg: `⚠️ 收到 ${signal} 信号，正在清理...` });
      await gateway.cleanup();
      process.exit(0);
    };

    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('exit', () => {
      logger.info({ msg: '👋 ModelRep-Bun 网关已退出' });
    });
  } catch (error) {
    logger.error({ msg: '启动失败', error });
    process.exit(1);
  }
}

/** 保证 logs 目录存在（与 Node 版行为一致） */
try {
  mkdirSync(join(process.cwd(), 'logs'), { recursive: true });
} catch {
  // 目录可能已存在
}

main();
