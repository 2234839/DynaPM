import { ServiceManager } from './service-manager.js';
import type { ServiceConfig, DynaPMConfig } from '../config/types.js';
import type { HttpResponse, HttpRequest, WebSocket } from 'uWebSockets.js';
import type { Logger } from 'pino';
import uWS from 'uWebSockets.js';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import WS from 'ws';
import { AdminApiHandler } from './admin-api.js';
import { formatTime } from '../utils/format.js';

/** 网关常量 */
const GatewayConstants = {
  /** 闲置检查间隔（毫秒） */
  IDLE_CHECK_INTERVAL: 3000,
  /** TCP 端口检查超时（毫秒） */
  TCP_CHECK_TIMEOUT: 100,
  /** 后端就绪检查延迟（毫秒） */
  BACKEND_READY_CHECK_DELAY: 50,
} as const;

/**
 * HTTP Agent 连接池（复用连接，提升性能）
 */
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 256,
  maxFreeSockets: 256,
  timeout: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 256,
  maxFreeSockets: 256,
  timeout: 30000,
  rejectUnauthorized: false,
});

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
  /** 上游请求对象 */
  proxyReq?: http.ClientRequest;
  /** 上游响应对象 */
  proxyRes?: http.IncomingMessage;
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
  /** 是否为 HTTPS */
  isHttps?: boolean;
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
  };
  /** 管理 API 处理器 */
  private adminApi: AdminApiHandler;

  constructor(private config: DynaPMConfig, logger: Logger) {
    this.logger = logger;
    this.logging = {
      enableRequestLog: config.logging?.enableRequestLog ?? false,
      enableWebSocketLog: config.logging?.enableWebSocketLog ?? false,
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
        activeConnections: 0, // 初始化活动连接数为 0
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
        // 缓存 URL 解析结果，避免每次请求都创建新对象
        const targetUrl = new URL(route.target);
        const mapping: RouteMapping = {
          service,
          target: route.target,
          targetUrl,
          isHttps: targetUrl.protocol === 'https:',
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
   * 定期检查并停止闲置的服务
   *
   * 注意：
   * - 纯代理模式（proxyOnly）不会被停止
   * - 只有当服务没有活动连接且超过闲置时间时才会停止
   * - 这样可以避免 SSE/WebSocket 长连接被意外断开
   */
  private initIdleChecker(): void {
    setInterval(() => {
      const now = Date.now();

      // 使用 Set 避免重复检查同一个服务（因为一个服务可能有多个路由）
      const checkedServices = new Set<ServiceConfig>();

      // 检查 hostname 映射的服务
      for (const mapping of this.hostnameRoutes.values()) {
        if (!checkedServices.has(mapping.service)) {
          checkedServices.add(mapping.service);
          this.checkIdleService(mapping.service, now);
        }
      }

      // 检查端口绑定的服务
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
    // 跳过纯代理模式
    if (service.proxyOnly) {
      return;
    }

    // 检查条件：服务在线 + 没有活动连接 + 超过闲置时间
    if (
      service._state!.status === 'online' &&
      service._state!.activeConnections === 0 &&
      now - service._state!.lastAccessTime > service.idleTimeout
    ) {
      this.logger.info({ msg: `🛌 [${service.name}] 闲置超时，正在停止...` });
      // 设置为 stopping 状态
      service._state!.status = 'stopping';
      // 更新累计运行时长
      if (service._state!.startTime) {
        service._state!.totalUptime += now - service._state!.startTime;
        service._state!.startTime = undefined;
      }
      this.serviceManager.stop(service).catch((err: Error) => {
        this.logger.error({ msg: `❌ [${service.name}] 停止失败`, error: err.message });
      }).finally(() => {
        // 停止完成后设置为 offline
        service._state!.status = 'offline';
      });
    }
  }

  /**
   * 处理端口绑定请求（直接路由，无需 Host 头）
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

    // 完整 URL
    const fullUrl = queryString ? `${url}?${queryString}` : url;

    // 提前提取所有请求头（req 对象在 await 后会失效）
    const headers: Record<string, string> = {};
    req.forEach((key: string, value: string) => {
      // 清理 CRLF 注入，防止 HTTP 响应分割攻击
      const safeValue = value.replace(/[\r\n]/g, '');
      headers[key] = safeValue;
    });

    // 更新访问时间（所有请求）
    service._state!.lastAccessTime = Date.now();

    const needsStart = service._state!.status === 'offline';

    if (needsStart) {
      this.handleServiceStart(res, mapping, fullUrl, startTime, method, headers);
    } else {
      this.handleDirectProxy(res, mapping, fullUrl, startTime, method, headers);
    }
  }

  /**
   * 处理传入的 HTTP 请求
   */
  private handleRequest(res: HttpResponse, req: HttpRequest): void {
    const startTime = Date.now();
    const hostname = req.getHeader('host')?.split(':')[0] || '';
    const method = req.getMethod();
    const url = req.getUrl();
    const queryString = req.getQuery();

    // 完整 URL
    const fullUrl = queryString ? `${url}?${queryString}` : url;

    // 提前提取所有请求头（req 对象在 await 后会失效）
    const headers: Record<string, string> = {};
    req.forEach((key: string, value: string) => {
      // 清理 CRLF 注入，防止 HTTP 响应分割攻击
      const safeValue = value.replace(/[\r\n]/g, '');
      headers[key] = safeValue;
    });

    // 记录请求信息
    const mapping = this.hostnameRoutes.get(hostname);

    if (!mapping) {
      // 404 错误总是记录
      this.logger.info({ msg: `❌ [${hostname}] ${method} ${fullUrl} - 404` });
      res.cork(() => {
        res.writeStatus('404 Not Found');
        res.end(`Service not found: ${hostname}`);
      });
      return;
    }

    const service = mapping.service;

    // 更新访问时间（所有请求）
    service._state!.lastAccessTime = Date.now();

    const status = service._state!.status;
    const needsStart = status === 'offline' || status === 'stopping';

    if (needsStart) {
      // 如果服务正在停止，需要等待停止完成
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
    body: Buffer
  ): Promise<void> {
    const service = mapping.service;
    const target = mapping.target;

    this.logger.info({ msg: `🚀 [${service.name}] ${method} ${fullUrl} - 启动服务...` });
    service._state!.status = 'starting';

    try {
      await this.serviceManager.start(service);

      // 快速等待端口可用
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

      // 发起代理请求
      await this.forwardProxyRequest(res, mapping, fullUrl, startTime, method, headers, body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      if (message === 'Client aborted') {
        return;
      }

      this.logger.error({ msg: `❌ [${service.name}] 启动失败`, error: message });
      try {
        res.cork(() => {
          res.writeStatus('503 Service Unavailable');
          res.end('Service Unavailable');
        });
      } catch (sendErr: unknown) {
        const sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        this.logger.error({ msg: `❌ [${service.name}] 发送错误响应失败`, error: sendErrMsg });
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

    const chunks: Buffer[] = [];
    let aborted = false;

    res.onAborted(() => {
      aborted = true;
    });

    res.onData((ab: ArrayBuffer, isLast: boolean) => {
      if (aborted) return;

      const chunk = Buffer.from(ab);
      chunks.push(chunk);

      if (isLast) {
        const fullBody = Buffer.concat(chunks);

        if (aborted) return;

        // 等待服务变为 offline 状态
        (async () => {
          const maxWaitTime = 30000;
          const checkInterval = 100;
          const waitStartTime = Date.now();

          while (service._state!.status === 'stopping') {
            if (Date.now() - waitStartTime > maxWaitTime) {
              // 超时
              this.logger.error({ msg: `❌ [${service.name}] 等待服务停止超时` });
              res.cork(() => {
                res.writeStatus('503 Service Unavailable');
                res.end('Service stopping timeout');
              });
              return;
            }
            await new Promise(resolve => setTimeout(resolve, checkInterval));
          }

          if (aborted) return;

          // 服务已停止，现在启动它
          this.logger.info({ msg: `✅ [${service.name}] 服务已停止，开始启动...` });
          await this.startServiceAndProxy(res, mapping, fullUrl, startTime, method, headers, fullBody);
        })();
      }
    });
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
    const service = mapping.service;
    // 收集请求体
    const chunks: Buffer[] = [];
    let aborted = false;

    res.onAborted(() => {
      aborted = true;
    });

    res.onData((ab: ArrayBuffer, isLast: boolean) => {
      if (aborted) return;

      const chunk = Buffer.from(ab);
      chunks.push(chunk);

      if (isLast) {
        const fullBody = Buffer.concat(chunks);

        if (aborted) return;

        // 调用启动方法
        this.startServiceAndProxy(res, mapping, fullUrl, startTime, method, headers, fullBody);
      }
    });
  }

  /**
   * 处理直接代理场景（服务已在线）
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
    // 关键：必须在同步阶段调用 onData
    const chunks: Buffer[] = [];
    let aborted = false;

    res.onAborted(() => {
      aborted = true;
    });

    res.onData((ab: ArrayBuffer, isLast: boolean) => {
      if (aborted) return;

      const chunk = Buffer.from(ab);
      chunks.push(chunk);

      if (isLast) {
        const fullBody = Buffer.concat(chunks);

        if (aborted) return;

        // 发起代理请求
        this.forwardProxyRequest(res, mapping, fullUrl, startTime, method, headers, fullBody).catch((err: Error) => {
          // 区分客户端主动断开和真正的错误
          if (err.message === 'Client aborted') {
            // 客户端主动断开是正常行为，特别是对于 SSE 和 WebSocket
            // 不记录为错误
            return;
          }

          // 其他错误才记录为错误
          this.logger.error({ msg: `❌ [${service.name}] 代理失败`, error: err.message });
          if (!aborted) {
            try {
              res.cork(() => {
                res.writeStatus('500 Internal Server Error');
                res.end('Proxy Error');
              });
            } catch (sendErr: unknown) {
              // 响应已失效，记录错误
              const sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
              this.logger.error({ msg: `❌ [${service.name}] 发送错误响应失败`, error: sendErrMsg });
            }
          }
        });
      }
    });
  }

  /**
   * 发起代理请求并流式转发响应
   *
   * @param res - uWS HttpResponse 对象
   * @param mapping - 路由映射信息（包含缓存的目标 URL）
   * @param path - 请求路径（包含查询字符串）
   * @param startTime - 请求开始时间（用于日志）
   * @param method - HTTP 方法
   * @param headers - 请求头
   * @param body - 请求体
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
    // 使用缓存的 URL 对象，只需更新路径部分
    const targetUrl = mapping.targetUrl!;
    // 构建完整的请求 URL
    const requestUrl = new URL(path, targetUrl);
    const isHttps = mapping.isHttps!;
    const httpModule = isHttps ? https : http;

    // 过滤并准备转发的请求头
    const proxyHeaders: Record<string, string> = { ...headers };
    delete proxyHeaders['connection'];
    delete proxyHeaders['keep-alive'];

    // 设置正确的 Host 头
    proxyHeaders['host'] = targetUrl.host;

    // 创建代理状态
    const state: ProxyState = { aborted: false, responded: false };

    // 增加活动连接计数（用于防止长连接被闲置检测误杀）
    service._state!.activeConnections++;

    return new Promise((resolve, reject) => {
      // 创建清理函数：减少活动连接计数（防止重复调用）
      let cleaned = false;
      const cleanup = () => {
        if (!cleaned) {
          cleaned = true;
          service._state!.activeConnections--;
        }
      };

      // 设置 abort 处理
      res.onAborted(() => {
        state.aborted = true;
        if (state.proxyReq && !state.proxyReq.destroyed) {
          state.proxyReq.destroy();
        }
        if (state.proxyRes && !state.proxyRes.destroyed) {
          state.proxyRes.destroy();
        }
        // 客户端断开是正常行为（特别是 SSE 和 WebSocket），使用 resolve 而不是 reject
        // 这样可以避免 "未处理的 Promise rejection" 错误
        cleanup();
        resolve();
      });

      state.proxyReq = httpModule.request(requestUrl, {
        method,
        headers: proxyHeaders,
        // 使用连接池 agent 复用连接
        agent: isHttps ? httpsAgent : httpAgent,
        rejectUnauthorized: false,
      }, (proxyRes: http.IncomingMessage) => {
        state.proxyRes = proxyRes;

        const statusCode = proxyRes.statusCode || 200;
        const statusMessage = proxyRes.statusMessage || 'OK';

        // 检查连接是否仍然有效
        if (state.aborted) {
          proxyRes.destroy();
          cleanup();
          resolve();
          return;
        }

        // 特殊处理：101 Switching Protocols (WebSocket 升级)
        if (statusCode === 101) {
//           this.logger.info({ msg: `✅ [${service.name}] WebSocket 升级成功` });

          res.cork(() => {
            if (state.aborted) return;

            res.writeStatus(`${statusCode} ${statusMessage}`);

            // 转发响应头
            const responseHeaders = proxyRes.headers;
            for (const [key, value] of Object.entries(responseHeaders)) {
              const keyLower = key.toLowerCase();

              if (keyLower === 'connection' || keyLower === 'transfer-encoding' || keyLower === 'keep-alive') {
                continue;
              }

              if (Array.isArray(value)) {
                for (const v of value) {
                  res.writeHeader(key, v);
                }
              } else if (value !== undefined) {
                res.writeHeader(key, value);
              }
            }

            // 立即结束响应（WebSocket 升级没有 body）
            res.end();
            state.responded = true;
          });

          cleanup();
          resolve();
          return;
        }

        // 立即设置响应头（在同步阶段）
        res.cork(() => {
          if (state.aborted) return;

          res.writeStatus(`${statusCode} ${statusMessage}`);

          // 转发响应头
          const responseHeaders = proxyRes.headers;
          for (const [key, value] of Object.entries(responseHeaders)) {
            const keyLower = key.toLowerCase();

            // 跳过不应转发的头
            if (keyLower === 'connection' || keyLower === 'transfer-encoding' || keyLower === 'keep-alive') {
              continue;
            }

            // 处理多值头（如 Set-Cookie）
            if (Array.isArray(value)) {
              for (const v of value) {
                res.writeHeader(key, v);
              }
            } else if (value !== undefined) {
              res.writeHeader(key, value);
            }
          }
        });

        // 流式转发响应体（关键修复：处理 backpressure）
        proxyRes.on('data', (chunk: Buffer) => {
          if (state.aborted) {
            proxyRes.destroy();
            return;
          }

          // 尝试写入数据并检查 backpressure
          let writeSuccess = false;
          res.cork(() => {
            if (state.aborted) return;
            writeSuccess = res.write(chunk);
          });

          // 处理 backpressure（关键修复）
          if (!writeSuccess) {
            // 暂停上游流
            proxyRes.pause();

            // 注册可写回调
            res.onWritable(() => {
              if (state.aborted) {
                proxyRes.destroy();
                return false;
              }

              // 恢复上游流
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

          // 结束响应
          res.cork(() => {
            if (state.aborted) return;

            res.end();
            state.responded = true;

            // 记录请求日志（根据配置决定是否启用）
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
          // 只有在没有发送过响应且连接未断开时才发送错误响应
          if (!state.responded && !state.aborted) {
            state.responded = true;
            try {
              res.cork(() => {
                if (!state.aborted) {
                  res.writeStatus('502 Bad Gateway');
                  res.end('Bad Gateway');
                }
              });
            } catch (sendErr: unknown) {
              // 响应已失效，记录错误
              const sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
              this.logger.error({ msg: `❌ [${service.name}] 发送错误响应失败`, error: sendErrMsg });
            }
          }
          cleanup();
          reject(err);
        });
      });

      state.proxyReq.on('error', (err: Error) => {
        if (state.aborted) {
          cleanup();
          resolve();
          return;
        }

        this.logger.error({ msg: `❌ [${service.name}] 代理请求错误`, error: err.message });
        // 只有在没有发送过响应且连接未断开时才发送错误响应
        if (!state.responded && !state.aborted) {
          state.responded = true;
          try {
            res.cork(() => {
              if (!state.aborted) {
                res.writeStatus('502 Bad Gateway');
                res.end('Bad Gateway');
              }
            });
          } catch (sendErr: unknown) {
            // 响应已失效，记录错误
            const sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
            this.logger.error({ msg: `❌ [${service.name}] 发送错误响应失败`, error: sendErrMsg });
          }
        }
        cleanup();
        reject(err);
      });

      // 发送请求体
      state.proxyReq.write(body);
      state.proxyReq.end();
    });
  }

  /**
   * 启动网关
   */
  async start(): Promise<void> {
    const uWS = await import('uWebSockets.js');

    const host = this.config.host || '127.0.0.1';
    const port = this.config.port || 3000;

    const app = uWS.App();

    // WebSocket 处理器
    app.ws('/*', {
      /**
       * WebSocket 升级处理
       * 在这里完成客户端握手，并准备连接后端
       */
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

        // 更新访问时间
        service._state!.lastAccessTime = Date.now();

        /** 提取并保存客户端的请求头（用于转发到后端 WebSocket） */
        const clientHeaders: Record<string, string> = {};
        req.forEach((key: string, value: string) => {
          // 清理 CRLF 注入
          const safeValue = value.replace(/[\r\n]/g, '');
          clientHeaders[key] = safeValue;
        });

        /** 保存客户端请求的路径（用于连接后端时使用） */
        const clientPath = req.getUrl() + (req.getQuery() ? `?${req.getQuery()}` : '');

        // 完成客户端 WebSocket 握手
        res.upgrade(
          {
            hostname,
            service,
            target,
            clientHeaders,
            clientPath,
            // 这些数据会在 open/message/close 事件中通过 ws.getUserData() 访问
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

      /**
       * WebSocket 连接已建立
       * 在这里连接后端 WebSocket，并启动双向转发
       */
      open: (ws: WebSocket<Record<string, unknown>>) => {
        const userData = ws.getUserData();
        const service = userData.service as ServiceConfig;
        const target = userData.target as string;

        // 增加活动连接计数（用于防止长连接被闲置检测误杀）
        service._state!.activeConnections++;

        if (this.logging.enableWebSocketLog) {
          this.logger.info({ msg: `🔌 [${service.name}] WebSocket 连接已建立` });
        }

        // 初始化状态
        const wsState = {
          backendReady: false,
          messageQueue: [] as Buffer[],
          backendWs: undefined as WS | undefined,
          closing: false, // 防止重复关闭
        };
        (ws as unknown as Record<string, unknown>).wsState = wsState;

        // 异步启动后端服务（如果需要）并连接
        (async () => {
          try {
            const needsStart = service._state!.status === 'offline';

            if (needsStart) {
              this.logger.info({ msg: `🚀 [${service.name}] WebSocket - 启动服务...` });
              service._state!.status = 'starting';

              await this.serviceManager.start(service);

              // 等待端口可用
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

              // 检查端口是否就绪
              if (!isReady) {
                service._state!.status = 'offline';
                this.logger.error({ msg: `❌ [${service.name}] WebSocket 服务启动超时` });
                ws.close();
                return;
              }

              service._state!.status = 'online';
              // 记录启动时间和启动次数
              service._state!.startTime = Date.now();
              service._state!.startCount++;
            }

            // 构建后端 WebSocket URL
            const targetUrl = new URL(target);

            // 获取客户端的原始请求数据（从 upgrade 阶段保存的数据）
            const userData = ws.getUserData();
            const clientPath = userData.clientPath as string;
            const clientHeaders = userData.clientHeaders as Record<string, string>;

            // 使用客户端请求的实际路径，而不是默认的 /
            const wsUrl = `${targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${targetUrl.host}${clientPath}`;

            if (this.logging.enableWebSocketLog) {
              this.logger.info({ msg: `🔌 [${service.name}] 连接后端 WebSocket: ${wsUrl}` });
            }

            // 准备转发的请求头（转发所有客户端头，除了连接相关的头）
            const backendHeaders: Record<string, string> = {};
            const skipHeaders = new Set(['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version']);

            for (const [key, value] of Object.entries(clientHeaders)) {
              if (!skipHeaders.has(key.toLowerCase())) {
                backendHeaders[key] = value;
              }
            }

            // 设置正确的 Host 头（指向后端服务器）
            backendHeaders['Host'] = targetUrl.host;

            // 记录转发的请求头（用于调试）
            this.logger.info({
              msg: `🔌 [${service.name}] 转发 WebSocket 请求头`,
              headers: JSON.stringify(backendHeaders, null, 2)
            });

            // 连接后端 WebSocket
            const backendWs = new WS(wsUrl, {
              headers: backendHeaders,
            });

            wsState.backendWs = backendWs;

            // 后端 WebSocket 打开
            backendWs.on('open', () => {
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `✅ [${service.name}] 后端 WebSocket 连接已建立` });
              }
              wsState.backendReady = true;

              // 发送队列中的消息
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

            // 后端 WebSocket 收到消息，转发给客户端
            backendWs.on('message', (data: Buffer, isBinary: boolean) => {
              if (ws !== null) {
                const success = ws.send(data, isBinary, false);
                if (!success) {
                  // 背压处理：暂停后端流
                  backendWs.pause();

                  // 注册可写回调恢复流
                  const drainHandler = () => {
                    if (backendWs.readyState === WS.OPEN) {
                      // 重试发送
                      const retrySuccess = ws.send(data, isBinary, false);
                      if (retrySuccess) {
                        backendWs.resume();
                      } else {
                        // 仍然背压，继续等待
                        return true; // 继续监听
                      }
                    }
                    return false; // 停止监听
                  };

                  // 使用 cork 确保同步调用
                  ws.cork(drainHandler);
                }
              }
            });

            // 后端 WebSocket 关闭
            backendWs.on('close', () => {
              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `🔌 [${service.name}] 后端 WebSocket 连接关闭` });
              }
              // 检查是否已经在关闭过程中，避免重复关闭
              if (ws !== null && !wsState.closing) {
                wsState.closing = true;
                ws.close();
              }
            });

            // 后端 WebSocket 错误
            backendWs.on('error', (err: Error) => {
              this.logger.error({ msg: `❌ [${service.name}] 后端 WebSocket 错误`, error: err.message });
              // 标记为正在关闭，防止重复操作
              wsState.closing = true;

              if (ws !== null) {
                ws.close();
              }
            });

            // 后端 WebSocket 恢复（用于背压处理）
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

      /**
       * 收到客户端 WebSocket 消息
       * 转发给后端 WebSocket
       */
      message: (ws: WebSocket<Record<string, unknown>>, message: ArrayBuffer, _isBinary: boolean) => {
        const userData = ws.getUserData();
        const service = userData.service as ServiceConfig;
        const wsState = (ws as unknown as Record<string, unknown>).wsState as {
          backendReady: boolean;
          messageQueue: Buffer[];
          backendWs?: WS;
        };

        if (wsState.backendReady && wsState.backendWs && wsState.backendWs.readyState === WS.OPEN) {
          // 后端已就绪，直接转发消息
          const msgBuffer = Buffer.from(message);
          if (this.logging.enableWebSocketLog) {
            this.logger.info({ msg: `📨 [${service.name}] 转发消息到后端: ${msgBuffer.length} 字节` });
          }
          wsState.backendWs.send(msgBuffer);
          service._state!.lastAccessTime = Date.now();
        } else {
          // 后端正在连接或未初始化，加入队列
          // 注意：即使 backendWs 未初始化，open 中的异步代码也会稍后初始化它
          if (this.logging.enableWebSocketLog) {
            this.logger.info({ msg: `📦 [${service.name}] 消息加入队列` });
          }
          wsState.messageQueue.push(Buffer.from(message));
        }
      },

      /**
       * 客户端 WebSocket 连接关闭
       * 同时关闭后端 WebSocket 连接
       */
      close: (ws: WebSocket<Record<string, unknown>>) => {
        const userData = ws.getUserData();
        const service = userData.service as ServiceConfig;

        // 减少活动连接计数（连接关闭时）
        service._state!.activeConnections--;

        if (this.logging.enableWebSocketLog) {
          this.logger.info({ msg: `🔌 [${service.name}] 客户端 WebSocket 连接关闭` });
        }

        const wsState = (ws as unknown as Record<string, unknown>).wsState as {
          backendWs?: WS;
          closing?: boolean;
        } | undefined;

        if (wsState?.backendWs && wsState.backendWs.readyState === WS.OPEN) {
          // 设置关闭标志，防止后端关闭事件再次触发客户端关闭
          wsState.closing = true;
          wsState.backendWs.close();
        }
      },
    });

    // HTTP 请求处理（管理 API 检查在 handleRequest 方法中进行）
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

    // 为配置了专属端口的服务创建独立监听器
    for (const [portNum, mapping] of this.portRoutes) {
      this.createPortBindingListener(host, portNum, mapping);
    }

    // 为管理 API 创建独立监听器
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

    // 处理所有 HTTP 请求
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

      // WebSocket 处理器（端口绑定）
      app.ws('/*', {
        upgrade: (res: HttpResponse, req: HttpRequest, context) => {
          // 更新访问时间
          service._state!.lastAccessTime = Date.now();

          /** 提取并保存客户端的请求头 */
          const clientHeaders: Record<string, string> = {};
          req.forEach((key: string, value: string) => {
            const safeValue = value.replace(/[\r\n]/g, '');
            clientHeaders[key] = safeValue;
          });

          /** 保存客户端请求的路径 */
          const clientPath = req.getUrl() + (req.getQuery() ? `?${req.getQuery()}` : '');

          // 完成客户端 WebSocket 握手
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
          // WebSocket 连接处理逻辑（与主端口相同）
          const userData = ws.getUserData();
          const svc = userData.service as ServiceConfig;
          const backendTarget = userData.target as string;

          svc._state!.activeConnections++;
          if (this.logging.enableWebSocketLog) {
            this.logger.info({ msg: `🔌 [${svc.name}] 端口${portNum} WebSocket 连接已建立` });
          }

          // 初始化状态
          const wsState = {
            backendReady: false,
            messageQueue: [] as Buffer[],
            backendWs: undefined as WS | undefined,
            closing: false,
          };
          (ws as unknown as Record<string, unknown>).wsState = wsState;

          // 异步启动后端服务（如果需要）并连接
          (async () => {
            try {
              const needsStart = svc._state!.status === 'offline';

              if (needsStart) {
                this.logger.info({ msg: `🚀 [${svc.name}] 端口${portNum} WebSocket - 启动服务...` });
                svc._state!.status = 'starting';

                await this.serviceManager.start(svc);

                // 等待端口可用
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

              // 构建后端 WebSocket URL 并连接
              const targetUrl = new URL(backendTarget);
              const userData = ws.getUserData();
              const clientPath = userData.clientPath as string;
              const clientHeaders = userData.clientHeaders as Record<string, string>;
              const wsUrl = `${targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${targetUrl.host}${clientPath}`;

              if (this.logging.enableWebSocketLog) {
                this.logger.info({ msg: `🔌 [${svc.name}] 端口${portNum} 连接后端 WebSocket: ${wsUrl}` });
              }

              const backendHeaders: Record<string, string> = {};
              const skipHeaders = new Set(['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version']);

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
            wsState.messageQueue.push(Buffer.from(message));
          }
        },

        close: (ws: WebSocket<Record<string, unknown>>) => {
          const userData = ws.getUserData();
          const svc = userData.service as ServiceConfig;
          svc._state!.activeConnections--;
        },
      });

      // HTTP 请求处理（端口绑定）
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
   * 在网关退出时调用
   */
  async cleanup(): Promise<void> {
    this.logger.info({ msg: '🧹 正在清理所有服务...' });

    // 使用 Set 避免重复处理同一个服务
    const cleanedServices = new Set<ServiceConfig>();

    // 收集所有需要清理的服务
    for (const mapping of this.hostnameRoutes.values()) {
      cleanedServices.add(mapping.service);
    }
    for (const mapping of this.portRoutes.values()) {
      cleanedServices.add(mapping.service);
    }

    // 停止所有在线的服务
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

    // 等待所有服务停止
    await Promise.all(stopPromises);

    this.logger.info({ msg: `✅ 已清理 ${cleanedServices.size} 个服务` });
  }
}
