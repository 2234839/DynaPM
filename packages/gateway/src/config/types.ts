/** 健康检查配置 */
export interface HealthCheckConfig {
  /** 健康检查类型 */
  type: 'tcp' | 'http' | 'command' | 'none';
  /** TCP检查：端口号（默认从base URL提取） */
  port?: number;
  /** HTTP检查：URL（默认使用服务base地址） */
  url?: string;
  /** HTTP检查：期望状态码 */
  expectedStatus?: number;
  /** 命令检查：自定义bash命令（退出码0表示健康） */
  command?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/** 内部健康检查配置（确保类型安全） */
export interface HealthCheckConfigInternal extends HealthCheckConfig {
  type: 'tcp' | 'http' | 'command' | 'none';
}

/** 服务命令配置 */
export interface ServiceCommands {
  /** 启动命令 */
  start: string;
  /** 停止命令 */
  stop: string;
  /** 检查运行状态命令（退出码0=运行中） */
  check: string;
  /** 工作目录（可选） */
  cwd?: string;
  /** 环境变量（可选） */
  env?: Record<string, string>;
}

/** 路由配置 */
export interface RouteConfig {
  /** 路由类型 */
  type: 'host' | 'port';
  /** 路由值：网关端的 hostname 或端口号 */
  value: string | number;
  /** 目标后端地址：转发到的实际服务地址 */
  target: string;
}

/** 服务 HTTP keep-alive Agent 池参数（未配置时使用内置默认值） */
export interface AgentPoolConfig {
  /** 每服务最大并发 socket 数（默认 256） */
  maxSockets?: number;
  /** 最大空闲 keep-alive socket 数（默认 32） */
  maxFreeSockets?: number;
  /** 空闲 socket keep-alive 探活间隔（毫秒，默认 30000） */
  keepAliveMsecs?: number;
}

/** 服务配置 */
export interface ServiceConfig {
  /** 服务标识 */
  name: string;
  /** 服务地址 */
  base: string;
  /** 闲置超时（毫秒） */
  idleTimeout: number;
  /** 启动超时（毫秒） */
  startTimeout: number;
  /** 服务命令 */
  commands: ServiceCommands;
  /** 健康检查配置 */
  healthCheck?: HealthCheckConfig;
  /** 纯代理模式：只做反向代理，不启动/停止服务 */
  proxyOnly?: boolean;
  /** TCP 直通模式：端口路由整条连接纯 TCP 直通；hostname 路由下 WS upgrade 走直通（普通 HTTP 仍走流式代理） */
  passthrough?: boolean;
  /** 常驻软预热：闲置回收时使用独立的 warmIdleTimeout 判定（更短），实现“常驻但快速回收” */
  keepWarm?: boolean;
  /** keepWarm 服务的闲置回收阈值（毫秒，默认 30000）：仅 keepWarm: true 时生效 */
  warmIdleTimeout?: number;
  /** HTTP keep-alive Agent 池参数（可选，未配置使用默认值） */
  agent?: AgentPoolConfig;

  // === 简化配置（向后兼容） ===
  /** Hostname 映射（可选）：配置后可通过此 hostname 访问 */
  host?: string;
  /** 专属端口（可选）：配置后网关会监听此端口 */
  port?: number;

  // === 复杂配置（多个访问地址） ===
  /** 路由配置（可选）：配置多个访问地址 */
  routes?: RouteConfig[];

  /** 运行时状态（内部使用） */
  _state?: ServiceState;
  /** 全局超时配置（内部使用，loader 填充） */
  _timeouts?: TimeoutsConfig;
}

/** 服务运行状态 */
export interface ServiceState {
  status: 'offline' | 'starting' | 'online' | 'stopping';
  lastAccessTime: number;
  /** 当前活动连接数（HTTP/SSE/WebSocket） */
  activeConnections: number;
  pid?: number;
  /** 服务启动时间戳 */
  startTime?: number;
  /** 累计启动次数 */
  startCount: number;
  /** 累计运行时长（毫秒） */
  totalUptime: number;
}

/** 管理 API 配置 */
export interface AdminApiConfig {
  /** 是否启用管理 API */
  enabled?: boolean;
  /** 管理 API 端口（独立监听） */
  port?: number;
  /** 管理 API hostname（可选，使用主端口时需配置） */
  host?: string;
  /** API 认证令牌（可选） */
  authToken?: string;
  /** 允许访问的 IP 白名单 */
  allowedIps?: string[];
}

/** 超时配置（可注入，未配置时使用默认值） */
export interface TimeoutsConfig {
  /** 等待服务停止完成的超时上限（毫秒，默认 30000） */
  stopWaitMs?: number;
  /** 停止命令执行超时（毫秒，默认 30000）；防止 stop 命令挂起导致服务永远卡在 stopping */
  stopTimeoutMs?: number;
  /** 代理请求超时（毫秒，后端无响应即 504，默认 30000） */
  proxyTimeoutMs?: number;
}

/** 日志配置 */
export interface LoggingConfig {
  /** 是否启用请求日志（每个请求响应记录） */
  enableRequestLog?: boolean;
  /** 是否启用 WebSocket 生命周期日志 */
  enableWebSocketLog?: boolean;
  /** 是否启用错误日志（始终启用，不受此开关控制） */
  enableErrorLog?: boolean;
  /** 是否启用性能分析日志（用于性能优化调试） */
  enablePerformanceLog?: boolean;
}

/** ModelRep（原 DynaPM）全局配置 */
export interface DynaPMConfig {
  /** 监听端口 */
  port?: number;
  /** 监听主机 */
  host?: string;
  /** 服务映射：hostname -> 服务配置 */
  services: Record<string, ServiceConfig>;
  /** 管理 API 配置 */
  adminApi?: AdminApiConfig;
  /** 超时配置 */
  timeouts?: TimeoutsConfig;
  /** 日志配置 */
  logging?: LoggingConfig;
}
