import fetch from 'node-fetch';
import { CommandExecutor } from './command-executor.js';
import type { ServiceConfig, HealthCheckConfigInternal } from '../config/types.js';
import net from 'node:net';

/**
 * 健康检查器
 * 支持TCP端口、HTTP和自定义命令三种检查方式
 */
export class HealthChecker {
  private executor = new CommandExecutor();

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

    const startTime = Date.now();
    const timeout = service.startTimeout;

    while (Date.now() - startTime < timeout) {
      const isHealthy = await this.check(service, healthCheck);
      if (isHealthy) {
        return;
      }

      // TCP检查失败立即重试，不等待（快速失败快速重试）
    }

    throw new Error(`服务启动超时 (${timeout}ms)`);
  }

  /**
   * 执行健康检查
   * @param service - 服务配置
   * @param config - 健康检查配置
   * @returns 服务是否健康
   */
  private async check(service: ServiceConfig, config: HealthCheckConfigInternal): Promise<boolean> {
    try {
      switch (config.type) {
        case 'tcp':
          return await this.checkTcp(service);

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
   * TCP端口连通性检查（使用socket原生超时）
   * @param service - 服务配置
   * @returns 端口是否可连接
   */
  private async checkTcp(service: ServiceConfig): Promise<boolean> {
    const url = new URL(service.base);
    const host = url.hostname;
    const port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'));

    return new Promise((resolve) => {
      const socket = net.createConnection(
        { host, port, timeout: 200 },
        () => {
          socket.destroy();
          resolve(true);
        }
      );

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
