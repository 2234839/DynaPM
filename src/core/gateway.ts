import { ServiceManager } from './service-manager.js';
import type { ServiceConfig, DynaPMConfig } from '../config/types.js';
import type { HttpResponse, HttpRequest, WebSocket } from 'uWebSockets.js';
import type { Logger } from 'pino';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import WS from 'ws';

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
function checkTcpPort(url: string): Promise<boolean> {
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
 * DynaPM网关
 * 负责请求拦截、服务启动和反向代理
 */
export class Gateway {
  private serviceManager = new ServiceManager();
  /** 服务映射：hostname -> 服务配置 */
  private services: Map<string, ServiceConfig> = new Map();
  /** 日志记录器 */
  private logger: Logger;

  constructor(private config: DynaPMConfig, logger: Logger) {
    this.logger = logger;
    this.initServices();
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
        activeConnections: 0, // 初始化活动连接数为 0
      };
      this.services.set(hostname, service);
    }
  }

  /**
   * 初始化闲置检查器
   * 定期检查并停止闲置的服务
   *
   * 注意：只有当服务没有活动连接且超过闲置时间时才会停止
   * 这样可以避免 SSE/WebSocket 长连接被意外断开
   */
  private initIdleChecker(): void {
    setInterval(() => {
      const now = Date.now();

      for (const service of this.services.values()) {
        // 检查条件：服务在线 + 没有活动连接 + 超过闲置时间
        if (
          service._state!.status === 'online' &&
          service._state!.activeConnections === 0 &&
          now - service._state!.lastAccessTime > service.idleTimeout
        ) {
          this.logger.info({ msg: `🛌 [${service.name}] 闲置超时，正在停止...` });
          this.serviceManager.stop(service).catch((err: Error) => {
            this.logger.error({ msg: `❌ [${service.name}] 停止失败`, error: err.message });
          });
          service._state!.status = 'offline';
        }
      }
    }, 3000);
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
      headers[key] = value;
    });

    // 记录请求信息
    const service = this.services.get(hostname);

    if (!service) {
      // 404 错误总是记录
      this.logger.info({ msg: `❌ [${hostname}] ${method} ${fullUrl} - 404` });
      res.cork(() => {
        res.writeStatus('404 Not Found');
        res.end(`Service not found: ${hostname}`);
      });
      return;
    }

    // 更新访问时间（所有请求）
    service._state!.lastAccessTime = Date.now();

    const needsStart = service._state!.status === 'offline';

    if (needsStart) {
      this.handleServiceStart(res, service, fullUrl, startTime, method, headers);
    } else {
      this.handleDirectProxy(res, service, fullUrl, startTime, method, headers);
    }
  }


  /**
   * 处理需要启动服务的场景
   */
  private handleServiceStart(
    res: HttpResponse,
    service: ServiceConfig,
    fullUrl: string,
    startTime: number,
    method: string,
    headers: Record<string, string>
  ): void {
    const startStartTime = Date.now();
    this.logger.info({ msg: `🚀 [${service.name}] ${method} ${fullUrl} - 启动服务...` });
    service._state!.status = 'starting';

    // 关键：必须在同步阶段调用 onData，不能等待异步操作
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

        // 现在可以进行异步操作了
        (async () => {
          try {
            await this.serviceManager.start(service);

            // 快速等待端口可用
            const waitStartTime = Date.now();
            while (Date.now() - waitStartTime < service.startTimeout) {
              const isReady = await checkTcpPort(service.base);
              if (isReady) {
                const waitDuration = Date.now() - waitStartTime;
                const totalDuration = Date.now() - startStartTime;
                this.logger.info({
                  msg: `✅ [${service.name}] 服务就绪 (启动${formatTime(totalDuration - waitDuration)}, 等待${formatTime(waitDuration)})`,
                });
                break;
              }
            }

            service._state!.status = 'online';

            // 检查是否仍然有效
            if (aborted) return;

            // 发起代理请求
            await this.forwardProxyRequest(res, service, fullUrl, startTime, method, headers, fullBody);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            // 区分客户端主动断开和真正的错误
            if (message === 'Client aborted') {
              // 客户端主动断开是正常行为，不记录为错误
              return;
            }

            // 其他错误才记录为错误
            this.logger.error({ msg: `❌ [${service.name}] 启动失败`, error: message });
            if (!aborted) {
              res.cork(() => {
                res.writeStatus('503 Service Unavailable');
                res.end('Service Unavailable');
              });
            }
          }
        })();
      }
    });
  }

  /**
   * 处理直接代理场景（服务已在线）
   */
  private handleDirectProxy(
    res: HttpResponse,
    service: ServiceConfig,
    fullUrl: string,
    startTime: number,
    method: string,
    headers: Record<string, string>
  ): void {
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
        this.forwardProxyRequest(res, service, fullUrl, startTime, method, headers, fullBody).catch((err: Error) => {
          // 区分客户端主动断开和真正的错误
          if (err.message === 'Client aborted') {
            // 客户端主动断开是正常行为，特别是对于 SSE 和 WebSocket
            // 不记录为错误
            return;
          }

          // 其他错误才记录为错误
          this.logger.error({ msg: `❌ [${service.name}] 代理失败`, error: err.message });
          if (!aborted) {
            res.cork(() => {
              res.writeStatus('500 Internal Server Error');
              res.end('Proxy Error');
            });
          }
        });
      }
    });
  }

  /**
   * 发起代理请求并流式转发响应
   *
   * @param res - uWS HttpResponse 对象
   * @param service - 目标服务配置
   * @param path - 请求路径（包含查询字符串）
   * @param startTime - 请求开始时间（用于日志）
   * @param method - HTTP 方法
   * @param headers - 请求头
   * @param body - 请求体
   */
  private async forwardProxyRequest(
    res: HttpResponse,
    service: ServiceConfig,
    path: string,
    startTime: number,
    method: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<void> {
    const targetUrl = new URL(service.base + path);
    const isHttps = targetUrl.protocol === 'https:';
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
      // 创建清理函数：减少活动连接计数
      const cleanup = () => {
        service._state!.activeConnections--;
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

      state.proxyReq = httpModule.request(targetUrl, {
        method,
        headers: proxyHeaders,
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
          this.logger.info({ msg: `✅ [${service.name}] WebSocket 升级成功` });

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
          const success = res.cork(() => {
            if (state.aborted) return false;
            return res.write(chunk);
          });

          // 处理 backpressure（关键修复）
          if (!success) {
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

            // 记录日志
            const responseTime = Date.now() - startTime;
            this.logger.info({
              msg: `📤 [${service.name}] ${method} ${path} - ${statusCode} - ${formatTime(responseTime)}`,
              service: service.name,
              method,
              path,
              statusCode,
              responseTime,
            });
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
          // 只有在没有发送过响应时才发送错误响应
          if (!state.responded) {
            state.responded = true;
            try {
              res.cork(() => {
                if (!state.aborted) {
                  res.writeStatus('502 Bad Gateway');
                  res.end('Bad Gateway');
                }
              });
            } catch {
              // 响应已失效，忽略错误
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
        // 只有在没有发送过响应时才发送错误响应
        if (!state.responded) {
          state.responded = true;
          try {
            res.cork(() => {
              if (!state.aborted) {
                res.writeStatus('502 Bad Gateway');
                res.end('Bad Gateway');
              }
            });
          } catch {
            // 响应已失效，忽略错误
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
        const service = this.services.get(hostname);

        if (!service) {
          res.cork(() => {
            res.writeStatus('404 Not Found');
            res.end(`Service not found: ${hostname}`);
          });
          return;
        }

        // 更新访问时间
        service._state!.lastAccessTime = Date.now();

        // 完成客户端 WebSocket 握手
        res.upgrade(
          {
            hostname,
            service,
            // 这些数据会在 open/message/close 事件中通过 ws.getUserData() 访问
          },
          req.getHeader('sec-websocket-key'),
          req.getHeader('sec-websocket-protocol'),
          req.getHeader('sec-websocket-extensions'),
          context
        );

        this.logger.info({ msg: `🔌 [${service.name}] WebSocket 升级请求` });
      },

      /**
       * WebSocket 连接已建立
       * 在这里连接后端 WebSocket，并启动双向转发
       */
      open: (ws: WebSocket<Record<string, unknown>>) => {
        const userData = ws.getUserData();
        const service = userData.service as ServiceConfig;

        // 增加活动连接计数（用于防止长连接被闲置检测误杀）
        service._state!.activeConnections++;

        this.logger.info({ msg: `🔌 [${service.name}] WebSocket 连接已建立` });

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
              while (Date.now() - waitStartTime < service.startTimeout) {
                const isReady = await checkTcpPort(service.base);
                if (isReady) {
                  const waitDuration = Date.now() - waitStartTime;
                  this.logger.info({
                    msg: `✅ [${service.name}] WebSocket 服务就绪 (等待${formatTime(waitDuration)})`,
                  });
                  break;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
              }

              service._state!.status = 'online';
            }

            // 构建后端 WebSocket URL
            const targetUrl = new URL(service.base);
            const wsUrl = `${targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${targetUrl.host}/`;

            this.logger.info({ msg: `🔌 [${service.name}] 连接后端 WebSocket: ${wsUrl}` });

            // 连接后端 WebSocket
            const backendWs = new WS(wsUrl, {
              headers: {
                'Host': targetUrl.host,
              },
            });

            wsState.backendWs = backendWs;

            // 后端 WebSocket 打开
            backendWs.on('open', () => {
              this.logger.info({ msg: `✅ [${service.name}] 后端 WebSocket 连接已建立` });
              wsState.backendReady = true;

              // 发送队列中的消息
              this.logger.info({ msg: `📤 [${service.name}] 发送队列中的 ${wsState.messageQueue.length} 条消息` });
              while (wsState.messageQueue.length > 0 && backendWs.readyState === WS.OPEN) {
                const msg = wsState.messageQueue.shift();
                if (msg) {
                  this.logger.info({ msg: `📨 [${service.name}] 发送队列消息: ${msg.length} 字节` });
                  backendWs.send(msg);
                }
              }
            });

            // 后端 WebSocket 收到消息，转发给客户端
            backendWs.on('message', (data: Buffer) => {
              if (ws !== null) {
                const success = ws.send(data, true, false);
                if (!success) {
                  // 背压处理：暂停后端流
                  backendWs.pause();
                }
              }
            });

            // 后端 WebSocket 关闭
            backendWs.on('close', () => {
              this.logger.info({ msg: `🔌 [${service.name}] 后端 WebSocket 连接关闭` });
              // 检查是否已经在关闭过程中，避免重复关闭
              if (ws !== null && !wsState.closing) {
                wsState.closing = true;
                ws.close();
              }
            });

            // 后端 WebSocket 错误
            backendWs.on('error', (err: Error) => {
              this.logger.error({ msg: `❌ [${service.name}] 后端 WebSocket 错误`, error: err.message });
              if (ws !== null) {
                ws.close();
              }
            });

            // 后端 WebSocket 恢复（用于背压处理）
            backendWs.on('pause', () => {
              this.logger.info({ msg: `⏸️ [${service.name}] 后端 WebSocket 暂停（背压）` });
            });

            backendWs.on('resume', () => {
              this.logger.info({ msg: `▶️ [${service.name}] 后端 WebSocket 恢复` });
            });

          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error({ msg: `❌ [${service.name}] WebSocket 连接失败`, error: message });
            ws.close();
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
          this.logger.info({ msg: `📨 [${service.name}] 转发消息到后端: ${msgBuffer.length} 字节` });
          wsState.backendWs.send(msgBuffer);
          service._state!.lastAccessTime = Date.now();
        } else {
          // 后端正在连接或未初始化，加入队列
          // 注意：即使 backendWs 未初始化，open 中的异步代码也会稍后初始化它
          this.logger.info({ msg: `📦 [${service.name}] 消息加入队列` });
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

        this.logger.info({ msg: `🔌 [${service.name}] 客户端 WebSocket 连接关闭` });

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

    // HTTP 请求处理
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
  }
}
