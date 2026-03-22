import type { ServiceConfig } from '../config/types.js';
import type { HttpResponse, HttpRequest } from 'uWebSockets.js';
import type { Logger } from 'pino';
import type { ServiceManager } from './service-manager.js';
import net from 'node:net';
import { URL } from 'node:url';

/**
 * 路由映射信息
 */
interface RouteMapping {
  /** 服务配置 */
  service: ServiceConfig;
  /** 目标后端地址 */
  target: string;
}

/**
 * 管理处理器
 * 处理所有管理 API 请求
 */
export class AdminApiHandler {
  /** 按服务名称索引的服务配置（懒初始化，因为构造时路由表可能尚未填充） */
  private _serviceMap: Map<string, ServiceConfig> | undefined;
  /** 按服务名称索引的路由映射（懒初始化） */
  private _routeMap: Map<string, RouteMapping> | undefined;

  constructor(
    private config: DynaPMConfig,
    private logger: Logger,
    private hostnameRoutes: Map<string, RouteMapping>,
    private portRoutes: Map<number, RouteMapping>,
    private serviceManager: ServiceManager
  ) {}

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
  private isAuthenticated(authHeader: string | undefined): boolean {
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
   * 处理管理 API 请求
   */
  handleAdminApi(res: HttpResponse, req: HttpRequest): void {
    const ip = req.getHeader('x-forwarded-for')?.split(',')[0]?.trim() ||
               req.getHeader('cf-connecting-ip') ||
               '127.0.0.1';

    // IP 白名单检查
    if (!this.isIpAllowed(ip)) {
      res.cork(() => {
        res.writeStatus('403 Forbidden');
        res.end('Forbidden');
      });
      this.logger.warn({ msg: `🚫 [Admin API] 拒绝访问: ${ip}` });
      return;
    }

    // 认证检查
    const authHeader = req.getHeader('authorization');
    if (!this.isAuthenticated(authHeader)) {
      res.cork(() => {
        res.writeStatus('401 Unauthorized');
        res.writeHeader('WWW-Authenticate', 'Bearer');
        res.end('Unauthorized');
      });
      return;
    }

    const url = req.getUrl();
    const method = req.getMethod();

    // 路由分发（uWS getMethod() 返回小写方法名，无需 toLowerCase）
    if (url === '/_dynapm/api/services' && method === 'get') {
      this.getServicesList(res);
    } else if (url.startsWith('/_dynapm/api/services/') && method === 'get') {
      const serviceName = url.split('/')[4];
      this.getServiceDetail(res, serviceName);
    } else if (url.endsWith('/stop') && method === 'post') {
      const parts = url.split('/');
      const serviceName = parts[4];
      this.stopService(res, serviceName);
    } else if (url.endsWith('/start') && method === 'post') {
      const parts = url.split('/');
      const serviceName = parts[4];
      this.startService(res, serviceName);
    } else if (url === '/_dynapm/api/events' && method === 'get') {
      this.handleEventStream(res);
    } else {
      res.cork(() => {
        res.writeStatus('404 Not Found');
        res.end('Not Found');
      });
    }
  }

  /**
   * 获取服务列表
   */
  private getServicesList(res: HttpResponse): void {
    const services = Array.from(this.getServiceMap().values()).map((service: ServiceConfig) => {
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

    res.cork(() => {
      res.writeHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ services }));
    });
  }

  /**
   * 获取服务详情
   */
  private getServiceDetail(res: HttpResponse, serviceName: string): void {
    const mapping = this.findServiceMapping(serviceName);

    this.logger.info({ msg: `🔍 [Admin API] 查找服务: ${serviceName}, 找到: ${mapping?.service.name || 'null'}` });

    if (!mapping) {
      res.cork(() => {
        res.writeStatus('404 Not Found');
        res.end(JSON.stringify({ error: 'Service not found' }));
      });
      return;
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

    res.cork(() => {
      res.writeHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(detail));
    });
  }

  /**
   * 停止服务
   */
  async stopService(res: HttpResponse, serviceName: string): Promise<void> {
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    const mapping = this.findServiceMapping(serviceName);

    if (!mapping) {
      if (!aborted) {
        res.cork(() => {
          res.writeStatus('404 Not Found');
          res.end(JSON.stringify({ error: 'Service not found' }));
        });
      }
      return;
    }

    const service = mapping.service;

    if (service._state!.status !== 'online') {
      if (!aborted) {
        res.cork(() => {
          res.writeStatus('400 Bad Request');
          res.end(JSON.stringify({ error: 'Service is not online' }));
        });
      }
      return;
    }

    try {
      service._state!.status = 'stopping';

      if (service._state!.startTime) {
        service._state!.totalUptime += Date.now() - service._state!.startTime;
        service._state!.startTime = undefined;
      }

      await this.serviceManager.stop(service);

      service._state!.status = 'offline';

      if (!aborted) {
        res.cork(() => {
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: true,
            message: `服务 ${service.name} 已停止`,
          }));
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      service._state!.status = 'online';
      if (!aborted) {
        res.cork(() => {
          res.writeStatus('500 Internal Server Error');
          res.end(JSON.stringify({ error: message }));
        });
      }
    }
  }

  /**
   * 启动服务
   */
  async startService(res: HttpResponse, serviceName: string): Promise<void> {
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    const mapping = this.findServiceMapping(serviceName);

    if (!mapping) {
      if (!aborted) {
        res.cork(() => {
          res.writeStatus('404 Not Found');
          res.end(JSON.stringify({ error: 'Service not found' }));
        });
      }
      return;
    }

    const service = mapping.service;

    if (service._state!.status === 'online' || service._state!.status === 'starting') {
      if (!aborted) {
        res.cork(() => {
          res.writeStatus('400 Bad Request');
          res.end(JSON.stringify({ error: 'Service is already running or starting' }));
        });
      }
      return;
    }

    try {
      service._state!.status = 'starting';

      /** 先等待启动命令执行完成，再检查端口就绪（避免 fire-and-forget 竞态） */
      await this.serviceManager.start(service);

      /** 预解析 URL，避免循环内重复 new URL() */
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
        if (isReady) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (!isReady) {
        service._state!.status = 'offline';
        if (!aborted) {
          res.cork(() => {
            res.writeStatus('503 Service Unavailable');
            res.end(JSON.stringify({ error: 'Service start timeout' }));
          });
        }
        return;
      }

      service._state!.status = 'online';
      service._state!.startTime = Date.now();
      service._state!.startCount++;

      if (!aborted) {
        res.cork(() => {
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: true,
            message: `服务 ${service.name} 已启动`,
          }));
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      service._state!.status = 'offline';
      if (!aborted) {
        res.cork(() => {
          res.writeStatus('500 Internal Server Error');
          res.end(JSON.stringify({ error: message }));
        });
      }
    }
  }

  /**
   * 处理事件流（SSE）
   */
  private handleEventStream(res: HttpResponse): void {
    res.cork(() => {
      res.writeStatus('200 OK');
      res.writeHeader('Content-Type', 'text/event-stream');
      res.writeHeader('Cache-Control', 'no-cache');
      res.writeHeader('Connection', 'keep-alive');
      res.writeHeader('X-Accel-Buffering', 'no');
    });

    // 发送初始连接成功事件
    res.cork(() => {
      res.end(`event: connected\ndata: {"timestamp":${Date.now()}}\n\n`);
    });
  }
}

/**
 * DynaPM 配置类型导入
 */
interface DynaPMConfig {
  adminApi?: {
    enabled?: boolean;
    authToken?: string;
    allowedIps?: string[];
  };
}
