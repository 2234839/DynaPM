import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** 命令执行结果 */
export interface CommandResult {
  /** 标准输出 */
  stdout: string;
  /** 标准错误输出 */
  stderr: string;
  /** 退出码 */
  exitCode: number;
}

/** 命令执行选项 */
export interface CommandOptions {
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * Bash命令执行器
 * 用于执行bash命令并获取结果
 */
export class CommandExecutor {
  /**
   * 执行命令并返回结果
   * @param command - 要执行的bash命令
   * @param options - 执行选项
   * @returns 命令执行结果
   */
  async execute(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeout || 30000,
      });

      return { stdout, stderr, exitCode: 0 };
    } catch (error: any) {
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        exitCode: error.code || 1,
      };
    }
  }

  /**
   * 检查命令执行是否成功（退出码为0）
   * @param command - 要执行的bash命令
   * @param options - 执行选项
   * @returns 命令是否执行成功
   */
  async check(command: string, options?: CommandOptions): Promise<boolean> {
    const result = await this.execute(command, options);
    return result.exitCode === 0;
  }
}
