/**
 * Admin API 客户端工厂：统一 fetch 封装（baseURL + Bearer 令牌 + 401/非 2xx 错误语义）
 * 与全部端点方法。本地面板与远程面板联邦共用同一实现，禁止在组件里复制端点定义。
 */
import type { ServiceDetail, ServiceListItem, ServiceStats, StatsPage } from './api';

/** 面板客户端统一接口（本地与远程面板同构） */
export interface AdminClient {
  /** 服务列表（epoch 游标：代数未变时服务列表为空数组，调用方沿用旧数据） */
  fetchServices(epoch?: number): Promise<{ epoch?: number; services: ServiceListItem[] }>;
  /** 各服务历史统计（自动翻页聚合；from/to 分钟 epoch 窗口，step 聚合粒度） */
  fetchStats(fromMin?: number, toMin?: number, step?: number): Promise<{ services: ServiceStats[] }>;
  /** 服务详情 */
  fetchServiceDetail(name: string): Promise<ServiceDetail>;
  /** 启动服务 */
  startService(name: string): Promise<unknown>;
  /** 停止服务 */
  stopService(name: string): Promise<unknown>;
  /** 彻底关停（禁止按需拉起） */
  disableService(name: string): Promise<unknown>;
  /** 解除彻底关停 */
  enableService(name: string): Promise<unknown>;
  /** 获取配置文件（authToken 已脱敏，附带 _mtime 用于外部修改检测） */
  fetchConfig(): Promise<Record<string, any>>;
  /** 保存配置（校验通过后热更或自重启） */
  saveConfig(cfg: Record<string, any>): Promise<{ ok: boolean; reloaded?: boolean; restarting?: boolean }>;
  /** 网关实例信息（连通性测试用） */
  info(): Promise<Record<string, unknown>>;
}

/** stats 单页大小：有数据的服务通常远小于服务总数，单页足够；超出时分页拉全 */
const STATS_PAGE_LIMIT = 500;

/**
 * 创建客户端实例。
 * @param baseUrl 管理 API 根地址（不带 /_dynapm 后缀，工厂内统一拼接）
 * @param getToken 令牌获取函数（每次请求时读取，保证换令牌立即生效）
 * @param on401 收到 401 时的副作用（本地面板用于清除失效令牌；远程面板不传）
 */
export function createClient(baseUrl: string, getToken: () => string, on401?: () => void): AdminClient {
  /** 带鉴权头的请求封装：非 2xx 抛错，401 抛 UNAUTHORIZED 供上层触发重新输入/标记离线 */
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const token = getToken();
    const res = await fetch(`${baseUrl}/_dynapm/api${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers as Record<string, string>),
      },
    });
    if (res.status === 401) {
      on401?.();
      throw new Error('UNAUTHORIZED');
    }
    if (!res.ok) {
      throw new Error(`API ${path} 请求失败: ${res.status}`);
    }
    return res.json() as Promise<T>;
  };

  return {
    fetchServices: (epoch?: number) =>
      api(`/services${epoch != null ? `?epoch=${epoch}` : ''}`),
    fetchStats: async (fromMin?: number, toMin?: number, step = 15) => {
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
        const page = await api<StatsPage>(`/stats?${q.toString()}`);
        all.push(...(page.services ?? []));
        if (!page.hasMore || !(page.services ?? []).length) break;
        offset = page.nextOffset ?? offset + (page.services ?? []).length;
      }
      return { services: all };
    },
    fetchServiceDetail: (name: string) => api(`/services/${encodeURIComponent(name)}`),
    startService: (name: string) => api(`/services/${encodeURIComponent(name)}/start`, { method: 'POST' }),
    stopService: (name: string) => api(`/services/${encodeURIComponent(name)}/stop`, { method: 'POST' }),
    disableService: (name: string) => api(`/services/${encodeURIComponent(name)}/disable`, { method: 'POST' }),
    enableService: (name: string) => api(`/services/${encodeURIComponent(name)}/enable`, { method: 'POST' }),
    fetchConfig: () => api('/config'),
    saveConfig: (cfg: Record<string, any>) =>
      api('/config', { method: 'PUT', body: JSON.stringify(cfg, null, 2) }),
    info: () => api('/info'),
  };
}
