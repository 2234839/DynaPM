import { ServiceManager } from './service-manager.js';
import type { ServiceConfig, DynaPMConfig } from '../config/types.js';
import type { HttpResponse, HttpRequest, WebSocket } from 'uWebSockets.js';
import type { Logger } from 'pino';
import uWS from 'uWebSockets.js';
import net from 'node:net';
import { URL } from 'node:url';
import http from 'node:http';
import WS from 'ws';
import { AdminApiHandler } from './admin-api.js';
import { formatTime } from '../utils/format.js';

/**
 * 收集 uWS 请求体为 Buffer
 * 在 onData 的 isLast 回调中完成收集
 * 超过 MAX_REQUEST_BODY_SIZE 时截断并返回已收集的数据
 *
 * 重要：uWS 的 onData 回调中的 ArrayBuffer 是借用的，
 * 回调返回后会被回收，必须在回调内复制数据。
 */
function collectRequestBody(res: HttpResponse): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;

    res.onData((ab: ArrayBuffer, isLast: boolean) => {
      if (resolved) return;

      const chunk = Buffer.alloc(ab.byteLength);
      Buffer.from(ab).copy(chunk);
      totalSize += chunk.length;

      if (totalSize > GatewayConstants.MAX_REQUEST_BODY_SIZE) {
        resolved = true;
        resolve(Buffer.concat(chunks));
        return;
      }

      chunks.push(chunk);
      if (isLast) {
        resolved = true;
        resolve(Buffer.concat(chunks));
      }
    });

    res.onAborted(() => {
      if (resolved) return;
      resolved = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * 获取 HTTP 状态消息
 */
function getStatusMessage(statusCode: number): string {
  const messages: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return messages[statusCode] || 'Unknown';
}

/** 网关常量 */
const GatewayConstants = {
  /** 闲置检查间隔（毫秒） */
  IDLE_CHECK_INTERVAL: 3000,
  /** TCP 端口检查超时（毫秒） */
  TCP_CHECK_TIMEOUT: 100,
  /** 后端就绪检查延迟（毫秒） */
  BACKEND_READY_CHECK_DELAY: 50,
  /** 不应转发的响应头（小写） */
  SKIP_RESPONSE_HEADERS: new Set(['connection', 'transfer-encoding', 'keep-alive', 'content-length']),
  /** 预编译 CRLF 清理正则（热路径中使用） */
  CRLF_REGEX: /[\r\n]/g,
  /** 不应转发的请求头（小写） */
  SKIP_REQUEST_HEADERS: new Set(['connection', 'keep-alive', 'content-length', 'transfer-encoding']),
  /** WebSocket 升级时不应转发的请求头（小写） */
  WS_SKIP_HEADERS: new Set(['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version']),
  /** 请求体最大大小（10MB），防止 DoS 攻击 */
  MAX_REQUEST_BODY_SIZE: 10 * 1024 * 1024,
  /** WebSocket 消息队列最大长度（1000 条），防止内存泄漏 */
  MAX_WS_MESSAGE_QUEUE_SIZE: 1000,
} as const;

/**
 * 快速检查 TCP 端口是否可用
 */
function checkTcpPort(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'));

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: GatewayConstants.TCP_CHECK_TIMEOUT }, () => {
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
 * 代理请求状态跟踪
 */
interface ProxyState {
  /** 客户端是否已断开连接 */
  aborted: boolean;
  /** 是否已发送响应（防止重复响应） */
  responded: boolean;
}

/**
 * 路由映射信息
 */
interface RouteMapping {
  /** 服务配置 */
  service: ServiceConfig;
  /** 目标后端地址 */
  target: string;
  /** 缓存的目标 URL 对象（避免重复解析） */
  targetUrl?: URL;
  /** 预计算的目标端口（避免每次请求 parseInt） */
  targetPort: number;
}

/**
 * DynaPM网关
 * 负责请求拦截、服务启动和反向代理
 */
export class Gateway {
  private serviceManager = new ServiceManager();
  /** 主机名路由：hostname -> 路由映射信息 */
  private hostnameRoutes: Map<string, RouteMapping> = new Map();
  /** 端口路由：端口 -> 路由映射信息 */
  private portRoutes: Map<number, RouteMapping> = new Map();
  /** 日志记录器 */
  private logger: Logger;
  /** 日志配置 */
  private logging: {
    /** 是否启用请求日志（每个请求响应记录） */
    enableRequestLog: boolean;
    /** 是否启用 WebSocket 生命周期日志 */
    enableWebSocketLog: boolean;
    /** 是否启用性能分析日志（用于性能优化调试） */
    enablePerformanceLog: boolean;
  };
  /** 管理 API 处理器 */
  private adminApi: AdminApiHandler;
  /** 服务启动 Promise 追踪：serviceName -> 启动完成 Promise */
  private startingPromises = new Map<string, Promise<void>>();

  constructor(private config: DynaPMConfig, logger: Logger) {
    this.logger = logger;
    this.logging = {
      enableRequestLog: config.logging?.enableRequestLog ?? false,
      enableWebSocketLog: config.logging?.enableWebSocketLog ?? false,
      enablePerformanceLog: config.logging?.enablePerformanceLog ?? false,
    };
    this.adminApi = new AdminApiHandler(config, logger, this.hostnameRoutes, this.portRoutes, this.serviceManager);
    this.initServices();
    this.initIdleChecker();
  }

  /**
   * 初始化服务映射和端口绑定
   */
  private initServices(): void {
    if (!this.config.services) {
      return;
    }

    console.log('[DynaPM] 初始化服务...');
    console.log('[DynaPM] 服务数量:', Object.keys(this.config.services).length);

    for (const service of Object.values(this.config.services)) {
      // 初始化状态
      service._state = {
        // 纯代理模式：服务始终在线，不需要启动
        status: service.proxyOnly ? 'online' : 'offline',
        lastAccessTime: Date.now(),
        activeConnections: 0,
        startCount: 0,
        totalUptime: 0,
      };

      // 处理路由配置
      const routes = service.routes || [];
      if (routes.length === 0) {
        console.warn(`[DynaPM] ⚠️  [${service.name}] 没有配置路由`);
        continue;
      }

      console.log(`[DynaPM] ✅ [${service.name}] 配置了 ${routes.length} 个路由:`);

      // 遍历路由配置
      for (const route of routes) {
        const targetUrl = new URL(route.target);
        const mapping: RouteMapping = {
          service,
          target: route.target,
          targetUrl,
          targetPort: parseInt(targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80')),
        };
        if (route.type === 'host') {
          const hostname = route.value as string;
          this.hostnameRoutes.set(hostname, mapping);
          console.log(`[DynaPM]   └─ hostname: ${hostname} -> ${route.target}`);
        } else if (route.type === 'port') {
          const port = route.value as number;
          this.portRoutes.set(port, mapping);
          console.log(`[DynaPM]   └─ port: ${port} -> ${route.target}`);
        }
      }
    }

    const hostnameCount = this.hostnameRoutes.size;
    const portCount = this.portRoutes.size;
    console.log(`[DynaPM] 📊 共配置 ${hostnameCount} 个 hostname 映射, ${portCount} 个端口绑定`);
    this.logger.info({ msg: `📊 共配置 ${hostnameCount} 个 hostname 映射, ${portCount} 个端口绑定` });
  }

  /**
   * 初始化闲置检查器
   */
  private initIdleChecker(): void {
    setInterval(() => {
      const now = Date.now();
      const checkedServices = new Set<ServiceConfig>();

      for (const mapping of this.hostnameRoutes.values()) {
        if (!checkedServices.has(mapping.service)) {
          checkedServices.add(mapping.service);
          this.checkIdleService(mapping.service, now);
        }
      }

      for (const mapping of this.portRoutes.values()) {
        if (!checkedServices.has(mapping.service)) {
          checkedServices.add(mapping.service);
          this.checkIdleService(mapping.service, now);
        }
      }
    }, GatewayConstants.IDLE_CHECK_INTERVAL);
  }

  /**
   * 检查单个服务是否闲置
   */
  private checkIdleService(service: ServiceConfig, now: number): void {
    if (service.proxyOnly) {
      return;
    }

    if (
      service._state!.status === 'online' &&
      service._state!.activeConnections === 0 &&
      now - service._state!.lastAccessTime > service.idleTimeout
    ) {
      this.logger.info({ msg: `🛌 [${service.name}] 闲置超时，正在停止...` });
      service._state!.status = 'stopping';
      if (service._state!.startTime) {
        service._state!.totalUptime += now - service._state!.startTime;
        service._state!.startTime = undefined;
      }
      this.serviceManager.stop(service).catch((err: Error) => {
        this.logger.error({ msg: `❌ [${service.name}] 停止失败`, error: err.message });
      }).finally(() => {
        service._state!.status = 'offline';
      });
    }
  }

  /**
   * 处理端口绑定请求
   */
  private handlePortBindingRequest(
    res: HttpResponse,
    req: HttpRequest,
    mapping: RouteMapping
  ): void {
    const service = mapping.service;
    const startTime = Date.now();
    const method = req.getMethod();
    const url = req.getUrl();
    const queryString = req.getQuery();
    const fullUrl = queryString ? `${url}?${queryString}` : url;

    const headers: Record<string, string> = {};
    req.forEach((key: string, value: string) => {
      const safeValue = value.replace(GatewayConstants.CRLF_REGEX, '');
      headers[key] = safeValue;
    });

    service._state!.lastAccessTime = Date.now();

    const status = service._state!.status;

    if (status === 'starting') {
      const startPromise = this.startingPromises.get(service.name);
      if (startPromise) {
        this.handleServiceWithStartPromise(res, mapping, fullUrl, startTime, method, headers, startPromise);
      } else {
        this.handleDirectProxy(res, mapping, fullUrl, startTime, method, headers);
      }
      return;
    }

    const needsStart = status === 'offline' || status === 'stopping';

    if (needsStart) {
      if (status === 'stopping') {
        this.handleServiceWithWait(res, mapping, fullUrl, startTime, method, headers);
      } else {
        this.handleServiceStart(res, mapping, fullUrl, startTime, method, headers);
      }
    } else {
      this.handleDirectProxy(res, mapping, fullUrl, startTime, method, headers);
    }
  }

  /**
   * 处理传入的 HTTP 请求
   */
  private handleRequest(res: HttpResponse, req: HttpRequest): void {
    const startTime = Date.now();
    const hostHeader = req.getHeader('host');
    let hostname = '';
    if (hostHeader) {
      const colonIndex = hostHeader.indexOf(':');
      hostname = colonIndex !== -1 ? hostHeader.substring(0, colonIndex) : hostHeader;
    }
    const method = req.getMethod();
    const url = req.getUrl();
    const queryString = req.getQuery();
    const fullUrl = queryString ? url + '?' + queryString : url;

    const headers: Record<string, string> = {};
    req.forEach((key: string, value: string) => {
      headers[key] = value.replace(GatewayConstants.CRLF_REGEX, '');
    });

    const mapping = this.hostnameRoutes.get(hostname);

    if (!mapping) {
      this.logger.info({ msg: `❌ [${hostname}] ${method} ${fullUrl} - 404` });
      res.cork(() => {
        res.writeStatus('404 Not Found');
        res.end(`Service not found: ${hostname}`);
      });
      return;
    }

    const service = mapping.service;
    service._state!.lastAccessTime = Date.now();

    const status = service._state!.status;

    if (status === 'starting') {
      /** 服务正在启动中，等待启动完成后再代理 */
      const startPromise = this.startingPromises.get(service.name);
      if (startPromise) {
        this.handleServiceWithStartPromise(res, mapping, fullUrl, startTime, method, headers, startPromise);
      } else {
        /** 理论上不应该走到这里，但作为兜底处理 */
        this.handleDirectProxy(res, mapping, fullUrl, startTime, method, headers);
      }
      return;
    }

    const needsStart = status === 'offline' || status === 'stopping';

    if (needsStart) {
      if (status === 'stopping') {
        this.handleServiceWithWait(res, mapping, fullUrl, startTime, method, headers);
      } else {
        this.handleServiceStart(res, mapping, fullUrl, startTime, method, headers);
      }
    } else {
      this.handleDirectProxy(res, mapping, fullUrl, startTime, method, headers);
    }
  }

  /**
   * 启动服务并代理请求
   */
  private async startServiceAndProxy(
    res: HttpResponse,
    mapping: RouteMapping,
    fullUrl: string,
    startTime: number,
    method: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<void> {
    const service = mapping.service;
    const target = mapping.target;

    this.logger.info({ msg: `🚀 [${service.name}] ${method} ${fullUrl} - 启动服务...` });
    service._state!.status = 'starting';

    /** 创建启动 Promise 供后续并发请求等待 */
    let resolveStartPromise: () => void;
    let rejectStartPromise: (err: Error) => void;
    const startPromise = new Promise<void>((resolve, reject) => {
      resolveStartPromise = resolve;
      rejectStartPromise = reject;
    });
    this.startingPromises.set(service.name, startPromise);

    try {
      await this.serviceManager.start(service);

      const waitStartTime = Date.now();
      let isReady = false;
      while (Date.now() - waitStartTime < service.startTimeout) {
        isReady = await checkTcpPort(target);
        if (isReady) {
          const waitDuration = Date.now() - waitStartTime;
          this.logger.info({
            msg: `✅ [${service.name}] 服务就绪 (等待${formatTime(waitDuration)})`,
          });
          break;
        }
      }

      if (!isReady) {
        service._state!.status = 'offline';
        throw new Error(`服务启动超时: 端口 ${target} 不可用`);
      }

      service._state!.status = 'online';
      service._state!.startTime = Date.now();
      service._state!.startCount++;

      resolveStartPromise!();
      this.startingPromises.delete(service.name);

      await this.forwardProxyRequest(res, mapping, fullUrl, startTime, method, headers, body);
    } catch (error: unknown) {
      this.startingPromises.delete(service.name);
      const message = error instanceof Error ? error.message : String(error);

      if (message === 'Client aborted') {
        resolveStartPromise!();
        return;
      }

      rejectStartPromise!(error instanceof Error ? error : new Error(message));

      this.logger.error({ msg: `❌ [${service.name}] 启动失败`, error: message });
      try {
        res.cork(() => {
          res.writeStatus('503 Service Unavailable');
          res.end('Service Unavailable');
        });
      } catch {
        // 忽略发送失败
      }
    }
  }

  /**
   * 处理需要等待服务停止完成的场景
   */
  private handleServiceWithWait(
    res: HttpResponse,
    mapping: RouteMapping,
    fullUrl: string,
    startTime: number,
    method: string,
    headers: Record<string, string>
  ): void {
    const service = mapping.service;
    this.logger.info({ msg: `⏳ [${service.name}] ${method} ${fullUrl} - 等待服务停止完成...` });

    // 边收集请求体边等待服务停止
    const bodyPromise = collectRequestBody(res);

    (async () => {
      const maxWaitTime = 30000;
      const checkInterval = 100;
      const waitStartTime = Date.now();

      while (service._state!.status === 'stopping') {
        if (Date.now() - waitStartTime > maxWaitTime) {
          this.logger.error({ msg: `❌ [${service.name}] 等待服务停止超时` });
          try {
            res.cork(() => {
              res.writeStatus('503 Service Unavailable');
              res.end('Service stopping timeout');
            });
          } catch {
            // 忽略发送失败
          }
          return;
        }
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }

      this.logger.info({ msg: `✅ [${service.name}] 服务已停止，开始启动...` });
      const body = await bodyPromise;
      await this.startServiceAndProxy(res, mapping, fullUrl, startTime, method, headers, body);
    })();
  }

  /**
   * 处理服务正在启动中的场景
   * 等待启动 Promise 完成后，如果成功则直接代理，如果失败则返回 503
   */
  private handleServiceWithStartPromise(
    res: HttpResponse,
    mapping: RouteMapping,
    fullUrl: string,
    startTime: number,
    method: string,
    headers: Record<string, string>,
    startPromise: Promise<void>,
  ): void {
    const bodyPromise = collectRequestBody(res);

    (async () => {
      try {
        await startPromise;
      } catch {
        await bodyPromise;
        try {
          res.cork(() => {
            res.writeStatus('503 Service Unavailable');
            res.end('Service start failed');
          });
        } catch {
          // 忽略发送失败
        }
        return;
      }

      const body = await bodyPromise;
      await this.forwardProxyRequest(res, mapping, fullUrl, startTime, method, headers, body);
    })();
  }

  /**
   * 处理需要启动服务的场景
   */
  private handleServiceStart(
    res: HttpResponse,
    mapping: RouteMapping,
    fullUrl: string,
    startTime: number,
    method: string,
    headers: Record<string, string>
  ): void {
    const bodyPromise = collectRequestBody(res);

    (async () => {
      const body = await bodyPromise;
      await this.startServiceAndProxy(res, mapping, fullUrl, startTime, method, headers, body);
    })();
  }

  /**
   * 处理直接代理场景（服务已在线）
   * 双向流式转发：请求体边收边发，响应体边收边回
   */
  private handleDirectProxy(
    res: HttpResponse,
    mapping: RouteMapping,
    fullUrl: string,
    startTime: number,
    method: string,
    headers: Record<string, string>
  ): void {
    const service = mapping.service;
    const targetUrl = mapping.targetUrl!;

    // 构建代理请求头
    const proxyHeaders: Record<string, string> = {};
    for (const key in headers) {
      if (GatewayConstants.SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
        continue;
      }
      proxyHeaders[key] = headers[key];
    }
    proxyHeaders['host'] = targetUrl.host;

    const state: ProxyState = { aborted: false, responded: false };
    service._state!.activeConnections++;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      service._state!.activeConnections--;
    };

    res.onAborted(() => {
      state.aborted = true;
      cleanup();
    });

    // 立即发起代理请求，不等请求体收集完
    const proxyReq = http.request({
      hostname: targetUrl.hostname,
      port: mapping.targetPort,
      path: fullUrl,
      method: method.toUpperCase(),
      headers: proxyHeaders,
      timeout: 30000,
    }, (proxyRes) => {
      if (state.aborted) {
        proxyRes.destroy();
        cleanup();
        return;
      }

      const statusCode = proxyRes.statusCode || 200;
      const statusMessage = getStatusMessage(statusCode);

      // 特殊处理 101 WebSocket 升级
      if (statusCode === 101) {
        res.cork(() => {
          if (state.aborted) return;
          res.writeStatus(`${statusCode} ${statusMessage}`);
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (GatewayConstants.SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
            if (value) res.writeHeader(key, Array.isArray(value) ? value.join(', ') : value);
          }
          res.end();
          state.responded = true;
        });
        cleanup();
        return;
      }

      // 设置响应头
      res.cork(() => {
        if (state.aborted) return;
        res.writeStatus(`${statusCode} ${statusMessage}`);
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (GatewayConstants.SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
          if (value) res.writeHeader(key, Array.isArray(value) ? value.join(', ') : value);
        }
      });

      // 流式转发响应体
      proxyRes.on('data', (chunk: Buffer) => {
        if (state.aborted) {
          proxyRes.destroy();
          return;
        }

        let writeSuccess = false;
        res.cork(() => {
          if (state.aborted) return;
          writeSuccess = res.write(chunk);
        });

        if (!writeSuccess) {
          proxyRes.pause();
          res.onWritable(() => {
            if (state.aborted) {
              proxyRes.destroy();
              return false;
            }
            proxyRes.resume();
            return true;
          });
        }
      });

      proxyRes.on('end', () => {
        if (state.aborted) {
          cleanup();
          return;
        }

        res.cork(() => {
          if (state.aborted) return;
          res.end();
          state.responded = true;

          if (this.logging.enableRequestLog) {
            const responseTime = Date.now() - startTime;
            this.logger.info({
              msg: `📤 [${service.name}] ${method} ${fullUrl} - ${statusCode} - ${formatTime(responseTime)}`,
              service: service.name,
              method,
              path: fullUrl,
              statusCode,
              responseTime,
            });
          }
        });

        cleanup();
      });

      proxyRes.on('error', (err: Error) => {
        if (state.aborted) {
          cleanup();
          return;
        }
        this.logger.error({ msg: `❌ [${service.name}] 代理响应错误`, error: err.message });
        if (!state.responded) {
          state.responded = true;
          res.cork(() => {
            res.writeStatus('502 Bad Gateway');
            res.end('Bad Gateway');
          });
        }
        cleanup();
      });
    });

    proxyReq.on('error', (err: Error) => {
      if (state.aborted) {
        cleanup();
        return;
      }
      this.logger.error({ msg: `❌ [${service.name}] 代理请求错误`, error: err.message });
      if (!state.responded) {
        state.responded = true;
        res.cork(() => {
          res.writeStatus('502 Bad Gateway');
          res.end('Bad Gateway');
        });
      }
      /** 后端不可达时，将非 proxyOnly 服务状态重置为 offline，允许后续按需启动 */
      if (!service.proxyOnly && service._state!.status === 'online') {
        this.logger.info({ msg: `🔄 [${service.name}] 后端不可达，重置状态为 offline` });
        service._state!.status = 'offline';
      }
      cleanup();
    });

    /** 代理请求超时处理：销毁连接并返回 504 */
    proxyReq.on('timeout', () => {
      this.logger.error({ msg: `⏱️ [${service.name}] 代理请求超时` });
      proxyReq.destroy();
    });

    // 边收请求体边写入代理请求（真正的双向流式）
    res.onData((ab: ArrayBuffer, isLast: boolean) => {
      if (state.aborted) {
        proxyReq.destroy();
        return;
      }

      /** uWS 的 ArrayBuffer 是借用语义，必须复制数据 */
      const chunk = Buffer.alloc(ab.byteLength);
      Buffer.from(ab).copy(chunk);

      if (isLast) {
        proxyReq.end(chunk);
      } else {
        proxyReq.write(chunk);
      }
    });
  }

  /**
   * 发起代理请求并流式转发响应（用于服务启动/等待场景）
   *
   * 仅在服务需要启动或等待停止时使用，此时请求体已缓冲为 Buffer。
   * 响应体保持流式转发。
   */
  private async forwardProxyRequest(
    res: HttpResponse,
    mapping: RouteMapping,
    path: string,
    startTime: number,
    method: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<void> {
    const service = mapping.service;
    const perfLog = this.logging.enablePerformanceLog;

    const perfPrepStart = perfLog ? performance.now() : 0;
    const targetUrl = mapping.targetUrl!;

    // 构建代理请求头
    const proxyHeaders: Record<string, string> = {};
    for (const key in headers) {
      if (GatewayConstants.SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
        continue;
      }
      proxyHeaders[key] = headers[key];
    }
    proxyHeaders['host'] = targetUrl.host;

    // 如果有请求体，设置 content-length
    if (body.length > 0) {
      proxyHeaders['content-length'] = String(body.length);
    }

    const perfPrepTime = perfLog ? performance.now() - perfPrepStart : 0;

    const state: ProxyState = { aborted: false, responded: false };
    service._state!.activeConnections++;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      service._state!.activeConnections--;
    };

    res.onAborted(() => {
      state.aborted = true;
      cleanup();
    });

    const perfHttpStart = perfLog ? performance.now() : 0;
    let perfTtfb = 0;
    let perfStreamStart = 0;
    let chunkCount = 0;
    let totalBytes = 0;

    return new Promise((resolve, reject) => {
      let proxyReq: http.ClientRequest;

      try {
        proxyReq = http.request({
          hostname: targetUrl.hostname,
          port: mapping.targetPort,
          path,
          method: method.toUpperCase(),
          headers: proxyHeaders,
          timeout: 30000,
        }, (proxyRes) => {
          if (perfLog && perfTtfb === 0) {
            perfTtfb = performance.now() - perfHttpStart;
            perfStreamStart = performance.now();
          }

          const statusCode = proxyRes.statusCode || 200;
          const statusMessage = getStatusMessage(statusCode);

          if (state.aborted) {
            proxyRes.destroy();
            cleanup();
            resolve();
            return;
          }

          // 特殊处理 101 WebSocket 升级
          if (statusCode === 101) {
            res.cork(() => {
              if (state.aborted) return;
              res.writeStatus(`${statusCode} ${statusMessage}`);

              for (const [key, value] of Object.entries(proxyRes.headers)) {
                if (GatewayConstants.SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
                  continue;
                }
                if (value) {
                  res.writeHeader(key, Array.isArray(value) ? value.join(', ') : value);
                }
              }
              res.end();
              state.responded = true;
            });

            cleanup();
            resolve();
            return;
          }

          // 设置响应头
          res.cork(() => {
            if (state.aborted) return;
            res.writeStatus(`${statusCode} ${statusMessage}`);

            for (const [key, value] of Object.entries(proxyRes.headers)) {
              if (GatewayConstants.SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
                continue;
              }
              if (value) {
                res.writeHeader(key, Array.isArray(value) ? value.join(', ') : value);
              }
            }
          });

          // 流式转发响应体
          proxyRes.on('data', (chunk: Buffer) => {
            if (state.aborted) {
              proxyRes.destroy();
              return;
            }

            if (perfLog) {
              chunkCount++;
              totalBytes += chunk.length;
            }

            let writeSuccess = false;
            res.cork(() => {
              if (state.aborted) return;
              writeSuccess = res.write(chunk);
            });

            if (!writeSuccess) {
              proxyRes.pause();
              res.onWritable(() => {
                if (state.aborted) {
                  proxyRes.destroy();
                  return false;
                }
                proxyRes.resume();
                return true;
              });
            }
          });

          proxyRes.on('end', () => {
            if (state.aborted) {
              cleanup();
              resolve();
              return;
            }

            const perfStreamTime = perfLog ? performance.now() - perfStreamStart : 0;
            const perfTotalTime = perfLog ? performance.now() - perfPrepStart : 0;

            res.cork(() => {
              if (state.aborted) return;
              res.end();
              state.responded = true;

              if (this.logging.enableRequestLog) {
                const responseTime = Date.now() - startTime;
                this.logger.info({
                  msg: `📤 [${service.name}] ${method} ${path} - ${statusCode} - ${formatTime(responseTime)}`,
                  service: service.name,
                  method,
                  path,
                  statusCode,
                  responseTime,
                });
              }

              if (perfLog) {
                console.error(`⚡ [${service.name}] 性能分析:`, {
                  method,
                  path,
                  statusCode,
                  prepTime: perfPrepTime.toFixed(3) + 'ms',
                  ttfb: perfTtfb.toFixed(3) + 'ms',
                  streamTime: perfStreamTime.toFixed(3) + 'ms',
                  totalTime: perfTotalTime.toFixed(3) + 'ms',
                  chunkCount,
                  totalBytes,
                  avgChunkSize: chunkCount > 0 ? (totalBytes / chunkCount).toFixed(1) + 'B' : '0B',
                });
              }
            });

            cleanup();
            resolve();
          });

          proxyRes.on('error', (err: Error) => {
            if (state.aborted) {
              cleanup();
              resolve();
              return;
            }

            this.logger.error({ msg: `❌ [${service.name}] 代理响应错误`, error: err.message });
            if (!state.responded) {
              state.responded = true;
              res.cork(() => {
                res.writeStatus('502 Bad Gateway');
                res.end('Bad Gateway');
              });
            }
            cleanup();
            reject(err);
          });
        });

        proxyReq.on('error', (err: Error) => {
          if (state.aborted) {
            cleanup();
            resolve();
            return;
          }

          this.logger.error({ msg: `❌ [${service.name}] 代理请求错误`, error: err.message });
          if (!state.responded) {
            state.responded = true;
            res.cork(() => {
              res.writeStatus('502 Bad Gateway');
              res.end('Bad Gateway');
            });
          }
          cleanup();
          reject(err);
        });

        /** 代理请求超时处理：销毁连接触发 error → 502 */
        proxyReq.on('timeout', () => {
          this.logger.error({ msg: `⏱️ [${service.name}] 代理请求超时` });
          proxyReq.destroy();
        });

        // 发送请求体（空 body 也会调用 end 来触发请求）
        if (body.length > 0) {
          proxyReq.end(body);
        } else {
          proxyReq.end();
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ msg: `❌ [${service.name}] 创建代理请求失败`, error: message });
        if (!state.responded) {
          state.responded = true;
          res.cork(() => {
            res.writeStatus('502 Bad Gateway');
            res.end('Bad Gateway');
          });
        }
        cleanup();
        reject(new Error(message));
      }
    });
  }

  /**
   * 启动网关
   */
  async start(): Promise<void> {
    const host = this.config.host || '127.0.0.1';
    const port = this.config.port || 3000;

    const app = uWS.App();

    // WebSocket 处理器
    app.ws('/*', {
      upgrade: (res: HttpResponse, req: HttpRequest, context) => {
        const hostname = req.getHeader('host')?.split(':')[0] || '';
        const mapping = this.hostnameRoutes.get(hostname);

        if (!mapping) {
          res.cork(() => {
            res.writeStatus('404 Not Found');
            res.end(`Service not found: ${hostname}`);
          });
          return;
        }

        const { service, target } = mapping;
        service._state!.lastAccessTime = Date.now();

        const clientHeaders: Record<string, string> = {};
        req.forEach((key: string, value: string) => {
          const safeValue = value.replace(GatewayConstants.CRLF_REGEX, '');
          clientHeaders[key] = safeValue;
        });

        const clientPath = req.getUrl() + (req.getQuery() ? `?${req.getQuery()}` : '');

        res.upgrade(
          {
            hostname,
            service,
            target,
            clientHeaders,
            clientPath,
          },
          req.getHeader('sec-websocket-key'),
          req.getHeader('sec-websocket-protocol'),
          req.getHeader('sec-websocket-extensions'),
          context
        );

        if (this.logging.enableWebSocketLog) {
          this.logger.info({ msg: `🔌 [${service.name}] WebSocket 升级请求: ${clientPath}` });
        }
      },

      open: (ws: WebSocket<Record<string, unknown>>) => {
        const userData = ws.getUserData();
        const service = userData.service as ServiceConfig;
        const target = userData.target as string;

        service._state!.activeConnections++;

        if (this.logging.enableWebSocketLog) {
          this.logger.info({ msg: `🔌 [${service.name}] WebSocket 连接已建立` });
        }

        const wsState = {
          backendReady: false,
          messageQueue: [] as Buffer[],
          backendWs: undefined as WS | undefined,
          closing: false,
        };
        (ws as unknown as Record<string, unknown>).wsState = wsState;

        (async () => {
          try {
            const needsStart = service._state!.status === 'offline';

            if (needsStart) {
              this.logger.info({ msg: `🚀 [${service.name}] WebSocket - 启动服务...` });
              service._state!.status = 'starting';

              await this.serviceManager.start(service);

              const waitStartTime = Date.now();
              let isReady = false;
              while (Date.now() - waitStartTime < service.startTimeout) {
                isReady = await checkTcpPort(target);
                if (isReady) {
                  const waitDuration = Date.now() - waitStartTime;
                  this.logger.info({
                    msg: `✅ [${service.name}] WebSocket 服务就绪 (等待${formatTime(waitDuration)})`,
                  });
                  break;
                }
                await new Promise(resolve => setTimeout(resolve, GatewayConstants.BACKEND_READY_CHECK_DELAY));
              }

              if (!isReady) {
                service._state!.status = 'offline';
                this.logger.error({ msg: `❌ [${service.name}] WebSocket 服务启动超时` });
                ws.close();
                return;
              }

              service._state!.status = 'online';
              service._state!.startTime = Date.now();
              service._state!.startCount++;
            }

            const targetUrl = new URL(target);
            const wsUserData = ws.getUserData();
            const clientPath = wsUserData.clientPath as string;
            const clientHeaders = wsUserData.clientHeaders as Record<string, string>;
            const wsUrl = `${targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${targetUrl.host}${clientPath}`;

            if (this.logging.enableWebSocketLog) {
              this.logger.info({ msg: `🔌 [${service.name}] 连接后端 WebSocket: ${wsUrl}` });
            }

            const backendHeaders: Record<string, string> = {};
            const skipHeaders = GatewayConstants.WS_SKIP_HEADERS;

            for (const [key, value] of Object.entries(clientHeaders)) {
              if (!skipHeaders.has(key.toLowerCase())) {
                backendHeaders[key] = value;
              }
            }

            backendHeaders['Host'] = targetUrl.host;

            this.logger.info({
              msg: `🔌 [${service.name}] 转发 WebSocket 请求头`,
              headers: JSON.stringify(backendHeaders, null, 2)
            });

            const backendWs = new WS(wsUrl, {
              headers: backendHeaders,
            });

            wsState.backendWs = backendWs;

            backendWs.on('open', () => {
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `✅ [${service.name}] 后端 WebSocket 连接已建立` });
              }
              wsState.backendReady = true;

              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `📤 [${service.name}] 发送队列中的 ${wsState.messageQueue.length} 条消息` });
              }
              while (wsState.messageQueue.length > 0 && backendWs.readyState === WS.OPEN) {
                const msg = wsState.messageQueue.shift();
                if (msg) {
                  if (this.logging.enableWebSocketLog) {
                    this.logger.info({ msg: `📨 [${service.name}] 发送队列消息: ${msg.length} 字节` });
                  }
                  backendWs.send(msg);
                }
              }
            });

            backendWs.on('message', (data: Buffer, isBinary: boolean) => {
              if (ws !== null) {
                const success = ws.send(data, isBinary, false);
                if (!success) {
                  backendWs.pause();

                  const drainHandler = () => {
                    if (backendWs.readyState === WS.OPEN) {
                      const retrySuccess = ws.send(data, isBinary, false);
                      if (retrySuccess) {
                        backendWs.resume();
                      } else {
                        return true;
                      }
                    }
                    return false;
                  };

                  ws.cork(drainHandler);
                }
              }
            });

            backendWs.on('close', () => {
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `🔌 [${service.name}] 后端 WebSocket 连接关闭` });
              }
              if (ws !== null && !wsState.closing) {
                wsState.closing = true;
                ws.close();
              }
            });

            backendWs.on('error', (err: Error) => {
              this.logger.error({ msg: `❌ [${service.name}] 后端 WebSocket 错误`, error: err.message });
              wsState.closing = true;
              if (ws !== null) {
                ws.close();
              }
            });

            backendWs.on('pause', () => {
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `⏸️ [${service.name}] 后端 WebSocket 暂停（背压）` });
              }
            });

            backendWs.on('resume', () => {
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `▶️ [${service.name}] 后端 WebSocket 恢复` });
              }
            });

          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error({ msg: `❌ [${service.name}] WebSocket 连接失败`, error: message });
            if (ws !== null) {
              ws.close();
            }
          }
        })();
      },

      message: (ws: WebSocket<Record<string, unknown>>, message: ArrayBuffer, _isBinary: boolean) => {
        const userData = ws.getUserData();
        const service = userData.service as ServiceConfig;
        const wsState = (ws as unknown as Record<string, unknown>).wsState as {
          backendReady: boolean;
          messageQueue: Buffer[];
          backendWs?: WS;
        };

        if (wsState.backendReady && wsState.backendWs && wsState.backendWs.readyState === WS.OPEN) {
          const msgBuffer = Buffer.from(message);
          if (this.logging.enableWebSocketLog) {
            this.logger.info({ msg: `📨 [${service.name}] 转发消息到后端: ${msgBuffer.length} 字节` });
          }
          wsState.backendWs.send(msgBuffer);
          service._state!.lastAccessTime = Date.now();
        } else {
          if (this.logging.enableWebSocketLog) {
            this.logger.info({ msg: `📦 [${service.name}] 消息加入队列` });
          }
          if (wsState.messageQueue.length < GatewayConstants.MAX_WS_MESSAGE_QUEUE_SIZE) {
            wsState.messageQueue.push(Buffer.from(message));
          }
        }
      },

      close: (ws: WebSocket<Record<string, unknown>>) => {
        const userData = ws.getUserData();
        const service = userData.service as ServiceConfig;
        service._state!.activeConnections--;

        if (this.logging.enableWebSocketLog) {
          this.logger.info({ msg: `🔌 [${service.name}] 客户端 WebSocket 连接关闭` });
        }

        const wsState = (ws as unknown as Record<string, unknown>).wsState as {
          backendWs?: WS;
          closing?: boolean;
        } | undefined;

        if (wsState?.backendWs && wsState.backendWs.readyState === WS.OPEN) {
          wsState.closing = true;
          wsState.backendWs.close();
        }
      },
    });

    app.any('/*', (res: HttpResponse, req: HttpRequest) => {
      this.handleRequest(res, req);
    });

    app.listen(host, port, (token: unknown) => {
      if (token) {
        this.logger.info({ msg: `DynaPM 网关已启动: http://${host}:${port}` });
      } else {
        this.logger.error({ msg: `❌ DynaPM 网关启动失败: ${host}:${port}` });
      }
    });

    for (const [portNum, mapping] of this.portRoutes) {
      this.createPortBindingListener(host, portNum, mapping);
    }

    const adminApiConfig = this.config.adminApi;
    if (adminApiConfig && adminApiConfig.enabled !== false && adminApiConfig.port) {
      this.createAdminApiListener(host, adminApiConfig.port);
    }
  }

  /**
   * 为管理 API 创建监听器
   */
  private createAdminApiListener(host: string, port: number): void {
    const app = uWS.App();

    app.any('/*', (res: HttpResponse, req: HttpRequest) => {
      this.adminApi.handleAdminApi(res, req);
    });

    app.listen(host, port, (token: unknown) => {
      if (token) {
        this.logger.info({ msg: `🔌 管理 API 已启动: http://${host}:${port}` });
      } else {
        this.logger.error({ msg: `❌ 管理 API 启动失败: ${host}:${port}` });
      }
    });
  }

  /**
   * 为指定端口创建监听器
   */
  private createPortBindingListener(host: string, portNum: number, mapping: RouteMapping): void {
    const { service, target } = mapping;

    const app = uWS.App();

    app.ws('/*', {
      upgrade: (res: HttpResponse, req: HttpRequest, context) => {
        service._state!.lastAccessTime = Date.now();

        const clientHeaders: Record<string, string> = {};
        req.forEach((key: string, value: string) => {
          const safeValue = value.replace(GatewayConstants.CRLF_REGEX, '');
          clientHeaders[key] = safeValue;
        });

        const clientPath = req.getUrl() + (req.getQuery() ? `?${req.getQuery()}` : '');

        res.upgrade(
          {
            service,
            target,
            clientHeaders,
            clientPath,
          },
          req.getHeader('sec-websocket-key'),
          req.getHeader('sec-websocket-protocol'),
          req.getHeader('sec-websocket-extensions'),
          context
        );

        if (this.logging.enableWebSocketLog) {
          this.logger.info({ msg: `🔌 [${service.name}] 端口${portNum} WebSocket 升级请求: ${clientPath}` });
        }
      },

      open: (ws: WebSocket<Record<string, unknown>>) => {
        const userData = ws.getUserData();
        const svc = userData.service as ServiceConfig;
        const backendTarget = userData.target as string;

        svc._state!.activeConnections++;
        if (this.logging.enableWebSocketLog) {
          this.logger.info({ msg: `🔌 [${svc.name}] 端口${portNum} WebSocket 连接已建立` });
        }

        const wsState = {
          backendReady: false,
          messageQueue: [] as Buffer[],
          backendWs: undefined as WS | undefined,
          closing: false,
        };
        (ws as unknown as Record<string, unknown>).wsState = wsState;

        (async () => {
          try {
            const needsStart = svc._state!.status === 'offline';

            if (needsStart) {
              this.logger.info({ msg: `🚀 [${svc.name}] 端口${portNum} WebSocket - 启动服务...` });
              svc._state!.status = 'starting';

              await this.serviceManager.start(svc);

              const waitStartTime = Date.now();
              let isReady = false;
              while (Date.now() - waitStartTime < svc.startTimeout) {
                isReady = await checkTcpPort(backendTarget);
                if (isReady) {
                  const waitDuration = Date.now() - waitStartTime;
                  this.logger.info({
                    msg: `✅ [${svc.name}] 端口${portNum} WebSocket 服务就绪 (等待${formatTime(waitDuration)})`,
                  });
                  break;
                }
                await new Promise(resolve => setTimeout(resolve, GatewayConstants.BACKEND_READY_CHECK_DELAY));
              }

              if (!isReady) {
                svc._state!.status = 'offline';
                this.logger.error({ msg: `❌ [${svc.name}] 端口${portNum} WebSocket 服务启动超时` });
                ws.close();
                return;
              }

              svc._state!.status = 'online';
              svc._state!.startTime = Date.now();
              svc._state!.startCount++;
            }

            const targetUrl = new URL(backendTarget);
            const wsUserData = ws.getUserData();
            const clientPath = wsUserData.clientPath as string;
            const clientHeaders = wsUserData.clientHeaders as Record<string, string>;
            const wsUrl = `${targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${targetUrl.host}${clientPath}`;

            if (this.logging.enableWebSocketLog) {
              this.logger.info({ msg: `🔌 [${svc.name}] 端口${portNum} 连接后端 WebSocket: ${wsUrl}` });
            }

            const backendHeaders: Record<string, string> = {};
            const skipHeaders = GatewayConstants.WS_SKIP_HEADERS;

            for (const [key, value] of Object.entries(clientHeaders)) {
              if (!skipHeaders.has(key.toLowerCase())) {
                backendHeaders[key] = value;
              }
            }

            backendHeaders['Host'] = targetUrl.host;

            const backendWs = new WS(wsUrl, { headers: backendHeaders });
            wsState.backendWs = backendWs;

            backendWs.on('open', () => {
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `✅ [${svc.name}] 端口${portNum} 后端 WebSocket 连接已建立` });
              }
              wsState.backendReady = true;

              while (wsState.messageQueue.length > 0 && backendWs.readyState === WS.OPEN) {
                const msg = wsState.messageQueue.shift();
                if (msg) {
                  backendWs.send(msg);
                }
              }
            });

            backendWs.on('message', (data: Buffer, isBinary: boolean) => {
              if (ws !== null) {
                ws.send(data, isBinary, false);
              }
            });

            backendWs.on('close', () => {
              if (ws !== null && !wsState.closing) {
                wsState.closing = true;
                ws.close();
              }
            });

            backendWs.on('error', () => {
              wsState.closing = true;
              if (ws !== null) {
                ws.close();
              }
            });

          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error({ msg: `❌ [${service.name}] WebSocket 连接失败`, error: message });
            if (ws !== null) {
              ws.close();
            }
          }
        })();
      },

      message: (ws: WebSocket<Record<string, unknown>>, message: ArrayBuffer, _isBinary: boolean) => {
        const userData = ws.getUserData();
        const svc = userData.service as ServiceConfig;
        const wsState = (ws as unknown as Record<string, unknown>).wsState as {
          backendReady: boolean;
          messageQueue: Buffer[];
          backendWs?: WS;
        };

        if (wsState.backendReady && wsState.backendWs && wsState.backendWs.readyState === WS.OPEN) {
          wsState.backendWs.send(Buffer.from(message));
          svc._state!.lastAccessTime = Date.now();
        } else {
          if (wsState.messageQueue.length < GatewayConstants.MAX_WS_MESSAGE_QUEUE_SIZE) {
            wsState.messageQueue.push(Buffer.from(message));
          }
        }
      },

      close: (ws: WebSocket<Record<string, unknown>>) => {
        const userData = ws.getUserData();
        const svc = userData.service as ServiceConfig;
        svc._state!.activeConnections--;

        const wsState = (ws as unknown as Record<string, unknown>).wsState as {
          backendWs?: WS;
          closing?: boolean;
        } | undefined;

        if (wsState?.backendWs && wsState.backendWs.readyState === WS.OPEN) {
          wsState.closing = true;
          wsState.backendWs.close();
        }
      },
    });

    app.any('/*', (res: HttpResponse, req: HttpRequest) => {
      this.handlePortBindingRequest(res, req, mapping);
    });

    app.listen(host, portNum, (token: unknown) => {
      if (token) {
        this.logger.info({ msg: `🔌 端口绑定已启动: http://${host}:${portNum} -> ${service.name}` });
      } else {
        this.logger.error({ msg: `❌ 端口绑定启动失败: ${host}:${portNum}` });
      }
    });
  }

  /**
   * 清理所有正在运行的服务
   */
  async cleanup(): Promise<void> {
    this.logger.info({ msg: '🧹 正在清理所有服务...' });

    const cleanedServices = new Set<ServiceConfig>();

    for (const mapping of this.hostnameRoutes.values()) {
      cleanedServices.add(mapping.service);
    }
    for (const mapping of this.portRoutes.values()) {
      cleanedServices.add(mapping.service);
    }

    const stopPromises: Promise<void>[] = [];
    for (const service of cleanedServices) {
      if (service._state!.status === 'online' || service._state!.status === 'starting') {
        stopPromises.push(
          this.serviceManager.stop(service).catch((err: Error) => {
            this.logger.error({ msg: `❌ [${service.name}] 停止失败`, error: err.message });
          })
        );
      }
    }

    await Promise.all(stopPromises);

    this.logger.info({ msg: `✅ 已清理 ${cleanedServices.size} 个服务` });
  }
}
