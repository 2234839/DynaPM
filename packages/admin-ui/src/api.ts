/** admin API baseURL，可配置：通过环境变量 VITE_ADMIN_API_BASE 覆盖，默认同源（dev 走 vite 代理） */
export const ADMIN_API_BASE: string = import.meta.env.VITE_ADMIN_API_BASE ?? '';

/** 服务运行状态 */
export type ServiceStatus = 'running' | 'stopped' | 'starting' | 'unknown';

/** 服务列表项（注意：标识字段是 base，不是 hostname） */
export interface ServiceListItem {
  /** 服务唯一标识（base 地址或 hostname） */
  name: string;
  /** 服务 base 地址 */
  base: string;
  status: ServiceStatus;
  /** 运行时长（秒） */
  uptime: number;
  /** 最后访问时间戳 */
  lastAccessTime: number;
  /** 活跃连接数 */
  activeConnections: number;
  /** 闲置回收阈值（毫秒） */
  idleTimeout: number;
  proxyOnly: boolean;
  /** 进程 PID */
  pid: number | null;
}

/** 服务详情（列表项字段 + 扩展信息） */
export interface ServiceDetail extends ServiceListItem {
  startCommand?: string;
  healthCheck?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 封装的 fetch：拼 baseURL、非 2xx 抛错
 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ADMIN_API_BASE}${path}`, init);
  if (!res.ok) {
    throw new Error(`API ${path} 请求失败: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** 获取服务列表 */
export function fetchServices(): Promise<{ services: ServiceListItem[] }> {
  return api('/_dynapm/api/services');
}

/** 获取服务详情 */
export function fetchServiceDetail(name: string): Promise<ServiceDetail> {
  return api(`/_dynapm/api/services/${encodeURIComponent(name)}`);
}

/** 启动服务 */
export function startService(name: string): Promise<unknown> {
  return api(`/_dynapm/api/services/${encodeURIComponent(name)}/start`, { method: 'POST' });
}

/** 停止服务 */
export function stopService(name: string): Promise<unknown> {
  return api(`/_dynapm/api/services/${encodeURIComponent(name)}/stop`, { method: 'POST' });
}
