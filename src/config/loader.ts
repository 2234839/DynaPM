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
      adminApi: {
        enabled: true,
        port: 4000,
        allowedIps: ['127.0.0.1', '::1'],
      },
    },
  });

  // 宽松验证：至少需要一个服务
  if (!config.services || Object.keys(config.services).length === 0) {
    throw new Error('配置文件中至少需要一个服务');
  }

  const mainPort = config.port || 3000;

  // 检查管理 API 端口与主端口冲突
  if (config.adminApi?.enabled && config.adminApi.port === mainPort) {
    throw new Error(`管理 API 端口 ${mainPort} 与主端口冲突`);
  }
  const portMap = new Map<number, string>(); // 端口 -> 服务名称
  const hostnameMap = new Map<string, string>(); // hostname -> 服务名称

  // 处理所有服务配置
  for (const [key, service] of Object.entries(config.services)) {
    // 设置服务名称
    service.name = service.name || key;

    // 设置默认超时
    service.idleTimeout = service.idleTimeout || 5 * 60 * 1000; // 5分钟
    service.startTimeout = service.startTimeout || 30 * 1000; // 30秒

    // 默认使用TCP端口连通性检查（无需服务修改代码）
    service.healthCheck = service.healthCheck || { type: 'tcp' };

    // 如果配置了HTTP检查但没指定URL，使用服务base地址
    if (service.healthCheck.type === 'http' && !service.healthCheck.url) {
      service.healthCheck.url = service.base;
    }

    // 处理路由配置
    let routes = service.routes;

    // 如果没有配置 routes，则根据 host 和 port 生成简化配置
    if (!routes || routes.length === 0) {
      routes = [];

      // 添加 host 配置（使用 service.base 作为目标）
      if (service.host) {
        routes.push({ type: 'host', value: service.host, target: service.base });
      }

      // 添加 port 配置（使用 service.base 作为目标）
      if (service.port) {
        routes.push({ type: 'port', value: service.port, target: service.base });
      }

      // 如果既没有 host 也没有 port，则使用 key 作为默认 hostname
      if (routes.length === 0) {
        routes.push({ type: 'host', value: key, target: service.base });
      }

      // 保存生成的 routes
      service.routes = routes;
    }

    // 验证路由配置必须有 target 字段
    for (const route of routes) {
      if (!route.target) {
        throw new Error(`服务 [${service.name}] 的路由配置缺少 target 字段`);
      }
    }

    // 验证和检查路由配置
    for (const route of routes) {
      if (route.type === 'port') {
        const port = route.value as number;

        // 检查是否与主端口冲突
        if (port === mainPort) {
          throw new Error(`服务 [${service.name}] 的路由端口 ${port} 与主端口冲突`);
        }

        // 检查是否与管理 API 端口冲突
        const adminApiPort = config.adminApi?.enabled ? config.adminApi.port : undefined;
        if (adminApiPort && port === adminApiPort) {
          throw new Error(`服务 [${service.name}] 的路由端口 ${port} 与管理 API 端口冲突`);
        }

        // 检查是否与其他服务的端口冲突
        const existingService = portMap.get(port);
        if (existingService) {
          throw new Error(
            `端口冲突: 服务 [${service.name}] 和 [${existingService}] 都配置了端口 ${port}`
          );
        }

        portMap.set(port, service.name);
      } else if (route.type === 'host') {
        const hostname = route.value as string;

        // 检查 hostname 冲突
        const existingService = hostnameMap.get(hostname);
        if (existingService && existingService !== service.name) {
          throw new Error(
            `Hostname 冲突: 服务 [${service.name}] 和 [${existingService}] 都配置了 hostname ${hostname}`
          );
        }

        hostnameMap.set(hostname, service.name);
      }
    }
  }

  return config;
}
