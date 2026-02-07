import fastify from 'fastify';
import reply from '@fastify/reply-from';
import { ServiceManager } from './service-manager.js';
import type { ServiceConfig, DynaPMConfig } from '../config/types.js';
import net from 'node:net';

/**
 * 格式化时间（毫秒转换为易读格式）
 */
function formatTime(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * 快速检查 TCP 端口是否可用
 */
async function checkTcpPort(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'));

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 100 }, () => {
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
 * DynaPM网关
 * 负责请求拦截、服务启动和反向代理
 */
export class Gateway {
  private app = fastify();
  private serviceManager = new ServiceManager();
  /** 服务映射：hostname -> 服务配置 */
  private services: Map<string, ServiceConfig> = new Map();

  constructor(private config: DynaPMConfig) {
    this.initServices();
    this.initMiddleware();
    this.initRoutes();
    this.initIdleChecker();
  }

  /**
   * 初始化服务映射
   */
  private initServices(): void {
    for (const [hostname, service] of Object.entries(this.config.services)) {
      service._state = {
        status: 'offline',
        lastAccessTime: Date.now(),
      };
      this.services.set(hostname, service);
    }
  }

  /**
   * 初始化中间件
   */
  private initMiddleware(): void {
    this.app.register(reply, {});
  }

  /**
   * 初始化路由
   */
  private initRoutes(): void {
    this.app.all('*', {}, async (request, reply) => {
      const startTime = Date.now();
      (request as any).startTime = startTime;
      const hostname = request.hostname;
      const method = request.method;
      const url = request.url;

      // 记录请求信息（只在需要启动时记录详细信息）
      const service = this.services.get(hostname);

      if (!service) {
        console.log(`❌ [${hostname}] ${method} ${url} - 404`);
        return reply.status(404).send(`Service not found: ${hostname}`);
      }

      (request as any).service = service;

      // 更新访问时间
      service._state!.lastAccessTime = Date.now();

      // 根据内存状态判断是否需要启动（避免每次执行 bash 命令）
      const needsStart = service._state!.status === 'offline';

      if (needsStart) {
        const startStartTime = Date.now();
        console.log(`🚀 [${service.name}] ${method} ${url} - 启动服务...`);
        service._state!.status = 'starting';
        await this.serviceManager.start(service);

        // 快速等待端口可用（流式转发替代健康检查）
        const waitStartTime = Date.now();
        while (Date.now() - waitStartTime < service.startTimeout) {
          const isReady = await checkTcpPort(service.base);
          if (isReady) {
            const waitDuration = Date.now() - waitStartTime;
            const totalDuration = Date.now() - startStartTime;
            console.log(`✅ [${service.name}] 服务就绪 (启动${formatTime(totalDuration - waitDuration)}, 等待${formatTime(waitDuration)})`);
            break;
          }
          // 失败立即重试，不等待
        }

        service._state!.status = 'online';
      }

      // 反向代理（流式转发）
      return reply.from(service.base + request.url);
    });

    // 添加响应日志的钩子
    this.app.addHook('onResponse', async (request, reply) => {
      const responseTime = Date.now() - (request as any).startTime;
      const service = (request as any).service;
      if (service) {
        console.log(`📤 [${service.name}] ${request.method} ${request.url} - ${reply.statusCode} - ${formatTime(responseTime)}`);
      }
    });
  }

  /**
   * 初始化闲置检查器
   * 定期检查并停止闲置的服务
   */
  private initIdleChecker(): void {
    setInterval(() => {
      const now = Date.now();

      for (const service of this.services.values()) {
        if (
          service._state!.status === 'online' &&
          now - service._state!.lastAccessTime > service.idleTimeout
        ) {
          console.log(`🛌 [${service.name}] 闲置超时，正在停止...`);
          this.serviceManager.stop(service).catch((err: Error) => {
            console.error(`❌ [${service.name}] 停止失败:`, err.message);
          });
          service._state!.status = 'offline';
        }
      }
    }, 3000);
  }

  /**
   * 启动网关
   */
  async start(): Promise<void> {
    const host = this.config.host || '127.0.0.1';
    const port = this.config.port || 3000;

    await this.app.listen({ port, host });
    console.log(`DynaPM 网关已启动: http://${host}:${port}`);
  }
}
