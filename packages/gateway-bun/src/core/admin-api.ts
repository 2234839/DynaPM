import type { ServiceConfig, ServiceState } from '../config/types.js';
import type { ServiceManager } from './service-manager.js';
import type { BunGateway } from './gateway.js';
import { URL } from 'node:url';
import net from 'node:net';

/**
 * 路由映射信息（与 gateway.ts 内部定义结构一致）
 */
interface RouteMapping {
  /** 服务配置 */
  service: ServiceConfig;
  /** 目标后端地址 */
  target: string;
}

/**
 * 日志接口（pino 兼容最小集）
 */
interface LoggerLike {
  /** 信息日志 */
  info: (obj: { msg: string; error?: unknown }) => void;
  /** 警告日志 */
  warn: (obj: { msg: string; error?: unknown }) => void;
  /** 错误日志 */
  error: (obj: { msg: string; error?: unknown }) => void;
}

/**
 * 管理处理器 Bun 版：Request/Response 风格 API
 * 路由与语义与 Node 版 admin-api.ts 对齐（/_dynapm/*）
 */
export class AdminApiHandler {
  /** 按服务名称索引的服务配置（懒初始化） */
  private _serviceMap: Map<string, ServiceConfig> | undefined;
  /** 按服务名称索引的路由映射（懒初始化） */
  private _routeMap: Map<string, RouteMapping> | undefined;
  /** 网关引用（用于停止服务后清理连接池登记） */
  private gateway?: Pick<BunGateway, 'cleanupAgent'>;

  constructor(
    private config: { adminApi?: { enabled?: boolean; authToken?: string; allowedIps?: string[] } },
    private logger: LoggerLike,
    private hostnameRoutes: Map<string, RouteMapping>,
    private portRoutes: Map<number, RouteMapping>,
    private serviceManager: ServiceManager,
    gateway?: Pick<BunGateway, 'cleanupAgent'>,
  ) {
    this.gateway = gateway;
  }

  /** 获取（或首次构建）服务名称索引 */
  private getServiceMap(): Map<string, ServiceConfig> {
    if (!this._serviceMap) {
      const map = new Map<string, ServiceConfig>();
      for (const mapping of this.hostnameRoutes.values()) {
        map.set(mapping.service.name, mapping.service);
      }
      for (const mapping of this.portRoutes.values()) {
        if (!map.has(mapping.service.name)) {
          map.set(mapping.service.name, mapping.service);
        }
      }
      this._serviceMap = map;
    }
    return this._serviceMap;
  }

  /** 获取（或首次构建）路由映射索引 */
  private getRouteMap(): Map<string, RouteMapping> {
    if (!this._routeMap) {
      const map = new Map<string, RouteMapping>();
      for (const mapping of this.hostnameRoutes.values()) {
        if (!map.has(mapping.service.name)) {
          map.set(mapping.service.name, mapping);
        }
      }
      for (const mapping of this.portRoutes.values()) {
        if (!map.has(mapping.service.name)) {
          map.set(mapping.service.name, mapping);
        }
      }
      this._routeMap = map;
    }
    return this._routeMap;
  }

  /**
   * 检查客户端 IP 是否在允许列表中
   */
  private isIpAllowed(ip: string): boolean {
    if (!this.config.adminApi?.allowedIps || this.config.adminApi.allowedIps.length === 0) {
      return true;
    }
    return this.config.adminApi.allowedIps.includes(ip);
  }

  /**
   * 检查认证令牌是否有效
   */
  private isAuthenticated(authHeader: string | null): boolean {
    if (!this.config.adminApi?.authToken) {
      return true;
    }
    if (!authHeader) {
      return false;
    }
    const token = authHeader.replace('Bearer ', '');
    return token === this.config.adminApi.authToken;
  }

  /**
   * 获取服务运行时长
   */
  private getServiceUptime(service: ServiceConfig): number {
    if (service._state!.status === 'online' && service._state!.startTime) {
      return service._state!.totalUptime + (Date.now() - service._state!.startTime);
    }
    return service._state!.totalUptime;
  }

  /**
   * 在所有路由表中查找服务
   */
  private findServiceMapping(serviceName: string): RouteMapping | undefined {
    return this.getRouteMap().get(serviceName);
  }

  /**
   * 处理管理 API 请求（Bun 版入口）
   */
  async handleAdminApi(req: Request, remoteAddress?: { address: string } | null): Promise<Response> {
    /** 使用 Bun 提供的真实远端地址，不信任可伪造的 x-forwarded-for 头 */
    const ip = remoteAddress?.address ?? 'unknown';

    if (!this.isIpAllowed(ip)) {
      this.logger.warn({ msg: `🚫 [Admin API] 拒绝访问: ${ip}` });
      return new Response('Forbidden', { status: 403 });
    }

    if (!this.isAuthenticated(req.headers.get('authorization'))) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer' },
      });
    }

    const url = new URL(req.url);
    const method = req.method.toLowerCase();

    const apiPath = url.pathname;

    if (apiPath === '/_dynapm/api/services' && method === 'get') {
      return this.getServicesList();
    }
    if (apiPath.startsWith('/_dynapm/api/services/') && method === 'get') {
      const serviceName = apiPath.split('/')[4];
      return this.getServiceDetail(serviceName);
    }
    if (apiPath.endsWith('/stop') && method === 'post') {
      const serviceName = apiPath.split('/')[4];
      return this.stopService(serviceName);
    }
    if (apiPath.endsWith('/start') && method === 'post') {
      const serviceName = apiPath.split('/')[4];
      return this.startService(serviceName);
    }
    if (apiPath === '/_dynapm/api/events' && method === 'get') {
      return this.handleEventStream();
    }
    return new Response('Not Found', { status: 404 });
  }

  /**
   * 获取服务列表
   */
  private getServicesList(): Response {
    const services = Array.from(this.getServiceMap().values()).map((service) => {
      return {
        name: service.name,
        base: service.base,
        status: service._state!.status,
        uptime: this.getServiceUptime(service),
        lastAccessTime: service._state!.lastAccessTime,
        activeConnections: service._state!.activeConnections,
        idleTimeout: service.idleTimeout,
        proxyOnly: service.proxyOnly || false,
        pid: service._state!.pid,
      };
    });
    return Response.json({ services });
  }

  /**
   * 获取服务详情
   */
  private getServiceDetail(serviceName: string): Response {
    const mapping = this.findServiceMapping(serviceName);
    this.logger.info({ msg: `🔍 [Admin API] 查找服务: ${serviceName}, 找到: ${mapping?.service.name || 'null'}` });

    if (!mapping) {
      return Response.json({ error: 'Service not found' }, { status: 404 });
    }

    const service = mapping.service;
    const detail = {
      name: service.name,
      base: service.base,
      status: service._state!.status,
      uptime: this.getServiceUptime(service),
      lastAccessTime: service._state!.lastAccessTime,
      activeConnections: service._state!.activeConnections,
      idleTimeout: service.idleTimeout,
      startTimeout: service.startTimeout,
      proxyOnly: service.proxyOnly || false,
      pid: service._state!.pid,
      healthCheck: service.healthCheck || { type: 'tcp' },
      startCount: service._state!.startCount,
      totalUptime: service._state!.totalUptime,
    };
    return Response.json(detail);
  }

  /**
   * 停止服务
   */
  private async stopService(serviceName: string): Promise<Response> {
    const mapping = this.findServiceMapping(serviceName);
    if (!mapping) {
      return Response.json({ error: 'Service not found' }, { status: 404 });
    }

    const service = mapping.service;
    if (service._state!.status !== 'online') {
      return Response.json({ error: 'Service is not online' }, { status: 400 });
    }

    try {
      service._state!.status = 'stopping';
      if (service._state!.startTime) {
        service._state!.totalUptime += Date.now() - service._state!.startTime;
        service._state!.startTime = undefined;
      }

      await this.serviceManager.stop(service);
      this.gateway?.cleanupAgent(service.name);
      service._state!.status = 'offline';

      return Response.json({ success: true, message: `服务 ${service.name} 已停止` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      service._state!.status = 'online';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  /**
   * 启动服务
   */
  private async startService(serviceName: string): Promise<Response> {
    const mapping = this.findServiceMapping(serviceName);
    if (!mapping) {
      return Response.json({ error: 'Service not found' }, { status: 404 });
    }

    const service = mapping.service;
    if (service._state!.status === 'online' || service._state!.status === 'starting') {
      return Response.json({ error: 'Service is already running or starting' }, { status: 400 });
    }

    try {
      service._state!.status = 'starting';
      await this.serviceManager.start(service);

      const targetUrl = new URL(service.base);
      const targetHost = targetUrl.hostname;
      const targetPort = parseInt(targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80'));

      const waitStartTime = Date.now();
      let isReady = false;
      while (Date.now() - waitStartTime < service.startTimeout) {
        isReady = await new Promise<boolean>((resolve) => {
          const socket = net.createConnection({ host: targetHost, port: targetPort, timeout: 100 }, () => {
            socket.destroy();
            resolve(true);
          });
          socket.on('error', () => { socket.destroy(); resolve(false); });
          socket.on('timeout', () => { socket.destroy(); resolve(false); });
        });
        if (isReady) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (!isReady) {
        service._state!.status = 'offline';
        return Response.json({ error: 'Service start timeout' }, { status: 503 });
      }

      service._state!.status = 'online';
      service._state!.startTime = Date.now();
      service._state!.startCount++;
      return Response.json({ success: true, message: `服务 ${service.name} 已启动` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      service._state!.status = 'offline';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  /**
   * 处理事件流（SSE）：一次性发送连接成功事件后结束（与 Node 版行为一致）
   */
  private handleEventStream(): Response {
    return new Response(`event: connected\ndata: {"timestamp":${Date.now()}}\n\n`, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }
}
