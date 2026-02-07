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
  /** 运行时状态（内部使用） */
  _state?: ServiceState;
}

/** 服务运行状态 */
export interface ServiceState {
  status: 'offline' | 'starting' | 'online';
  lastAccessTime: number;
  pid?: number;
}

/** DynaPM全局配置 */
export interface DynaPMConfig {
  /** 监听端口 */
  port?: number;
  /** 监听主机 */
  host?: string;
  /** 服务映射：hostname -> 服务配置 */
  services: Record<string, ServiceConfig>;
}
