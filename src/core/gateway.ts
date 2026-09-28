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
import { checkTcpPort, HealthChecker } from './health-checker.js';
import { pipeTcpSockets } from './tcp-pipe.js';
import { HttpUpgradeSniffer } from './upgrade-sniffer.js';
import { formatTime } from '../utils/format.js';

/**
 * 收集 uWS 请求体为 Buffer
 * 在 onData 的 isLast 回调中完成收集
 * 超过 MAX_REQUEST_BODY_SIZE 时截断并返回已收集的数据
 *
 * 重要：uWS 的 onData 回调中的 ArrayBuffer 是借用的，
 * 回调返回后会被回收，必须在回调内复制数据。
 */
function collectRequestBody(res: HttpResponse): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;

    res.onData((ab: ArrayBuffer, isLast: boolean) => {
      if (resolved) return;

      /** allocUnsafe 安全：Buffer.from(ab).copy(chunk) 立即覆盖所有字节 */
      const chunk = Buffer.allocUnsafe(ab.byteLength);
      Buffer.from(ab).copy(chunk);
      totalSize += chunk.length;

      if (totalSize > GatewayConstants.MAX_REQUEST_BODY_SIZE) {
        resolved = true;
        /** 超限：返回 413 并结束响应，返回 null 表示不转发 */
        res.cork(() => {
          res.writeStatus('413 Payload Too Large');
          res.end('Payload Too Large');
        });
        resolve(null);
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

/** HTTP 状态码消息映射（模块级常量，避免每次请求创建新对象） */
const HTTP_STATUS_MESSAGES: Readonly<Record<number, string>> = {
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

/** 获取 HTTP 状态消息 */
function getStatusMessage(statusCode: number): string {
  return HTTP_STATUS_MESSAGES[statusCode] || 'Unknown';
}

/** 网关常量 */
const GatewayConstants = {
  /** 闲置检查间隔（毫秒） */
  IDLE_CHECK_INTERVAL: 3000,
  /** TCP 端口检查超时（毫秒） */
  TCP_CHECK_TIMEOUT: 100,
  /** 后端就绪检查延迟（毫秒） */
  BACKEND_READY_CHECK_DELAY: 50,
  /** 冷启动重试间隔（毫秒）：首批快速重试，维持快速就绪即转发的低延迟 */
  BACKEND_RETRY_FAST_MS: 2,
  /** 冷启动重试退避上限（毫秒） */
  BACKEND_RETRY_MAX_MS: 50,
  /** 冷启动重试退避倍率 */
  BACKEND_RETRY_BACKOFF: 1.5,
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
 * 代理请求状态跟踪
 */
interface ProxyState {
  /** 客户端是否已断开连接 */
  aborted: boolean;
  /** 是否已发送响应（防止重复响应） */
  responded: boolean;
  /** 代理请求是否超时（用于区分 504 vs 502） */
  timedOut: boolean;
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
  /** HTTP keep-alive 连接池：serviceName -> Agent（避免每请求新建 TCP 连接） */
  private agentPool = new Map<string, http.Agent>();
  /** 每服务的 Agent 池参数（initServices 时从 ServiceConfig.agent 登记） */
  private serviceAgentOptions = new Map<string, NonNullable<ServiceConfig['agent']>>();
  /** 等待服务停止完成的超时上限（毫秒，可配置注入） */
  private stopWaitMs: number;
  /** 代理请求超时（毫秒，可配置注入） */
  private proxyTimeoutMs: number;
  /** 健康检查器：按服务 healthCheck.type 分派就绪检查（默认 tcp 保持原有快速轮询语义） */
  private healthChecker = new HealthChecker();

  constructor(private config: DynaPMConfig, logger: Logger) {
    this.logger = logger;
    this.stopWaitMs = config.timeouts?.stopWaitMs ?? 30000;
    this.proxyTimeoutMs = config.timeouts?.proxyTimeoutMs ?? 30000;
    this.logging = {
      enableRequestLog: config.logging?.enableRequestLog ?? false,
      enableWebSocketLog: config.logging?.enableWebSocketLog ?? false,
      enablePerformanceLog: config.logging?.enablePerformanceLog ?? false,
    };
    this.adminApi = new AdminApiHandler(config, logger, this.hostnameRoutes, this.portRoutes, this.serviceManager, this);
    this.initServices();
    this.initIdleChecker();
  }

  /**
   * 等待后端就绪：按服务 healthCheck.type 分派检查，默认 tcp 沿用原有快速轮询语义
   * @param service - 服务配置（含 healthCheck 与 startTimeout）
   * @param targetHost - 目标主机
   * @param targetPort - 目标端口
   * @param retryDelayMs - 未就绪时的重试间隔（毫秒）：传 0 时使用内置退避（首试 2ms，上限 50ms）；传正值则固定间隔（WS 路径 50ms）
   * @returns 是否在 startTimeout 内就绪
   */
  private async waitForBackendReady(service: ServiceConfig, targetHost: string, targetPort: number, retryDelayMs: number): Promise<boolean> {
    const waitStartTime = Date.now();
    let isReady = false;
    let delay = retryDelayMs > 0 ? retryDelayMs : GatewayConstants.BACKEND_RETRY_FAST_MS;
    while (Date.now() - waitStartTime < service.startTimeout) {
      isReady = await this.healthChecker.checkTarget(service, targetHost, targetPort);
      if (isReady) {
        const waitDuration = Date.now() - waitStartTime;
        this.logger.info({
          msg: `✅ [${service.name}] 服务就绪 (等待${formatTime(waitDuration)})`,
        });
        break;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      if (retryDelayMs <= 0) {
        delay = Math.min(delay * GatewayConstants.BACKEND_RETRY_BACKOFF, GatewayConstants.BACKEND_RETRY_MAX_MS);
      }
    }
    return isReady;
  }

  /**
   * 获取服务对应的 keep-alive Agent（按服务缓存，跨路由共享）
   * 后端重启导致池中 socket 失效时，socket 会触发 error 由请求侧 error handler 兜底，
   * Agent 会自动移除失效 socket，后续请求重建连接。
   */
  private getAgent(serviceName: string): http.Agent {
    let agent = this.agentPool.get(serviceName);
    if (!agent) {
      const agentOptions = this.serviceAgentOptions.get(serviceName);
      const created = new http.Agent({
        keepAlive: true,
        keepAliveMsecs: agentOptions?.keepAliveMsecs ?? 30000,
        maxSockets: agentOptions?.maxSockets ?? 256,
        maxFreeSockets: agentOptions?.maxFreeSockets ?? 32,
      });
      /** 显式开启 TCP_NODELAY：消除对 Node 默认行为的隐式依赖，降低小包转发延迟。
       *  覆写 Agent 的 createConnection，新建 socket 后立即 setNoDelay */
      const originalCreateConnection = created.createConnection.bind(created);
      const patched = created as unknown as {
        createConnection: (...args: unknown[]) => net.Socket | undefined;
      };
      patched.createConnection = (...args: unknown[]) => {
        const socket = originalCreateConnection(...(args as Parameters<http.Agent['createConnection']>)) as net.Socket | undefined;
        if (socket) socket.setNoDelay(true);
        return socket;
      };
      agent = created;
      this.agentPool.set(serviceName, agent);
    }
    return agent;
  }

  /**
   * 登记服务的 Agent 池参数（initServices 时调用，供 getAgent 建池时消费）
   */
  private rememberAgentOptions(service: ServiceConfig): void {
    if (service.agent) {
      this.serviceAgentOptions.set(service.name, service.agent);
    }
  }

  /**
   * 查询服务是否仍持有 keep-alive Agent（测试与运维观测用）
   */
  isAgentActive(serviceName: string): boolean {
    return this.agentPool.has(serviceName);
  }

  /**
   * 清理服务的 keep-alive Agent：销毁空闲 socket（含 keep-alive 定时器）并从池中移除
   * 服务停止/闲置回收后必须调用，否则空闲 socket 与定时器泄漏 FD
   */
  cleanupAgent(serviceName: string): void {
    const agent = this.agentPool.get(serviceName);
    if (agent) {
      agent.destroy();
      this.agentPool.delete(serviceName);
      this.logger.info({ msg: `♻️ [${serviceName}] Agent 池已清理` });
    }
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
      // 登记该服务的 Agent 池参数（供 getAgent 建池时消费）
      this.rememberAgentOptions(service);

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
        this.cleanupAgent(service.name);
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
    const method = req.getCaseSensitiveMethod();
    const url = req.getUrl();
    const queryString = req.getQuery();
    const fullUrl = queryString ? url + '?' + queryString : url;

    const headers: Record<string, string> = {};
    const crlfRegex = GatewayConstants.CRLF_REGEX;
    req.forEach((key: string, value: string) => {
      headers[key] = (value.includes('\r') || value.includes('\n'))
        ? value.replace(crlfRegex, '')
        : value;
    });

    service._state!.lastAccessTime = startTime;

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
    const method = req.getCaseSensitiveMethod();
    const url = req.getUrl();
    const queryString = req.getQuery();
    const fullUrl = queryString ? url + '?' + queryString : url;

    const mapping = this.hostnameRoutes.get(hostname);

    if (!mapping) {
      this.logger.info({ msg: `❌ [${hostname}] ${method} ${fullUrl} - 404` });
      res.cork(() => {
        res.writeStatus('404 Not Found');
        res.end(`Service not found: ${hostname}`);
      });
      return;
    }

    const headers: Record<string, string> = {};
    const crlfRegex = GatewayConstants.CRLF_REGEX;
    req.forEach((key: string, value: string) => {
      /** 快速路径：正常请求无 CRLF 字符，用 indexOf 跳过正则替换 */
      headers[key] = (value.includes('\r') || value.includes('\n'))
        ? value.replace(crlfRegex, '')
        : value;
    });

    const service = mapping.service;
    service._state!.lastAccessTime = startTime;

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
    /** 保底消费：启动失败时若尚无并发等待者，被 reject 的 promise 会变成 unhandledRejection 直接杀死进程。
     *  挂一个空 catch 不影响后续 await（await 拿到的是同一个 promise 的 rejection） */
    startPromise.catch(() => {});
    this.startingPromises.set(service.name, startPromise);

    try {
      await this.serviceManager.start(service);

      const isReady = await this.waitForBackendReady(
        service,
        mapping.targetUrl!.hostname,
        mapping.targetPort,
        0
      );


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
      /** 启动失败后将状态复位为 offline，允许后续请求重新按需启动（否则卡死在 starting，后续请求会直接代理到死端口） */
      if (service._state!.status === 'starting') {
        service._state!.status = 'offline';
      }
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
      const maxWaitTime = this.stopWaitMs;
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
      /** 超限请求已在 collectRequestBody 中返回 413，不再转发 */
      if (body === null) return;
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
      /** 超限请求已在 collectRequestBody 中返回 413，不再转发 */
      if (body === null) return;
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
      /** 超限请求已在 collectRequestBody 中返回 413，不再转发 */
      if (body === null) return;
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

    // 构建代理请求头（uWS forEach 的 key 已经是小写，无需 toLowerCase）
    const proxyHeaders: Record<string, string> = {};
    const skipHeaders = GatewayConstants.SKIP_REQUEST_HEADERS;
    for (const key in headers) {
      if (skipHeaders.has(key)) {
        continue;
      }
      proxyHeaders[key] = headers[key];
    }
    proxyHeaders['host'] = targetUrl.host;

    const state: ProxyState = { aborted: false, responded: false, timedOut: false };
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
      method,
      headers: proxyHeaders,
      agent: this.getAgent(service.name),
      timeout: this.proxyTimeoutMs,
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
          for (const key in proxyRes.headers) {
            if (GatewayConstants.SKIP_RESPONSE_HEADERS.has(key)) continue;
            const value = proxyRes.headers[key];
            if (value) res.writeHeader(key, typeof value === 'string' ? value : value.join(', '));
          }
          res.end();
          state.responded = true;
        });
        cleanup();
        return;
      }

      // 设置响应头（proxyRes.headers 的 key 已经是小写的，无需 toLowerCase）
      res.cork(() => {
        if (state.aborted) return;
        res.writeStatus(`${statusCode} ${statusMessage}`);
        for (const key in proxyRes.headers) {
          if (GatewayConstants.SKIP_RESPONSE_HEADERS.has(key)) continue;
          const value = proxyRes.headers[key];
          if (value) res.writeHeader(key, typeof value === 'string' ? value : value.join(', '));
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
          if (state.timedOut) {
            res.writeStatus('504 Gateway Timeout');
            res.end('Gateway Timeout');
          } else {
            res.writeStatus('502 Bad Gateway');
            res.end('Bad Gateway');
          }
        });
      }
      /** 后端不可达时，将非 proxyOnly 服务状态重置为 offline，允许后续按需启动 */
      if (!service.proxyOnly && service._state!.status === 'online') {
        this.logger.info({ msg: `🔄 [${service.name}] 后端不可达，重置状态为 offline` });
        service._state!.status = 'offline';
      }
      cleanup();
    });

    /** 代理请求超时处理：设置标志后销毁连接，error handler 据此返回 504 */
    proxyReq.on('timeout', () => {
      this.logger.error({ msg: `⏱️ [${service.name}] 代理请求超时` });
      state.timedOut = true;
      proxyReq.destroy();
    });

    // 边收请求体边写入代理请求（真正的双向流式）
    let directBodySize = 0;
    let directResponded = false;
    res.onData((ab: ArrayBuffer, isLast: boolean) => {
      if (state.aborted) {
        proxyReq.destroy();
        return;
      }

      /** uWS 的 ArrayBuffer 是借用语义，必须复制数据（allocUnsafe 安全：copy 立即覆盖所有字节） */
      const chunk = Buffer.allocUnsafe(ab.byteLength);
      Buffer.from(ab).copy(chunk);
      directBodySize += chunk.length;

      /** 请求体超限：销毁代理请求，返回 413，不再转发 */
      if (directBodySize > GatewayConstants.MAX_REQUEST_BODY_SIZE && !directResponded) {
        directResponded = true;
        state.responded = true;
        proxyReq.destroy();
        this.logger.warn({ msg: `⚠️ [${service.name}] 请求体超过 ${GatewayConstants.MAX_REQUEST_BODY_SIZE} 字节，返回 413` });
        res.cork(() => {
          if (state.aborted) return;
          res.writeStatus('413 Payload Too Large');
          res.end('Payload Too Large');
        });
        cleanup();
        return;
      }

      if (isLast) {
        if (!directResponded) proxyReq.end(chunk);
      } else {
        if (!directResponded) proxyReq.write(chunk);
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

    // 构建代理请求头（uWS forEach 的 key 已经是小写，无需 toLowerCase）
    const proxyHeaders: Record<string, string> = {};
    const skipHeaders = GatewayConstants.SKIP_REQUEST_HEADERS;
    for (const key in headers) {
      if (skipHeaders.has(key)) {
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

    const state: ProxyState = { aborted: false, responded: false, timedOut: false };
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
          method,
          headers: proxyHeaders,
          agent: this.getAgent(service.name),
          timeout: this.proxyTimeoutMs,
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

              for (const key in proxyRes.headers) {
                if (GatewayConstants.SKIP_RESPONSE_HEADERS.has(key)) {
                  continue;
                }
                const value = proxyRes.headers[key];
                if (value) {
                  res.writeHeader(key, typeof value === 'string' ? value : value.join(', '));
                }
              }
              res.end();
              state.responded = true;
            });

            cleanup();
            resolve();
            return;
          }

          // 设置响应头（proxyRes.headers 的 key 已经是小写的，无需 toLowerCase）
          res.cork(() => {
            if (state.aborted) return;
            res.writeStatus(`${statusCode} ${statusMessage}`);

            for (const key in proxyRes.headers) {
              if (GatewayConstants.SKIP_RESPONSE_HEADERS.has(key)) {
                continue;
              }
              const value = proxyRes.headers[key];
              if (value) {
                res.writeHeader(key, typeof value === 'string' ? value : value.join(', '));
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
              if (state.timedOut) {
                res.writeStatus('504 Gateway Timeout');
                res.end('Gateway Timeout');
              } else {
                res.writeStatus('502 Bad Gateway');
                res.end('Bad Gateway');
              }
            });
          }
          cleanup();
          reject(err);
        });

        /** 代理请求超时处理：设置标志后销毁连接，error handler 据此返回 504 */
        proxyReq.on('timeout', () => {
          this.logger.error({ msg: `⏱️ [${service.name}] 代理请求超时` });
          state.timedOut = true;
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

    // WebSocket 处理器（hostname 路由：upgrade 时按 Host 头解析目标服务）
    app.ws('/*', this.createWsProxyBehavior({
      resolveContext: (res, req) => {
        const hostname = req.getHeader('host')?.split(':')[0] || '';
        const mapping = this.hostnameRoutes.get(hostname);

        if (!mapping) {
          res.cork(() => {
            res.writeStatus('404 Not Found');
            res.end(`Service not found: ${hostname}`);
          });
          return null;
        }

        return { service: mapping.service, target: mapping.target, hostname };
      },
    }));

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
   * 创建可复用的 WebSocket 代理 uWS behavior
   * hostname 路由与端口路由共用同一实现，差异仅在于 upgrade 时的目标解析方式（resolveContext）
   * open 后按需启动服务、等待就绪（走 HealthChecker，默认 tcp）、建立后端 WS 并双向转发；
   * 客户端->后端方向带消息队列，后端->客户端方向带背压处理（ws.send 返回 false 时 pause 后端，drain 恢复）
   */
  private createWsProxyBehavior(options: {
    /**
     * upgrade 阶段解析路由目标
     * @param res - uWS 响应对象（用于 404）
     * @param req - uWS 请求对象
     * @returns 解析结果；返回 null 表示路由未命中（已回应 404，不再 upgrade）
     */
    resolveContext: (res: HttpResponse, req: HttpRequest) => { service: ServiceConfig; target: string } | null;
  }): uWS.WebSocketBehavior<Record<string, unknown>> {

    return {
      /** 单帧最大 16MB：uWS 默认仅 4KB 级别，思源等场景的大同步块（2MB+）会被静默断连（1006） */
      maxPayloadLength: 16 * 1024 * 1024,
      upgrade: (res: HttpResponse, req: HttpRequest, context) => {
        const resolved = options.resolveContext(res, req);
        if (!resolved) return;

        const { service, target } = resolved;
        service._state!.lastAccessTime = Date.now();

        const clientHeaders: Record<string, string> = {};
        req.forEach((key: string, value: string) => {
          const safeValue = value.replace(GatewayConstants.CRLF_REGEX, '');
          clientHeaders[key] = safeValue;
        });

        const clientPath = req.getUrl() + (req.getQuery() ? `?${req.getQuery()}` : '');

        /** 客户端请求的子协议，透传给后端 */
        const clientProtocols = req.getHeader('sec-websocket-protocol')
          ? req.getHeader('sec-websocket-protocol').split(',').map((p) => p.trim()).filter(Boolean)
          : undefined;

        res.upgrade(
          {
            service,
            target,
            clientHeaders,
            clientPath,
            clientProtocols,
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
          messageQueue: [] as { data: Buffer; isBinary: boolean }[],
          backendWs: undefined as WS | undefined,
          closing: false,
        };
        (ws as unknown as Record<string, unknown>).wsState = wsState;

        (async () => {
          try {
            const needsStart = service._state!.status === 'offline';
            const targetUrl = new URL(target);
            const targetPort = parseInt(targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80'));

            if (needsStart) {
              this.logger.info({ msg: `🚀 [${service.name}] WebSocket - 启动服务...` });
              service._state!.status = 'starting';

              await this.serviceManager.start(service);

              const isReady = await this.waitForBackendReady(service, targetUrl.hostname, targetPort, GatewayConstants.BACKEND_READY_CHECK_DELAY);

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

            const wsUserData = ws.getUserData();
            const clientPath = wsUserData.clientPath as string;
            const clientHeaders = wsUserData.clientHeaders as Record<string, string>;
            const wsUrl = `${targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${targetUrl.host}${clientPath}`;

            if (this.logging.enableWebSocketLog) {
              this.logger.info({ msg: `🔌 [${service.name}] 连接后端 WebSocket: ${wsUrl}` });
            }

            const backendHeaders: Record<string, string> = {};
            const skipHeaders = GatewayConstants.WS_SKIP_HEADERS;

            for (const key in clientHeaders) {
              if (!skipHeaders.has(key)) {
                backendHeaders[key] = clientHeaders[key];
              }
            }

            backendHeaders['Host'] = targetUrl.host;

            /** 子协议透传：ws 库第二参数 protocols 握手时带 sec-websocket-protocol 头 */
            const clientProtocols = wsUserData.clientProtocols as string[] | undefined;
            const backendWs = clientProtocols && clientProtocols.length > 0
              ? new WS(wsUrl, clientProtocols, { headers: backendHeaders })
              : new WS(wsUrl, { headers: backendHeaders });
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
                const queued = wsState.messageQueue.shift();
                if (queued) {
                  backendWs.send(queued.data, { binary: queued.isBinary });
                }
              }
            });

            backendWs.on('message', (data: Buffer, isBinary: boolean) => {
              if (ws !== null) {
                const success = ws.send(data, isBinary, false);
                if (!success) {
                  /** 客户端侧背压：暂停后端读取，客户端可写（drain）后重发并恢复 */
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

            backendWs.on('close', (code: number, reason: Buffer) => {
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `🔌 [${service.name}] 后端 WebSocket 连接关闭 code=${code}` });
              }
              if (ws !== null && !wsState.closing) {
                wsState.closing = true;
                /** 透传后端关闭码/原因给客户端（1000/1005 之外的常规透传，异常码原样传递） */
                if (code && code !== 1000 && code !== 1005) {
                  const reasonText = (reason?.toString('utf8') || '').slice(0, 123);
                  ws.end(code, reasonText);
                } else {
                  ws.close();
                }
              }
            });

            /** 转发后端协议层 ping 帧给客户端，保证客户端心跳 pong 可感知 */
            backendWs.on('ping', (data: Buffer) => {
              if (ws !== null) {
                ws.cork(() => {
                  ws.ping(data);
                });
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

      message: (ws: WebSocket<Record<string, unknown>>, message: ArrayBuffer, isBinary: boolean) => {
        const userData = ws.getUserData();
        const service = userData.service as ServiceConfig;
        const wsState = (ws as unknown as Record<string, unknown>).wsState as {
          backendReady: boolean;
          messageQueue: { data: Buffer; isBinary: boolean }[];
          backendWs?: WS;
          closing?: boolean;
        };

        /**
         * uWS message 回调的 ArrayBuffer 是借用的（回调返回后会被回收/复用），
         * 必须显式拷贝：Buffer.from(Uint8Array) 才是真实拷贝（Buffer.from(ArrayBuffer) 仅创建视图）
         */
        const msgBuffer = Buffer.from(new Uint8Array(message));

        if (wsState.backendReady && wsState.backendWs && wsState.backendWs.readyState === WS.OPEN) {
          if (this.logging.enableWebSocketLog) {
            this.logger.info({ msg: `📨 [${service.name}] 转发消息到后端: ${msgBuffer.length} 字节 binary=${isBinary}` });
          }
          wsState.backendWs.send(msgBuffer, { binary: isBinary });
          service._state!.lastAccessTime = Date.now();
        } else {
          if (this.logging.enableWebSocketLog) {
            this.logger.info({ msg: `📦 [${service.name}] 消息加入队列` });
          }
          if (wsState.messageQueue.length < GatewayConstants.MAX_WS_MESSAGE_QUEUE_SIZE) {
            wsState.messageQueue.push({ data: msgBuffer, isBinary });
          } else {
            /** 队列超限：记录 warning 并主动关闭连接，让客户端可感知并重连 */
            this.logger.warn({
              msg: `⚠️ [${service.name}] WebSocket 消息队列超过 ${GatewayConstants.MAX_WS_MESSAGE_QUEUE_SIZE} 条，主动关闭连接`,
              service: service.name,
            });
            wsState.closing = true;
            ws.close();
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
    };
  }

  /**
   * 为 passthrough 服务创建端口监听器（纯 TCP 层，绕过 uWS）
   * 架构：
   *  - 外层 net server 监听配置端口，嗅探每个连接的首个 HTTP 请求头
   *  - WS upgrade 连接：按需启动服务、等就绪后整条连接 TCP 直通（原始头字节 + 已缓冲字节原样转发）
   *  - 非 upgrade 的普通 HTTP 连接：pipe 到内部 uWS app（动态 loopback 端口），
   *    复用现有 uWS 流式代理与 WS 代理行为，保持完整可观测性
   */
  private createPassthroughPortListener(host: string, portNum: number, mapping: RouteMapping): void {
    const { service, target } = mapping;
    const targetUrl = new URL(target);
    const targetHost = targetUrl.hostname;
    const targetPort = mapping.targetPort;

    /** 内部 uWS app：承接普通 HTTP 连接（含可能后续出现的 WS upgrade——只有非直通分流会到这） */
    const internalApp = uWS.App();
    internalApp.ws('/*', this.createWsProxyBehavior({
      resolveContext: () => ({ service, target }),
    }));
    internalApp.any('/*', (res: HttpResponse, req: HttpRequest) => {
      this.handlePortBindingRequest(res, req, mapping);
    });

    internalApp.listen('127.0.0.1', 0, (token) => {
      if (!token) {
        this.logger.error({ msg: `❌ [${service.name}] passthrough 内部 uWS 监听失败` });
        return;
      }
      const internalPort = uWS.us_socket_local_port(token);

      const server = net.createServer((client) => {
        const sniffer = new HttpUpgradeSniffer();
        const buffered: Buffer[] = [];
        let routed = false;
        /** 是否已把缓冲字节写出并建立 pipe（写出前到达的字节必须继续缓冲） */
        let piped = false;

        /** 分流：决定连接去向（直通后端 或 内部 uWS） */
        const route = (isUpgrade: boolean, headBytes: Buffer): void => {
          routed = true;
          service._state!.lastAccessTime = Date.now();

          /** 将缓冲字节写出并建立双向 pipe，之后到达的字节由 socket 流直接承载 */
          const flushAndPipe = (socket: net.Socket, onDestroyed: () => void): void => {
            if (headBytes.length > 0) socket.write(headBytes);
            for (const b of buffered) socket.write(b);
            buffered.length = 0;
            piped = true;
            pipeTcpSockets(client, socket, onDestroyed);
          };

          if (!isUpgrade) {
            /** 普通 HTTP：连同已读头字节一起交给内部 uWS（保证字节流不丢不重） */
            const upstream = net.connect({ host: '127.0.0.1', port: internalPort }, () => {
              flushAndPipe(upstream, () => {});
            });
            upstream.on('error', (err: Error) => {
              this.logger.error({ msg: `❌ [${service.name}] passthrough 内部 uWS 连接失败`, error: err.message });
              client.destroy();
            });
            return;
          }

          /** WS upgrade：按需启动 + 就绪等待 + TCP 直通 */
          void (async () => {
            try {
              if (service._state!.status === 'offline' || service._state!.status === 'stopping') {
                await this.ensureServiceOnline(service, mapping);
              }

              const backend = net.connect({ host: targetHost, port: targetPort }, () => {
                if (this.logging.enableWebSocketLog) {
                  this.logger.info({ msg: `⚡ [${service.name}] passthrough WS 直通已建立 -> ${targetHost}:${targetPort}` });
                }
                service._state!.activeConnections++;
                flushAndPipe(backend, () => {
                  service._state!.activeConnections--;
                });
              });
              backend.on('error', (err: Error) => {
                this.logger.error({ msg: `❌ [${service.name}] passthrough 后端连接失败`, error: err.message });
                client.destroy();
              });
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              this.logger.error({ msg: `❌ [${service.name}] passthrough 服务启动失败`, error: message });
              client.destroy();
            }
          })();
        };

        client.on('data', (chunk: Buffer) => {
          if (routed) {
            /** 已分流但 pipe 尚未建立（启动/连接进行中）：继续缓冲，flushAndPipe 时统一写出 */
            if (!piped) buffered.push(chunk);
            return;
          }
          const rest = sniffer.feed(chunk);
          if (!sniffer.parsed) {
            /** 头未完整：先缓冲已读字节，等分片补齐 */
            buffered.push(chunk);
            return;
          }
          const headBytes = Buffer.concat([chunk.subarray(0, chunk.length - rest.length)]);
          buffered.length = 0;
          /** 头结束符之后的剩余字节（body/后续协议帧）也必须原样转发，不能丢弃 */
          if (rest.length > 0) buffered.push(rest);
          route(sniffer.result!.isUpgrade, headBytes);
        });

        client.on('error', (err: Error) => {
          this.logger.error({ msg: `❌ [${service.name}] passthrough 客户端连接错误`, error: err.message });
        });
      });

      server.on('error', (err: Error) => {
        this.logger.error({ msg: `❌ passthrough 端口监听失败: ${portNum}`, error: err.message });
      });

      server.listen(portNum, host, () => {
        this.logger.info({ msg: `⚡ passthrough 端口绑定已启动: ${host}:${portNum} -> ${service.name} (WS 直通 / HTTP 经内部网关)` });
      });
    });
  }

  /**
   * 确保服务在线：offline/stopping 时执行启动命令并等待就绪
   * 复用 startServiceAndProxy 的状态机语义（startingPromises、状态复位），
   * 但不代理任何请求——供 passthrough 直通路径在建立 TCP 连接前调用
   */
  private async ensureServiceOnline(service: ServiceConfig, mapping: RouteMapping): Promise<void> {
    if (service.proxyOnly || service._state!.status === 'online') return;
    if (service._state!.status === 'starting') {
      const pending = this.startingPromises.get(service.name);
      if (pending) await pending;
      return;
    }

    service._state!.status = 'starting';
    let resolveStartPromise!: () => void;
    let rejectStartPromise!: (err: Error) => void;
    const startPromise = new Promise<void>((resolve, reject) => {
      resolveStartPromise = resolve;
      rejectStartPromise = reject;
    });
    startPromise.catch(() => {});
    this.startingPromises.set(service.name, startPromise);

    try {
      await this.serviceManager.start(service);
      const isReady = await this.waitForBackendReady(
        service,
        mapping.targetUrl!.hostname,
        mapping.targetPort,
        GatewayConstants.BACKEND_READY_CHECK_DELAY,
      );
      if (!isReady) {
        service._state!.status = 'offline';
        throw new Error(`服务启动超时: 端口 ${mapping.target} 不可用`);
      }
      service._state!.status = 'online';
      service._state!.startTime = Date.now();
      service._state!.startCount++;
      resolveStartPromise();
      this.startingPromises.delete(service.name);
    } catch (error: unknown) {
      this.startingPromises.delete(service.name);
      if (service._state!.status === 'starting') {
        service._state!.status = 'offline';
      }
      rejectStartPromise!(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 为指定端口创建监听器
   */
  private createPortBindingListener(host: string, portNum: number, mapping: RouteMapping): void {
    const { service, target } = mapping;

    if (service.passthrough) {
      this.createPassthroughPortListener(host, portNum, mapping);
      return;
    }

    const app = uWS.App();

    // WebSocket 处理器（端口路由：upgrade 时目标已由端口绑定确定）
    app.ws('/*', this.createWsProxyBehavior({
      resolveContext: () => ({ service, target }),
    }));

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
      /** 无论服务是否在运行都清理 Agent 池，避免泄漏 */
      this.cleanupAgent(service.name);
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
