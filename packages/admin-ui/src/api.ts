/** admin API baseURL，可配置：通过环境变量 VITE_ADMIN_API_BASE 覆盖，默认同源（dev 走 vite 代理） */
export const ADMIN_API_BASE: string = import.meta.env.VITE_ADMIN_API_BASE ?? '';

/** 管理令牌存放 key（localStorage） */
const TOKEN_KEY = 'dynapm-admin-token';

/**
 * 从 URL hash（#token=xxx）读取令牌并持久化到 localStorage，然后清除 hash
 * hash 方式令牌不会进入服务器访问日志，也便于直接分享带令牌的完整地址
 */
export function captureTokenFromHash(): void {
  const m = /(?:^|[#&])token=([^&]+)/.exec(location.hash);
  if (m) {
    localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname + location.search);
  }
}

/** 获取已保存的令牌 */
export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

/** 保存令牌 */
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

/** 清除令牌（退出登录） */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 带鉴权头的请求头 */
function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** 服务运行状态（与网关 admin API 输出一致） */
export type ServiceStatus = 'online' | 'offline' | 'starting' | 'stopping';

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
  /** 是否彻底关停（禁止按需拉起） */
  paused?: boolean;
  /** 累计处理请求数 */
  requestCount?: number;
  /** 累计上游响应耗时（毫秒） */
  totalRequestMs?: number;
  /** 累计启动次数 */
  startCount?: number;
  /** 历史累计运行时长（毫秒，含进行中的当前次） */
  totalUptime?: number;
  /** 闲置回收剩余毫秒（online 且无活跃连接时，其余为 null） */
  idleRemainingMs?: number | null;
  /** 最近一次启动耗时（毫秒，starting 开始到 online） */
  lastStartDurationMs?: number;
  /** 域名路由列表（供面板跳转） */
  hosts?: string[];
  /** 专属端口路由列表（端口模式服务） */
  ports?: number[];
  /** SOCKS5 服务模式（ports[0] 为 SOCKS 端口） */
  socks?: boolean;
}

/** 服务详情（列表项字段 + 扩展信息） */
export interface ServiceDetail extends ServiceListItem {
  startCommand?: string;
  stopCommand?: string;
  healthCheck?: Record<string, unknown>;
  netns?: boolean;
  keepWarm?: boolean;
  startTimeout?: number;
  lastStartError?: string | null;
  [key: string]: unknown;
}

/**
 * 封装的 fetch：拼 baseURL、携带 Bearer 令牌、非 2xx 抛错（401 抛特定错误供上层触发重新输入）
 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ADMIN_API_BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string>) },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok) {
    throw new Error(`API ${path} 请求失败: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** 单个服务历史统计（服务端已按窗口裁剪 + step 聚合 + 扁平编码） */
export interface ServiceStats {
  name: string;
  /** 聚合分钟桶扁平数组 [minuteEpoch, count, minuteEpoch, count, …]（分钟已对齐 step） */
  reqBuckets: number[];
  /** 存活区间扁平数组 [startMs, endMs, startMs, endMs, …]，已裁剪到请求窗口 */
  aliveSpans: number[];
}

/** stats 接口分页响应（按服务名排序，offset 游标翻页；旧版后端无这些字段时 services 仍可用） */
export interface StatsPage {
  total?: number;
  hasMore?: boolean;
  nextOffset?: number;
  services: ServiceStats[];
}

/** 获取服务列表（epoch 游标：代数未变时服务列表为空数组，调用方沿用旧数据跳过重渲染） */
export function fetchServices(epoch?: number): Promise<{ epoch?: number; services: ServiceListItem[] }> {
  return api(`/_dynapm/api/services${epoch != null ? `?epoch=${epoch}` : ''}`);
}

/** stats 单页大小：有数据的服务通常远小于服务总数，单页足够；超出时分页拉全 */
const STATS_PAGE_LIMIT = 500;

/** 获取各服务历史统计（自动翻页聚合到完整结果；from/to 分钟 epoch 窗口，step 聚合粒度） */
export async function fetchStats(fromMin?: number, toMin?: number, step = 15): Promise<{ services: ServiceStats[] }> {
  const q = new URLSearchParams();
  if (fromMin != null) q.set('from', String(fromMin));
  if (toMin != null) q.set('to', String(toMin));
  q.set('step', String(step));
  q.set('limit', String(STATS_PAGE_LIMIT));
  const all: ServiceStats[] = [];
  let offset = 0;
  // 有界翻页：防御性上限，避免后端异常时死循环
  for (let guard = 0; guard < 100; guard++) {
    q.set('offset', String(offset));
    const page = await api<StatsPage>(`/_dynapm/api/stats?${q.toString()}`);
    all.push(...(page.services ?? []));
    if (!page.hasMore || !(page.services ?? []).length) break;
    offset = page.nextOffset ?? offset + (page.services ?? []).length;
  }
  return { services: all };
}

/** 获取配置文件（authToken 已脱敏，附带 _mtime 用于外部修改检测） */
export function fetchConfig(): Promise<Record<string, any>> {
  return api('/_dynapm/api/config');
}

/** 保存配置（校验通过后热更或自重启；携带 _mtime 做外部修改冲突检测，冲突时后端返回 409） */
export function saveConfig(cfg: Record<string, any>): Promise<{ ok: boolean; reloaded?: boolean; restarting?: boolean }> {
  return api('/_dynapm/api/config', { method: 'PUT', body: JSON.stringify(cfg, null, 2) });
}

/** 获取服务详情 */
export function fetchServiceDetail(name: string): Promise<ServiceDetail> {
  return api(`/_dynapm/api/services/${encodeURIComponent(name)}`);
}

/** 启动服务 */
export function startService(name: string): Promise<unknown> {
  return api(`/_dynapm/api/services/${encodeURIComponent(name)}/start`, { method: 'POST' });
}

/** 停止服务（下次请求到达会自动按需拉起） */
export function stopService(name: string): Promise<unknown> {
  return api(`/_dynapm/api/services/${encodeURIComponent(name)}/stop`, { method: 'POST' });
}

/** 彻底关停：停止进程并禁止按需/手动拉起 */
export function disableService(name: string): Promise<unknown> {
  return api(`/_dynapm/api/services/${encodeURIComponent(name)}/disable`, { method: 'POST' });
}

/** 解除彻底关停（恢复可按需拉起，不立即启动） */
export function enableService(name: string): Promise<unknown> {
  return api(`/_dynapm/api/services/${encodeURIComponent(name)}/enable`, { method: 'POST' });
}
