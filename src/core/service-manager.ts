import { CommandExecutor } from './command-executor.js';
import type { ServiceConfig } from '../config/types.js';

/**
 * 服务管理器
 * 负责服务的启动、停止和状态检查
 */
export class ServiceManager {
  private executor = new CommandExecutor();
  /** 启动锁，防止并发启动同一服务 */
  private startingLocks = new Map<string, Promise<void>>();

  /**
   * 检查服务是否运行中
   * @param service - 服务配置
   * @returns 服务是否运行中
   */
  async isRunning(service: ServiceConfig): Promise<boolean> {
    const result = await this.executor.check(service.commands.check, {
      cwd: service.commands.cwd,
      env: service.commands.env,
    });
    return result;
  }

  /**
   * 启动服务（带内存锁机制防止重复启动）
   * @param service - 服务配置
   * @throws 当启动失败时抛出错误
   */
  async start(service: ServiceConfig): Promise<void> {
    // 检查是否有正在进行的启动
    let lock = this.startingLocks.get(service.name);
    if (lock) {
      try {
        await lock;
        // 启动完成后，检查服务是否真的在线
        const isRunning = await this.isRunning(service);
        if (!isRunning) {
          // 启动失败，删除锁允许重试
          this.startingLocks.delete(service.name);
          // 递归重新启动
          return this.start(service);
        }
        return;
      } catch {
        // 启动失败，删除锁允许重试
        this.startingLocks.delete(service.name);
        // 继续执行下面的启动逻辑
      }
    }

    lock = (async () => {
      try {
        // 先检查服务是否已经在运行（避免重复启动）
        const alreadyRunning = await this.isRunning(service);
        if (alreadyRunning) {
          console.log(`[${service.name}] 服务已在运行，跳过启动`);
          return;
        }

        console.log(`[${service.name}] 正在启动...`);

        const result = await this.executor.execute(service.commands.start, {
          cwd: service.commands.cwd,
          env: service.commands.env,
          timeout: service.startTimeout,
        });

        if (result.exitCode !== 0) {
          throw new Error(
            `启动失败: ${result.stderr}\n${result.stdout}`
          );
        }

        // 启动命令执行成功，立即返回（健康检查会快速重试确认可用）
        console.log(`[${service.name}] 启动命令已执行`);

      } finally {
        this.startingLocks.delete(service.name);
      }
    })();

    this.startingLocks.set(service.name, lock);
    await lock;
  }

  /**
   * 停止服务
   * @param service - 服务配置
   * @throws 当停止失败时抛出错误
   */
  async stop(service: ServiceConfig): Promise<void> {
    console.log(`[${service.name}] 正在停止...`);

    const result = await this.executor.execute(service.commands.stop, {
      cwd: service.commands.cwd,
      env: service.commands.env,
    });

    if (result.exitCode !== 0) {
      console.error(`[${service.name}] 停止失败:`, result.stderr);
      // 停止失败，仍然更新状态为 offline（让系统可以重试）
      service._state!.status = 'offline';
      throw new Error(`停止失败: ${result.stderr}`);
    }

    console.log(`[${service.name}] 已停止`);
    service._state!.status = 'offline';
  }
}
