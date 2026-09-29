import type { DynaPMConfig } from './types.js';

/**
 * c12 动态加载：bun build --compile 时不追踪其内部可选 peer 依赖（chokidar 等），
 * 运行时（bun run / 二进制内动态 require）均可正常加载
 */
async function loadC12Config(options: {
  name: string;
  configFile?: string;
  defaultConfig: unknown;
}): Promise<{ config: DynaPMConfig }> {
  const c12 = (await import('c12')) as unknown as {
    loadConfig: (opts: Record<string, unknown>) => Promise<{ config: DynaPMConfig }>;
  };
  return c12.loadConfig(options);
}

/**
 * 加载 DynaPM配置（宽松模式）—— Bun 版
 * 加载语义：DYNAPM_CONFIG 优先、
 * timeouts/adminApi 默认值兜底、路由生成与冲突校验。
 * @returns DynaPM 配置对象
 * @throws 当配置文件中至少需要一个服务时抛出错误
 */
export async function loadDynaPMConfig(): Promise<DynaPMConfig> {
  /** 支持通过环境变量指定配置文件路径：DYNAPM_CONFIG 环境变量指定配置文件路径 */
  const configFile = process.env.DYNAPM_CONFIG || undefined;

  const { config } = await loadC12Config({
    name: 'dynapm',
    configFile,
    defaultConfig: {
      port: 3000,
      host: '127.0.0.1',
      services: {},
      adminApi: {
        enabled: true,
        port: 4000,
      },
    },
  });

  /** timeouts 默认值兜底：与硬编码默认值一致 */
  config.timeouts = config.timeouts ?? {};
  config.timeouts.stopWaitMs = config.timeouts.stopWaitMs || 30 * 1000;
  config.timeouts.stopTimeoutMs = config.timeouts.stopTimeoutMs || 30 * 1000;
  config.timeouts.proxyTimeoutMs = config.timeouts.proxyTimeoutMs || 30 * 1000;

  /** adminApi 白名单兜底：仅在用户未配置时使用 */
  config.adminApi = config.adminApi ?? {};
  if (!config.adminApi.allowedIps) {
    config.adminApi.allowedIps = ['127.0.0.1', '::1'];
  }

  if (!config.services || Object.keys(config.services).length === 0) {
    throw new Error('配置文件中至少需要一个服务');
  }

  const mainPort = config.port || 3000;

  if (config.adminApi?.enabled && config.adminApi.port === mainPort) {
    throw new Error(`管理 API 端口 ${mainPort} 与主端口冲突`);
  }
  const portMap = new Map<number, string>();
  const hostnameMap = new Map<string, string>();

  for (const [key, service] of Object.entries(config.services)) {
    service.name = service.name || key;
    service.idleTimeout = service.idleTimeout || 5 * 60 * 1000;
    service.startTimeout = service.startTimeout || 30 * 1000;
    service._timeouts = config.timeouts;

    if (service.agent) {
      service.agent.maxSockets = service.agent.maxSockets || 256;
      service.agent.maxFreeSockets = service.agent.maxFreeSockets || 32;
      service.agent.keepAliveMsecs = service.agent.keepAliveMsecs || 30 * 1000;
    }
    if (service.keepWarm) {
      service.warmIdleTimeout = service.warmIdleTimeout || 30 * 1000;
    }
    service.healthCheck = service.healthCheck || { type: 'tcp' };

    if (service.healthCheck.type === 'http' && !service.healthCheck.url) {
      service.healthCheck.url = service.base;
    }

    let routes = service.routes;
    if (!routes || routes.length === 0) {
      routes = [];
      if (service.host) {
        routes.push({ type: 'host', value: service.host, target: service.base });
      }
      if (service.port) {
        routes.push({ type: 'port', value: service.port, target: service.base });
      }
      if (routes.length === 0) {
        routes.push({ type: 'host', value: key, target: service.base });
      }
      service.routes = routes;
    }

    for (const route of routes) {
      if (!route.target) {
        throw new Error(`服务 [${service.name}] 的路由配置缺少 target 字段`);
      }
    }

    for (const route of routes) {
      if (route.type === 'port') {
        const port = route.value as number;
        if (port === mainPort) {
          throw new Error(`服务 [${service.name}] 的路由端口 ${port} 与主端口冲突`);
        }
        const adminApiPort = config.adminApi?.enabled ? config.adminApi.port : undefined;
        if (adminApiPort && port === adminApiPort) {
          throw new Error(`服务 [${service.name}] 的路由端口 ${port} 与管理 API 端口冲突`);
        }
        const existingService = portMap.get(port);
        if (existingService) {
          throw new Error(
            `端口冲突: 服务 [${service.name}] 和 [${existingService}] 都配置了端口 ${port}`
          );
        }
        portMap.set(port, service.name);
      } else if (route.type === 'host') {
        const hostname = route.value as string;
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
