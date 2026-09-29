import { ServiceManager } from './service-manager.js';
import type { ServiceConfig, DynaPMConfig } from '../config/types.js';
import net from 'node:net';
import { AdminApiHandler } from './admin-api.js';
import { checkTcpPort, HealthChecker } from './health-checker.js';
import { HttpUpgradeSniffer } from './upgrade-sniffer.js';
import { formatTime } from '../utils/format.js';

/**
 * 连接池语义对齐（Node 版 http.Agent 池的 Bun 等价物）：
 * Bun 的 fetch 内部自带连接复用（keep-alive），无法像 Node 那样按服务精细配置
 * maxSockets/maxFreeSockets，这里用「登记 + 计数 + 停止时清理标记」语义对齐：
 * - 请求代理后池中存在该服务的条目（isAgentActive 语义等价）
 * - 服务停止/闲置回收后从池中移除（cleanupAgent 语义等价）
 * 实际 socket 复用由 Bun fetch 内部连接池承担。
 */
interface AgentPoolEntry {
  /** 池参数（登记用，Bun 下不直接生效） */
  options: NonNullable<ServiceConfig['agent']> | undefined;
  /** 当前在途请求数（观测用） */
  inFlight: number;
}

/** 网关常量（与 Node 版 GatewayConstants 语义对齐） */
const GatewayConstants = {
  /** 闲置检查间隔（毫秒） */
  IDLE_CHECK_INTERVAL: 3000,
  /** 后端就绪检查延迟（毫秒） */
  BACKEND_READY_CHECK_DELAY: 50,
  /** 冷启动重试间隔（毫秒） */
  BACKEND_RETRY_FAST_MS: 2,
  /** 冷启动重试退避上限（毫秒） */
  BACKEND_RETRY_MAX_MS: 50,
  /** 冷启动重试退避倍率 */
  BACKEND_RETRY_BACKOFF: 1.5,
  /** 不应转发的响应头（小写） */
  SKIP_RESPONSE_HEADERS: new Set(['connection', 'transfer-encoding', 'keep-alive', 'content-length']),
  /** 不应转发的请求头（小写） */
  SKIP_REQUEST_HEADERS: new Set(['connection', 'keep-alive', 'content-length', 'transfer-encoding']),
  /** WebSocket 升级时不应转发的请求头（小写） */
  WS_SKIP_HEADERS: new Set(['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version']),
  /** 请求体最大大小（10MB），防止 DoS 攻击 */
  MAX_REQUEST_BODY_SIZE: 10 * 1024 * 1024,
  /** keepWarm 服务默认闲置回收阈值（毫秒） */
  WARM_IDLE_TIMEOUT_DEFAULT: 30 * 1000,
  /** WebSocket 消息队列最大长度（1000 条），防止内存泄漏 */
  MAX_WS_MESSAGE_QUEUE_SIZE: 1000,
} as const;

/**
 * 路由映射信息
 */
interface RouteMapping {
  /** 服务配置 */
  service: ServiceConfig;
  /** 目标后端地址 */
  target: string;
  /** 缓存的目标 URL 对象 */
  targetUrl: URL;
  /** 预计算的目标端口 */
  targetPort: number;
}

/**
 * DynaPM 网关 Bun 版
 * Bun.serve + 原生 fetch 实现，行为与 Node+uWS 版对齐
 */
export class BunGateway {
  private serviceManager = new ServiceManager();
  /** 主机名路由：hostname -> 路由映射信息 */
  private hostnameRoutes: Map<string, RouteMapping> = new Map();
  /** 端口路由：端口 -> 路由映射信息 */
  private portRoutes: Map<number, RouteMapping> = new Map();
  /** 日志记录器（pino 兼容接口） */
  private logger: { info: (obj: { msg: string; error?: unknown; service?: string }) => void; error: (obj: { msg: string; error?: unknown; service?: string }) => void; warn: (obj: { msg: string; error?: unknown; service?: string }) => void };
  /** 日志配置 */
  private logging: { enableRequestLog: boolean; enableWebSocketLog: boolean };
  /** 管理 API 处理器 */
  private adminApi: AdminApiHandler;
  /** 服务启动 Promise 追踪：serviceName -> 启动完成 Promise */
  private startingPromises = new Map<string, Promise<void>>();
  /** 连接池登记：serviceName -> 条目（Bun fetch 连接复用语义对齐层） */
  private agentPool = new Map<string, AgentPoolEntry>();
  /** 等待服务停止完成的超时上限（毫秒） */
  private stopWaitMs: number;
  /** 代理请求超时（毫秒） */
  private proxyTimeoutMs: number;
  /** 健康检查器 */
  private healthChecker = new HealthChecker();
  /** Bun.serve 实例集合（cleanup 时停止） */
  private servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
  /** passthrough TCP 监听器集合（cleanup 时停止） */
  private tcpListeners: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
  /** 闲置检查器定时器 */
  private idleTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private config: DynaPMConfig, logger: BunGateway['logger']) {
    this.logger = logger;
    this.stopWaitMs = config.timeouts?.stopWaitMs ?? 30000;
    this.proxyTimeoutMs = config.timeouts?.proxyTimeoutMs ?? 30000;
    this.logging = {
      enableRequestLog: config.logging?.enableRequestLog ?? false,
      enableWebSocketLog: config.logging?.enableWebSocketLog ?? false,
    };
    this.adminApi = new AdminApiHandler(config, logger, this.hostnameRoutes, this.portRoutes, this.serviceManager, this);
    this.initServices();
    this.initIdleChecker();
  }

  /**
   * 等待后端就绪：按服务 healthCheck.type 分派检查，默认 tcp 快速轮询
   * @param service - 服务配置
   * @param targetHost - 目标主机
   * @param targetPort - 目标端口
   * @param retryDelayMs - 未就绪时重试间隔；传 0 时使用内置退避
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
        this.logger.info({ msg: `✅ [${service.name}] 服务就绪 (等待${formatTime(waitDuration)})` });
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
   * 查询服务是否仍持有连接池条目（Node 版 isAgentActive 语义等价）
   */
  isAgentActive(serviceName: string): boolean {
    return this.agentPool.has(serviceName);
  }

  /**
   * 清理服务的连接池登记：Node 版 cleanupAgent 语义等价。
   * Bun fetch 的底层 socket 无法按服务定向销毁，这里移除登记条目；
   * 后端停止后池中旧 socket 首次复用失败时 Bun 会自动重建连接。
   */
  cleanupAgent(serviceName: string): void {
    if (this.agentPool.delete(serviceName)) {
      this.logger.info({ msg: `♻️ [${serviceName}] Agent 池已清理` });
    }
  }

  /**
   * 获取（或创建）服务的连接池登记条目
   */
  private getAgentEntry(serviceName: string, service: ServiceConfig): AgentPoolEntry {
    let entry = this.agentPool.get(serviceName);
    if (!entry) {
      entry = { options: service.agent, inFlight: 0 };
      this.agentPool.set(serviceName, entry);
    }
    return entry;
  }

  /**
   * 初始化服务映射和端口绑定
   */
  private initServices(): void {
    if (!this.config.services) {
      return;
    }
    console.log('[DynaPM-Bun] 初始化服务...');
    console.log('[DynaPM-Bun] 服务数量:', Object.keys(this.config.services).length);

    for (const service of Object.values(this.config.services)) {
      service._state = {
        status: service.proxyOnly ? 'online' : 'offline',
        lastAccessTime: Date.now(),
        activeConnections: 0,
        startCount: 0,
        totalUptime: 0,
      };

      const routes = service.routes || [];
      if (routes.length === 0) {
        console.warn(`[DynaPM-Bun] ⚠️  [${service.name}] 没有配置路由`);
        continue;
      }

      console.log(`[DynaPM-Bun] ✅ [${service.name}] 配置了 ${routes.length} 个路由:`);

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
          console.log(`[DynaPM-Bun]   └─ hostname: ${hostname} -> ${route.target}`);
        } else if (route.type === 'port') {
          const port = route.value as number;
          this.portRoutes.set(port, mapping);
          console.log(`[DynaPM-Bun]   └─ port: ${port} -> ${route.target}`);
        }
      }
    }

    const hostnameCount = this.hostnameRoutes.size;
    const portCount = this.portRoutes.size;
    console.log(`[DynaPM-Bun] 📊 共配置 ${hostnameCount} 个 hostname 映射, ${portCount} 个端口绑定`);
    this.logger.info({ msg: `📊 共配置 ${hostnameCount} 个 hostname 映射, ${portCount} 个端口绑定` });
  }

  /**
   * 初始化闲置检查器
   */
  private initIdleChecker(): void {
    this.idleTimer = setInterval(() => {
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
   * 检查单个服务是否闲置（与 Node 版语义一致：keepWarm 用独立短阈值）
   */
  private checkIdleService(service: ServiceConfig, now: number): void {
    if (service.proxyOnly) return;

    const idleThreshold = service.keepWarm
      ? (service.warmIdleTimeout ?? GatewayConstants.WARM_IDLE_TIMEOUT_DEFAULT)
      : service.idleTimeout;

    if (
      service._state!.status === 'online' &&
      service._state!.activeConnections === 0 &&
      now - service._state!.lastAccessTime > idleThreshold
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
   * 从 Request 构建代理 fetch 的 headers
   * 剥离逐跳头，host 重写为目标 host
   */
  private buildProxyHeaders(req: Request, targetUrl: URL, hasBody: boolean, bodyLength: number): Headers {
    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (GatewayConstants.SKIP_REQUEST_HEADERS.has(key)) return;
      /** 快速路径安全：剥离头值中的 CRLF（防注入，与 Node 版 CRLF 清理语义对齐） */
      const safe = (value.includes('\r') || value.includes('\n')) ? value.replace(/[\r\n]/g, '') : value;
      headers.set(key, safe);
    });
    headers.set('host', targetUrl.host);
    if (hasBody && bodyLength >= 0) {
      headers.set('content-length', String(bodyLength));
    }
    return headers;
  }

  /**
   * 代理转发核心：fetch 到后端并把响应流式回给客户端
   * @returns Response（可直接被 Bun.serve fetch 返回）
   */
  private async proxyRequest(req: Request, mapping: RouteMapping, startTime: number): Promise<Response> {
    const service = mapping.service;
    const targetUrl = mapping.targetUrl;
    const entry = this.getAgentEntry(service.name, service);

    service._state!.lastAccessTime = startTime;
    service._state!.activeConnections++;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      service._state!.activeConnections--;
      entry.inFlight--;
    };

    entry.inFlight++;

    /**
     * 客户端断开感知：Bun.serve 的 req.signal 在客户端断开时 abort
     */
    const abortController = new AbortController();
    req.signal.addEventListener('abort', () => abortController.abort());

    /** 413 预检：content-length 声明超限直接拒绝（不转发） */
    const declared = parseInt(req.headers.get('content-length') ?? '0');
    if (declared > GatewayConstants.MAX_REQUEST_BODY_SIZE) {
      this.logger.warn({ msg: `⚠️ [${service.name}] 请求体超过 ${GatewayConstants.MAX_REQUEST_BODY_SIZE} 字节，返回 413` });
      return new Response('Payload Too Large', { status: 413 });
    }

    /**
     * 请求体流式透传 + 实际字节数计数：无 content-length（chunked）时
     * 超限即截断并切换为 413 响应（与 Node 版 collectRequestBody 语义对齐）
     */
    let requestBody: ReadableStream<Uint8Array> | null = req.body;
    let bodyOverflow = false;
    /**
     * 是否对流做计数包装。包装后转发必须走 chunked（不带 content-length）：
     * Bun fetch 在「流被提前截断 + 声明超长 content-length」时会等待剩余字节直到
     * 超时（后端表现为读错误），因此超限场景无法靠事后分支救回。改用 chunked
     * 后 fetch 正常完成，bodyOverflow 分支可立即返回 413。
     * 与 Node 版语义近似：Node 版 collectRequestBody 先缓冲后转发，字节根本
     * 不会到后端；Bun 流式方案中前缀字节会到达后端，但客户端响应面一致。
     */
    let wrapsCounter = false;
    if (requestBody && declared <= GatewayConstants.MAX_REQUEST_BODY_SIZE) {
      wrapsCounter = true;
      const source = requestBody;
      let totalSize = 0;
      requestBody = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = source.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              totalSize += value.byteLength;
              if (totalSize > GatewayConstants.MAX_REQUEST_BODY_SIZE) {
                bodyOverflow = true;
                try { controller.close(); } catch { /* 已关闭 */ }
                return;
              }
              controller.enqueue(value);
            }
            controller.close();
          } catch {
            try { controller.close(); } catch { /* 已关闭 */ }
          }
        },
      });
    }

    /** 代理请求超时：后端超时未响应 → 504 */
    const timeoutSignal = AbortSignal.timeout(this.proxyTimeoutMs);
    const combined = AbortSignal.any([abortController.signal, timeoutSignal]);

    const headers = this.buildProxyHeaders(req, targetUrl, !!requestBody, wrapsCounter ? -1 : declared);

    try {
      const upstream = await fetch(targetUrl.origin + new URL(req.url).pathname + new URL(req.url).search, {
        method: req.method,
        headers,
        body: requestBody,
        signal: combined,
        /** Bun 特有：禁用自动重定向，网关应原样转发 3xx */
        redirect: 'manual',
      });

      /** 请求体流式计数发现超限：不信任上游响应，返回 413（与 Node 版「不转发到后端」语义近似：
       *  流式模式下前缀字节已可能到达后端，但响应面行为一致——客户端拿到 413） */
      if (bodyOverflow) {
        cleanup();
        void upstream.body?.cancel();
        return new Response('Payload Too Large', { status: 413 });
      }

      /** 客户端已在等待期间断开 */
      if (abortController.signal.aborted) {
        cleanup();
        return new Response(null, { status: 502 });
      }

      const responseHeaders = new Headers();
      upstream.headers.forEach((value, key) => {
        if (GatewayConstants.SKIP_RESPONSE_HEADERS.has(key)) return;
        responseHeaders.set(key, value);
      });

      const statusCode = upstream.status;
      /** 101 特判：Bun.serve 无法在 HTTP fetch 路径回 101（升级走独立通道），返回空体 200 兜底。
       *  实际 WS 升级流量走 upgrade 处理器，不会落到这里 */
      if (statusCode === 101) {
        cleanup();
        return new Response(null, { status: 200 });
      }

      if (this.logging.enableRequestLog) {
        this.logger.info({
          msg: `📤 [${service.name}] ${req.method} ${new URL(req.url).pathname} - ${statusCode}`,
          service: service.name,
        });
      }

      /** 响应体流式透传：客户端断开时取消上游（自动背压由 Bun 流机制承担）。
       *  慢客户端停滞超时：与 Node 版对齐——enqueue 后下游长时间不拉取（背压）
       *  超过 proxyTimeoutMs 时，取消上游并关闭流（断开客户端连接）。
       *  实现：desiredSize <= 0 表示下游背压，启动停滞计时；拉取恢复即清除 */
      let body: ReadableStream<Uint8Array> | null = null;
      if (upstream.body) {
        const upstreamBody = upstream.body;
        /** 箭头函数外捕获 this（stream 回调里 this 不指向网关实例） */
        const self = this;
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const reader = upstreamBody.getReader();
            const clearStall = () => {
              if (stallTimer) { clearTimeout(stallTimer); stallTimer = undefined; }
            };
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
                /** 背压检测：desiredSize <= 0 表示下游暂停消费，启动停滞计时（探针） */
                if (controller.desiredSize !== null && controller.desiredSize <= 0 && !stallTimer) {
                  stallTimer = setTimeout(() => {
                    if (self.logging.enableRequestLog) {
                      self.logger.warn({ msg: `⏱️ [${service.name}] 慢客户端停滞超时（>${self.proxyTimeoutMs}ms 未消费响应），断开连接` });
                    }
                    /**
                     * 【Bun 平台语义差异】Node 版此处会 res.close() 主动断开客户端
                     * socket。Bun 1.4.serve 无 per-request socket 断开 API
                     * （server.timeout(req,0)、closeIdleConnections、controller.error
                     * 经实测均不能断开有 write 积压的客户端连接——uWS 发送缓冲非空时
                     * idle 计时不工作），因此只能做后端侧止损：abort 上游 fetch，
                     * 释放后端连接，保证服务可闲置回收。客户端 socket 留待
                     * Bun.serve 的 idleTimeout 兜底或客户端主动断开。 */
                    void reader.cancel();
                    try { controller.error(new Error('stall timeout')); } catch { /* 已出错 */ }
                  }, self.proxyTimeoutMs);
                } else if (controller.desiredSize !== null && controller.desiredSize > 0) {
                  clearStall();
                }
              }
              clearStall();
              controller.close();
            } catch {
              clearStall();
              try { controller.close(); } catch { /* 已关闭 */ }
            } finally {
              cleanup();
              reader.releaseLock();
            }
          },
          cancel() {
            void upstreamBody.cancel();
            cleanup();
          },
        });
      } else {
        cleanup();
      }

      return new Response(body, { status: statusCode, headers: responseHeaders });
    } catch (error: unknown) {
      cleanup();
      /** 请求体流式计数发现超限（fetch 中途主动 abort 到达此处）：返回 413。
       *  必须在客户端断开判断之前：超限 abort 是网关主动行为，客户端仍在线。
       *  与 Node 版「不转发到后端」语义近似：流式模式下前缀字节已可能到达后端，
       *  但响应面行为一致——客户端拿到 413 */
      if (bodyOverflow) {
        return new Response('Payload Too Large', { status: 413 });
      }
      if (abortController.signal.aborted) {
        /** 客户端断开：无法再回响应，抛出让 Bun 关闭连接 */
        throw error;
      }

      const timedOut = timeoutSignal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ msg: `❌ [${service.name}] 代理请求错误`, error: message });

      /** 后端不可达时将非 proxyOnly 服务状态重置为 offline（与 Node 版一致） */
      if (!service.proxyOnly && service._state!.status === 'online') {
        this.logger.info({ msg: `🔄 [${service.name}] 后端不可达，重置状态为 offline` });
        service._state!.status = 'offline';
      }

      return timedOut
        ? new Response('Gateway Timeout', { status: 504 })
        : new Response('Bad Gateway', { status: 502 });
    }
  }

  /**
   * 确保服务在线（供启动/等待路径共用）
   * @throws 启动失败或超时时抛出错误
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
        mapping.targetUrl.hostname,
        mapping.targetPort,
        0,
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
   * hostname 路由的 HTTP 处理入口（含按需启动状态机）
   */
  private async handleRequest(req: Request, hostname: string): Promise<Response> {
    const startTime = Date.now();
    const mapping = this.hostnameRoutes.get(hostname);

    if (!mapping) {
      this.logger.info({ msg: `❌ [${hostname}] ${req.method} - 404` });
      return new Response(`Service not found: ${hostname}`, { status: 404 });
    }

    const service = mapping.service;
    service._state!.lastAccessTime = startTime;
    const status = service._state!.status;

    /** 413：content-length 声明超限直接拒绝（流式计数超限在 proxyRequest 内拦截） */
    const declared = parseInt(req.headers.get('content-length') ?? '0');
    if (declared > GatewayConstants.MAX_REQUEST_BODY_SIZE) {
      this.logger.warn({ msg: `⚠️ [${service.name}] 请求体超过 ${GatewayConstants.MAX_REQUEST_BODY_SIZE} 字节，返回 413` });
      return new Response('Payload Too Large', { status: 413 });
    }

    const service_ = mapping;
    try {
      if (status === 'starting') {
        const startPromise = this.startingPromises.get(service.name);
        if (startPromise) {
          await startPromise;
        }
      } else if (status === 'stopping') {
        /** 等待服务停止完成（与 Node 版 handleServiceWithWait 语义一致） */
        this.logger.info({ msg: `⏳ [${service.name}] ${req.method} - 等待服务停止完成...` });
        const maxWaitTime = this.stopWaitMs;
        const waitStartTime = Date.now();
        while (service._state!.status === 'stopping') {
          if (Date.now() - waitStartTime > maxWaitTime) {
            this.logger.error({ msg: `❌ [${service.name}] 等待服务停止超时` });
            return new Response('Service stopping timeout', { status: 503 });
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      if (service._state!.status === 'offline') {
        this.logger.info({ msg: `🚀 [${service.name}] ${req.method} - 启动服务...` });
        await this.ensureServiceOnline(service, service_);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ msg: `❌ [${service.name}] 启动失败`, error: message });
      return new Response('Service Unavailable', { status: 503 });
    }

    return this.proxyRequest(req, mapping, startTime);
  }

  /**
   * 端口路由的 HTTP 处理入口
   */
  private async handlePortRequest(req: Request, mapping: RouteMapping): Promise<Response> {
    const startTime = Date.now();
    const service = mapping.service;
    service._state!.lastAccessTime = startTime;
    const status = service._state!.status;

    const declared = parseInt(req.headers.get('content-length') ?? '0');
    if (declared > GatewayConstants.MAX_REQUEST_BODY_SIZE) {
      return new Response('Payload Too Large', { status: 413 });
    }

    try {
      if (status === 'starting') {
        const startPromise = this.startingPromises.get(service.name);
        if (startPromise) {
          await startPromise;
        }
      } else if (status === 'stopping') {
        const waitStartTime = Date.now();
        while (service._state!.status === 'stopping') {
          if (Date.now() - waitStartTime > this.stopWaitMs) {
            return new Response('Service stopping timeout', { status: 503 });
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      if (service._state!.status === 'offline') {
        await this.ensureServiceOnline(service, mapping);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ msg: `❌ [${service.name}] 启动失败`, error: message });
      return new Response('Service Unavailable', { status: 503 });
    }

    return this.proxyRequest(req, mapping, startTime);
  }

  /**
   * 启动网关
   */
  async start(): Promise<void> {
    const host = this.config.host || '127.0.0.1';
    const port = this.config.port || 3000;

    /** 主监听：hostname 路由 + WS 代理 */
    const mainServer = Bun.serve({
      hostname: host,
      port,
      /** 连接空闲兜底（秒）：Bun 无 per-request 断开 API，慢客户端靠此最终回收 */
      idleTimeout: 10,
      /**
       * HTTP 入口：hostname 路由分发
       */
      fetch: (req, server) => {
        const hostHeader = req.headers.get('host') ?? '';
        const hostname = hostHeader.split(':')[0];

        /** WS 升级嗅探：Upgrade 头存在时解析路由并完成升级 */
        if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
          const prepared = prepareWsUpgrade(req, (r) => {
            const hn = (r.headers.get('host') ?? '').split(':')[0];
            const m = this.hostnameRoutes.get(hn);
            return m ? { service: m.service, target: m.target } : null;
          });
          if (!prepared) {
            return new Response(`Service not found: ${hostname}`, { status: 404 });
          }
          server.upgrade(req, {
            data: prepared as unknown as WsUserData,
          });
          return undefined;
        }

        return this.handleRequest(req, hostname);
      },
      websocket: this.createWsHandlers({
        /**
         * upgrade 时按 Host 头解析路由目标
         */
        resolveTarget: (req) => {
          const hostHeader = req.headers.get('host') ?? '';
          const hostname = hostHeader.split(':')[0];
          const mapping = this.hostnameRoutes.get(hostname);
          if (!mapping) return null;
          return { service: mapping.service, target: mapping.target };
        },
      }),
    });
    this.servers.push(mainServer);
    this.logger.info({ msg: `DynaPM-Bun 网关已启动: http://${host}:${port}` });

    for (const [portNum, mapping] of this.portRoutes) {
      if (mapping.service.passthrough) {
        this.createPassthroughPortListener(host, portNum, mapping);
      } else {
        this.createPortBindingListener(host, portNum, mapping);
      }
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
    const server = Bun.serve({
      hostname: host,
      port,
      /** 连接空闲兜底（秒），与主监听器一致 */
      idleTimeout: 10,
      fetch: (req, srv) => this.adminApi.handleAdminApi(req, srv.requestIP(req)),
    });
    this.servers.push(server);
    this.logger.info({ msg: `🔌 管理 API 已启动: http://${host}:${port}` });
  }

  /**
   * 为非 passthrough 端口路由创建监听器（HTTP 代理 + WS 代理）
   */
  private createPortBindingListener(host: string, portNum: number, mapping: RouteMapping): void {
    const server = Bun.serve({
      hostname: host,
      port: portNum,
      /** 连接空闲兜底（秒），与主监听器一致 */
      idleTimeout: 10,
      fetch: (req, srv) => {
        if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
          const prepared = prepareWsUpgrade(req, () => ({ service: mapping.service, target: mapping.target }));
          if (!prepared) {
            return new Response('Not Found', { status: 404 });
          }
          srv.upgrade(req, { data: prepared as unknown as WsUserData });
          return undefined;
        }
        return this.handlePortRequest(req, mapping);
      },
      websocket: this.createWsHandlers({
        resolveTarget: () => ({ service: mapping.service, target: mapping.target }),
      }),
    });
    this.servers.push(server);
    this.logger.info({ msg: `🔌 端口绑定已启动: http://${host}:${portNum} -> ${mapping.service.name}` });
  }

  /**
   * 为 passthrough 服务创建端口监听器（Bun.listen 纯 TCP 层）
   * 架构与 Node 版一致：
   *  - 外层 Bun.listen 监听配置端口，嗅探每个连接的首个 HTTP 请求头
   *  - WS upgrade 连接：按需启动服务、等就绪后整条连接 TCP 直通
   *  - 非 upgrade 的普通 HTTP 连接：pipe 到内部 Bun.serve（动态 loopback 端口）
   */
  private createPassthroughPortListener(host: string, portNum: number, mapping: RouteMapping): void {
    const { service, target } = mapping;
    const targetUrl = new URL(target);
    const targetHost = targetUrl.hostname;
    const targetPort = mapping.targetPort;

    /** 内部 HTTP app：承接普通 HTTP 连接（passthrough 下 WS upgrade 全部走直通，不会到这） */
    const internalServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      /** 连接空闲兜底（秒），仅承接 loopback 内部流量 */
      idleTimeout: 10,
      fetch: (req) => this.handlePortRequest(req, mapping),
    });
    this.servers.push(internalServer);
    const internalPort = internalServer.port;

    /**
     * Bun Socket.write 是「部分写」语义：单次写入超过发送缓冲（约 110KB）时
     * 只写入返回值指示的字节数，剩余数据被静默丢弃。因此直通路径的所有写入
     * 必须经此泵：按返回值切分剩余部分，1ms 间隔重试直至队列排空。
     */
    /** 泵内部运行态（挂在 socket.data 上的扩展字段） */
    type PumpState = { writeQueue?: Uint8Array[]; pumping?: boolean };
    const pumpWrite = (socket: Bun.Socket<unknown>, data: Uint8Array): void => {
      /** Bun Socket.data 实际可写但类型标 undefined，这里做安全扩展 */
      const state = (socket.data ??= {} as unknown) as PtSocketState & PumpState;
      const queue: Uint8Array[] = (state.writeQueue ??= []);
      queue.push(data);
      if (state.pumping) return;
      state.pumping = true;
      void (async () => {
        while (queue.length > 0) {
          const chunk = queue[0];
          const written = socket.write(chunk);
          if (written === chunk.length) {
            queue.shift();
            continue;
          }
          if (written > 0) queue[0] = chunk.subarray(written);
          await Bun.sleep(1);
        }
        state.pumping = false;
      })();
    };

    const listener = Bun.listen<PtSocketState>({
      hostname: host,
      port: portNum,
      socket: {
        open: (socket) => {
          /** 连接级嗅探状态（Bun socket 对象可直接挂 data） */
          socket.data = {
            sniffer: new HttpUpgradeSniffer(),
            buffered: [] as Buffer[],
            routed: false,
            piped: false,
            peer: undefined,
          };
        },
        data: (socket, data) => {
          const state = socket.data;
          if (!state) return;
          const chunk = Buffer.from(data);

          if (state.routed) {
            /** 已建立管道：客户端→后端方向直接转发 */
            if (state.piped) state.forward?.(chunk);
            /** 已分流但管道尚未建立（启动/连接进行中）：继续缓冲，flushAndPipe 时统一写出 */
            else state.buffered.push(chunk);
            return;
          }

          const rest = state.sniffer.feed(chunk);
          if (!state.sniffer.parsed) {
            /** 头未完整：先缓冲已读字节，等分片补齐 */
            state.buffered.push(chunk);
            return;
          }
          const headEnd = chunk.length - rest.length;
          const headBytes = Buffer.concat([...state.buffered, chunk.subarray(0, headEnd)]);
          state.buffered = rest.length > 0 ? [Buffer.from(rest)] : [];
          state.routed = true;

          const isUpgrade = state.sniffer.result!.isUpgrade;
          service._state!.lastAccessTime = Date.now();

          void (async () => {
            try {
              let peer: Bun.Socket;
              if (!isUpgrade) {
                /** 普通 HTTP：连同头字节一起交给内部 Bun.serve（字节流不丢不重） */
                peer = await Bun.connect({
                  hostname: '127.0.0.1',
                  port: internalPort as number,
                  socket: {
                    data(_s, d) { pumpWrite(socket, d); },
                    close() { socket.end(); },
                    error() { socket.end(); },
                  },
                });
              } else {
                /** WS upgrade：按需启动 + 就绪等待 + TCP 直通 */
                if (service._state!.status === 'offline' || service._state!.status === 'stopping') {
                  await this.ensureServiceOnline(service, mapping);
                }
                peer = await Bun.connect({
                  hostname: targetHost,
                  port: targetPort,
                  socket: {
                    data(_s, d) { pumpWrite(socket, d); },
                    close() {
                      service._state!.activeConnections--;
                      socket.end();
                    },
                    error() { socket.end(); },
                  },
                });
                service._state!.activeConnections++;
                if (this.logging.enableWebSocketLog) {
                  this.logger.info({ msg: `⚡ [${service.name}] passthrough WS 直通已建立 -> ${targetHost}:${targetPort}` });
                }
              }
              state.peer = peer;
              state.piped = true;
              if (headBytes.length > 0) pumpWrite(peer, headBytes);
              for (const b of state.buffered) pumpWrite(peer, b);
              state.buffered = [];
              /** 客户端→后端方向转发：piped 后续到达的客户端数据经背压泵写给 peer
               *  （后端→客户端方向由 Bun.connect 的 socket.data 回调承担） */
              socket.data!.forward = (chunk: Uint8Array) => { pumpWrite(peer, chunk); };
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              this.logger.error({ msg: `❌ [${service.name}] passthrough 连接失败`, error: message });
              socket.end();
            }
          })();
        },
        close: (socket) => {
          socket.data?.peer?.end();
        },
        error: (socket) => {
          socket.data?.peer?.end();
        },
      },
    });
    this.tcpListeners.push(listener);
    this.logger.info({ msg: `⚡ passthrough 端口绑定已启动: ${host}:${portNum} -> ${service.name} (WS 直通 / HTTP 经内部网关)` });
  }


  /**
   * 创建 WS 代理 handlers（Bun 原生 WebSocket）
   * 客户端->后端方向带消息队列；后端->客户端方向透传（背压由 Bun 内部缓冲承担，语义近似）
   */
  private createWsHandlers(options: {
    /**
     * upgrade 阶段解析路由目标
     * @returns null 表示路由未命中（拒绝升级）
     */
    resolveTarget: (req: Request) => { service: ServiceConfig; target: string } | null;
  }): {
    open: (ws: Bun.ServerWebSocket<WsUserData>) => void;
    message: (ws: Bun.ServerWebSocket<WsUserData>, message: string | Buffer<ArrayBuffer>) => void;
    close: (ws: Bun.ServerWebSocket<WsUserData>) => void;
  } {
    return {
      open: (ws) => {
        const userData = ws.data;
        const service = userData.service;
        service._state!.activeConnections++;

        if (this.logging.enableWebSocketLog) {
          this.logger.info({ msg: `🔌 [${service.name}] WebSocket 连接已建立` });
        }

        const wsState = {
          backendReady: false,
          messageQueue: [] as { data: Uint8Array; isBinary: boolean }[],
          backendWs: undefined as WebSocket | undefined,
          closing: false,
        };
        userData.wsState = wsState;

        void (async () => {
          try {
            const target = userData.target;
            const targetUrl = new URL(target);
            const targetPort = parseInt(targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80'));

            const needsStart = service._state!.status === 'offline';
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

            const wsUrl = `${targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${targetUrl.host}${userData.clientPath}`;

            /** 透传鉴权等自定义头（Bun 客户端 WS 支持 headers 选项，升级阶段抓取的原始头已存 userData） */
            const backendHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(userData.clientHeaders)) {
              if (!GatewayConstants.WS_SKIP_HEADERS.has(key)) {
                backendHeaders[key] = value;
              }
            }
            backendHeaders['Host'] = targetUrl.host;

            const clientProtocols = userData.clientProtocols;
            /** Bun 客户端 WebSocket 支持非标 headers 选项（运行时可用，类型上需扩展） */
            const backendWs = new WebSocket(wsUrl, {
              protocols: clientProtocols && clientProtocols.length > 0 ? clientProtocols : undefined,
              headers: backendHeaders,
            } as unknown as string[]);
            wsState.backendWs = backendWs;
            backendWs.binaryType = 'arraybuffer';

            backendWs.onopen = () => {
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `✅ [${service.name}] 后端 WebSocket 连接已建立` });
              }
              wsState.backendReady = true;
              while (wsState.messageQueue.length > 0 && backendWs.readyState === WebSocket.OPEN) {
                const queued = wsState.messageQueue.shift();
                if (queued) {
                  backendWs.send(queued.isBinary ? queued.data : new TextDecoder().decode(queued.data));
                }
              }
            };

            backendWs.onmessage = (event) => {
              const data = event.data;
              if (typeof data === 'string') {
                ws.send(data);
              } else {
                ws.send(new Uint8Array(data as ArrayBuffer), true);
              }
              service._state!.lastAccessTime = Date.now();
            };

            backendWs.onclose = (event) => {
              const code = event.code;
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `🔌 [${service.name}] 后端 WebSocket 连接关闭 code=${code}` });
              }
              if (!wsState.closing) {
                wsState.closing = true;
                if (code && code !== 1000 && code !== 1005) {
                  ws.close(code, (event.reason || '').slice(0, 123));
                } else {
                  ws.close();
                }
              }
            };

            /** 后端协议层 ping 转发为客户端侧 ping。
             *  Bun 客户端 WebSocket 的 ping 感知走 addEventListener('ping')
             *  （onping 属性在 Bun 1.4 客户端不触发） */
            (backendWs as unknown as { addEventListener: (ev: string, cb: (e: unknown) => void) => void }).addEventListener('ping', (event: unknown) => {
              try {
                const data = (event as { data?: unknown }).data;
                if (data instanceof ArrayBuffer) {
                  ws.ping(new Uint8Array(data));
                } else if (Buffer.isBuffer(data)) {
                  ws.ping(new Uint8Array(data));
                } else {
                  ws.ping();
                }
              } catch {
                // ping 参数受限，忽略
              }
            });

            backendWs.onerror = () => {
              this.logger.error({ msg: `❌ [${service.name}] 后端 WebSocket 错误` });
              wsState.closing = true;
              ws.close();
            };
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error({ msg: `❌ [${service.name}] WebSocket 连接失败`, error: message });
            ws.close();
          }
        })();
      },

      message: (ws, message) => {
        const userData = ws.data;
        const service = userData.service;
        const wsState = userData.wsState!;
        /** 文本消息 Buffer 类型为 string；二进制为 Buffer（默认 binaryType: nodebuffer） */
        const isBinary = typeof message !== 'string';

        /** Bun 的 message ArrayBuffer 同样是复用缓冲，必须拷贝 */
        const msgBytes = typeof message === 'string'
          ? new TextEncoder().encode(message)
          : new Uint8Array(message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer);
        service._state!.lastAccessTime = Date.now();

        if (wsState.backendReady && wsState.backendWs && wsState.backendWs.readyState === WebSocket.OPEN) {
          if (this.logging.enableWebSocketLog) {
            this.logger.info({ msg: `📨 [${service.name}] 转发消息到后端: ${msgBytes.length} 字节 binary=${isBinary}` });
          }
          wsState.backendWs.send(isBinary ? msgBytes : new TextDecoder().decode(msgBytes));
        } else {
          if (this.logging.enableWebSocketLog) {
            this.logger.info({ msg: `📦 [${service.name}] 消息加入队列` });
          }
          if (wsState.messageQueue.length < GatewayConstants.MAX_WS_MESSAGE_QUEUE_SIZE) {
            wsState.messageQueue.push({ data: msgBytes, isBinary });
          } else {
            this.logger.warn({
              msg: `⚠️ [${service.name}] WebSocket 消息队列超过 ${GatewayConstants.MAX_WS_MESSAGE_QUEUE_SIZE} 条，主动关闭连接`,
              service: service.name,
            });
            wsState.closing = true;
            ws.close();
          }
        }
      },

      close: (ws) => {
        const userData = ws.data;
        const service = userData.service;
        service._state!.activeConnections--;

        if (this.logging.enableWebSocketLog) {
          this.logger.info({ msg: `🔌 [${service.name}] 客户端 WebSocket 连接关闭` });
        }

        const wsState = userData.wsState;
        if (wsState?.backendWs && wsState.backendWs.readyState === WebSocket.OPEN) {
          wsState.closing = true;
          wsState.backendWs.close();
        }
      },
    };
  }

  /**
   * 清理所有正在运行的服务
   */
  async cleanup(): Promise<void> {
    this.logger.info({ msg: '🧹 正在清理所有服务...' });

    if (this.idleTimer) clearInterval(this.idleTimer);

    const cleanedServices = new Set<ServiceConfig>();
    for (const mapping of this.hostnameRoutes.values()) {
      cleanedServices.add(mapping.service);
    }
    for (const mapping of this.portRoutes.values()) {
      cleanedServices.add(mapping.service);
    }

    const stopPromises: Promise<void>[] = [];
    for (const service of cleanedServices) {
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

    for (const server of this.servers) {
      try { server.stop(false); } catch { /* 已停止 */ }
    }
    for (const listener of this.tcpListeners) {
      try { listener.stop(true); } catch { /* 已停止 */ }
    }
    this.servers = [];
    this.tcpListeners = [];

    this.logger.info({ msg: `✅ 已清理 ${cleanedServices.size} 个服务` });
  }
}

/**
 * passthrough 连接级状态（挂在 Bun Socket.data 上）
 */
interface PtSocketState {
  /** 首个 HTTP 请求头嗅探器 */
  sniffer: HttpUpgradeSniffer;
  /** 分流前缓冲的字节（头未完整/管道未建立期间到达） */
  buffered: Buffer[];
  /** 是否已完成分流决策 */
  routed: boolean;
  /** 是否已建立双向管道（写出缓冲字节） */
  piped: boolean;
  /** 对端（后端/内部网关）连接 */
  peer?: { write: (data: Uint8Array | string) => number | undefined; end: () => void };
  /** 客户端→后端方向转发函数（piped 后由 socket.data 回调调用） */
  forward?: (chunk: Uint8Array) => void;
}

/**
 * WS 升级上下文数据（挂在 ServerWebSocket.data 上）
 */
interface WsUserData {
  /** 服务配置 */
  service: ServiceConfig;
  /** 目标后端地址 */
  target: string;
  /** 客户端原始请求路径（含查询串） */
  clientPath: string;
  /** 客户端升级请求头（原样保留供透传） */
  clientHeaders: Record<string, string>;
  /** 客户端请求的子协议列表 */
  clientProtocols: string[] | undefined;
  /** 运行时状态 */
  wsState?: {
    backendReady: boolean;
    messageQueue: { data: Uint8Array; isBinary: boolean }[];
    backendWs?: WebSocket;
    closing: boolean;
  };
}

/** 供主监听器 fetch 完成升级嗅探的辅助：把升级请求头转存（在 fetch 内调用） */
export function prepareWsUpgrade(
  req: Request,
  resolveTarget: (req: Request) => { service: ServiceConfig; target: string } | null,
): { service: ServiceConfig; target: string; clientPath: string; clientHeaders: Record<string, string>; clientProtocols: string[] | undefined } | null {
  const resolved = resolveTarget(req);
  if (!resolved) return null;

  const url = new URL(req.url);
  const clientHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    clientHeaders[key] = (value.includes('\r') || value.includes('\n')) ? value.replace(/[\r\n]/g, '') : value;
  });
  const protocolsHeader = req.headers.get('sec-websocket-protocol');
  const clientProtocols = protocolsHeader
    ? protocolsHeader.split(',').map((p) => p.trim()).filter(Boolean)
    : undefined;

  return {
    ...resolved,
    clientPath: url.pathname + url.search,
    clientHeaders,
    clientProtocols,
  };
}
