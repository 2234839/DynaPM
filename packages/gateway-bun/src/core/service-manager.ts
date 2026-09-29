import { CommandExecutor } from './command-executor.js';
import net from 'node:net';
import type { ServiceConfig } from '../config/types.js';

/** TCP 端口探测超时（毫秒） */
const TCP_PROBE_TIMEOUT = 100;

/**
 * 快速探测 TCP 端口是否可连接
 */
function probeTcpPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: TCP_PROBE_TIMEOUT }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * 从服务配置解析出目标端口（base 为 http(s) URL 时可解析）
 * 无法解析时返回 undefined，调用方回退到 check 命令
 */
function resolveServicePort(service: ServiceConfig): number | undefined {
  const base = service.base;
  if (!base) return undefined;
  const match = /^https?:\/\/[^/:]+:(\d+)/.exec(base);
  if (match) return parseInt(match[1]);
  /** 无显式端口：http=80 / https=443 */
  if (/^https:\/\//.test(base)) return 443;
  if (/^http:\/\//.test(base)) return 80;
  return undefined;
}

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
   * 端口可解析时优先用 TCP 探测短路（省一次 shell fork，约 3-10ms），
   * 端口通直接返回 true；端口不通或不可解析时回退执行 check 命令兜底
   * （check 可能携带非端口语义，如进程/文件检查）
   * @param service - 服务配置
   * @returns 服务是否运行中
   */
  async isRunning(service: ServiceConfig): Promise<boolean> {
    const port = resolveServicePort(service);
    if (port !== undefined && (await probeTcpPort(port))) {
      return true;
    }
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
    // 检查是否有正在进行的启动，循环等待而非递归避免栈溢出
    let lock = this.startingLocks.get(service.name);
    while (lock) {
      try {
        await lock;
        // 启动完成后，检查服务是否真的在线
        const isRunning = await this.isRunning(service);
        if (isRunning) {
          return;
        }
        // 启动失败，删除锁允许重试
        this.startingLocks.delete(service.name);
        break;
      } catch {
        // 启动失败，删除锁允许重试
        this.startingLocks.delete(service.name);
        break;
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
      /** 停止命令超时兜底（可配置注入）：挂起的 stop 命令不应阻塞整个停止流程 */
      timeout: service._timeouts?.stopTimeoutMs,
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
