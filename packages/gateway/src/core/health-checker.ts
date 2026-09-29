import { CommandExecutor } from './command-executor.js';
import type { ServiceConfig, HealthCheckConfigInternal } from '../config/types.js';
import net from 'node:net';

/** TCP 端口检查超时（毫秒），与网关原有快速失败语义一致 */
const TCP_CHECK_TIMEOUT = 100;

/**
 * 快速检查 TCP 端口是否可用
 * 使用原生 socket 超时快速失败，供网关就绪等待循环高频调用
 */
export function checkTcpPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: TCP_CHECK_TIMEOUT }, () => {
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
 * 健康检查器
 * 支持TCP端口、HTTP和自定义命令三种检查方式
 */
export class HealthChecker {
  private executor = new CommandExecutor();

  /**
   * 对指定目标执行单次健康检查（按服务 healthCheck.type 分派，默认 tcp）
   * 默认 tcp 分支与网关原有裸 TCP 轮询实现完全一致（100ms socket 超时、无 sleep），保证冷启动性能不回退
   */
  async checkTarget(service: ServiceConfig, targetHost: string, targetPort: number): Promise<boolean> {
    const healthCheck = service.healthCheck;
    if (!healthCheck || healthCheck.type === 'none' || healthCheck.type === 'tcp') {
      return checkTcpPort(targetHost, targetPort);
    }
    return this.check(service, healthCheck, targetHost, targetPort);
  }

  /**
   * 等待服务健康（快速轮询）
   * @param service - 服务配置
   * @throws 当服务启动超时时抛出错误
   */
  async wait(service: ServiceConfig): Promise<void> {
    const healthCheck = service.healthCheck;
    if (!healthCheck || healthCheck.type === 'none') {
      return;
    }

    /** 预解析 URL，避免循环内重复 new URL() */
    const targetUrl = new URL(service.base);
    const targetHost = targetUrl.hostname;
    const targetPort = parseInt(targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80'));

    const startTime = Date.now();
    const timeout = service.startTimeout;

    while (Date.now() - startTime < timeout) {
      const isHealthy = await this.check(service, healthCheck, targetHost, targetPort);
      if (isHealthy) {
        return;
      }

      /** TCP 检查间隔 50ms，避免无延迟轮询导致 CPU 空转 */
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error(`服务启动超时 (${timeout}ms)`);
  }

  /**
   * 执行健康检查
   * @param service - 服务配置
   * @param config - 健康检查配置
   * @param targetHost - 预解析的目标主机
   * @param targetPort - 预解析的目标端口
   * @returns 服务是否健康
   */
  private async check(service: ServiceConfig, config: HealthCheckConfigInternal, targetHost: string, targetPort: number): Promise<boolean> {
    try {
      switch (config.type) {
        case 'tcp':
          return await checkTcpPort(targetHost, targetPort);

        case 'http':
          return await this.checkHttp(config, service);

        case 'command':
          if (!config.command) {
            return false;
          }
          return await this.executor.check(config.command, {
            timeout: config.timeout || 5000,
          });

        default:
          return true;
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * HTTP健康检查
   * @param config - 健康检查配置
   * @param service - 服务配置
   * @returns HTTP响应是否符合预期
   */
  private async checkHttp(config: HealthCheckConfigInternal, service: ServiceConfig): Promise<boolean> {
    try {
      const url = config.url || service.base;
      const timeout = config.timeout || 5000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.status === (config.expectedStatus || 200);
    } catch (error) {
      return false;
    }
  }
}
