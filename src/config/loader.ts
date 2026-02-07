import { loadConfig } from 'c12';
import type { DynaPMConfig } from './types.js';

/**
 * 加载DynaPM配置（宽松模式）
 * @returns DynaPM配置对象
 * @throws 当配置文件中至少需要一个服务时抛出错误
 */
export async function loadDynaPMConfig(): Promise<DynaPMConfig> {
  const { config } = await loadConfig<DynaPMConfig>({
    name: 'dynapm',
    defaultConfig: {
      port: 3000,
      host: '127.0.0.1',
      services: {},
    },
  });

  // 宽松验证：只检查是否配置了服务
  if (!config.services || Object.keys(config.services).length === 0) {
    throw new Error('配置文件中至少需要一个服务');
  }

  // 设置默认值（宽松模式）
  for (const [hostname, service] of Object.entries(config.services)) {
    // 自动设置服务名称
    service.name = service.name || hostname;

    // 设置默认超时
    service.idleTimeout = service.idleTimeout || 5 * 60 * 1000; // 5分钟
    service.startTimeout = service.startTimeout || 30 * 1000; // 30秒

    // 默认使用TCP端口连通性检查（无需服务修改代码）
    service.healthCheck = service.healthCheck || { type: 'tcp' };

    // 如果配置了HTTP检查但没指定URL，使用服务base地址
    if (service.healthCheck.type === 'http' && !service.healthCheck.url) {
      service.healthCheck.url = service.base;
    }
  }

  return config;
}
