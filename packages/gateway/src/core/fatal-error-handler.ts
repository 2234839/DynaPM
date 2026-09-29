import type { Logger } from 'pino';

/**
 * 致命错误处理器
 * 记录错误 → 尽力执行 cleanup → 退出进程（exit 1）
 *
 * 提取为独立工厂函数以便注入 mock cleanup/exit 进行单元测试
 */

/**
 * 创建致命错误处理函数
 * 返回的函数可直接注册到 process.on('uncaughtException') / process.on('unhandledRejection')
 */
export function createFatalErrorHandler(
  /** 日志记录器 */
  logger: Pick<Logger, 'error'>,
  /** 网关清理函数（尽力执行，失败不阻断退出） */
  cleanup: () => Promise<void>,
  /** 进程退出函数（注入以便测试） */
  exit: (code: number) => void,
): (error: unknown, origin: string) => void {
  return (error: unknown, origin: string) => {
    const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    logger.error({ msg: `❌ 致命错误 (${origin})，进程将退出`, error: message });

    /** 尽力清理：cleanup 失败也必须退出 */
    Promise.resolve()
      .then(cleanup)
      .catch((cleanupErr: unknown) => {
        const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        logger.error({ msg: '❌ cleanup 执行失败，仍将退出进程', error: cleanupMsg });
      })
      .finally(() => {
        exit(1);
      });
  };
}
