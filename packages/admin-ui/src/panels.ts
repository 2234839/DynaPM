/**
 * 远程 DynaPM 面板接入：面板注册表（localStorage 持久化）+ 按面板独立的 API 客户端。
 * 每个远程面板一个 baseUrl + token，token 与本地面板令牌完全隔离存放
 */

/** 远程面板条目 */
export interface RemotePanel {
  /** 面板唯一标识（生成后不变，作为服务行/统计的命名空间键） */
  id: string;
  /** 显示名 */
  name: string;
  /** 面板管理 API 根地址（含协议，不带 /_dynapm 后缀） */
  baseUrl: string;
  /** 该面板的管理令牌 */
  token: string;
}

/** localStorage 存储键 */
const PANELS_KEY = 'dynapm-remote-panels';

/** 读取已保存的远程面板列表 */
export function loadPanels(): RemotePanel[] {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as RemotePanel[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 保存远程面板列表 */
export function savePanels(list: RemotePanel[]): void {
  localStorage.setItem(PANELS_KEY, JSON.stringify(list));
}

/** 生成面板 id：随机即可，无需全局有序 */
export function newPanelId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 规范化 baseUrl：去尾部斜杠，校验协议 */
export function normalizeBaseUrl(url: string): string | null {
  const u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(u)) return null;
  return u;
}

/** 远程面板 API 客户端：路径与本地面板 api.ts 完全同构，仅 baseURL/令牌不同 */
export class PanelClient {
  /** 所属面板元信息 */
  panel: RemotePanel;

  constructor(panel: RemotePanel) {
    this.panel = panel;
  }

  /** 带鉴权头的请求封装：非 2xx 抛错，401 抛 UNAUTHORIZED 供上层标记面板离线 */
  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.panel.baseUrl}/_dynapm/api${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.panel.token}`, ...(init?.headers as Record<string, string>) },
    });
    if (res.status === 401) {
      throw new Error('UNAUTHORIZED');
    }
    if (!res.ok) {
      throw new Error(`API ${path} 请求失败: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  /** 服务列表 */
  fetchServices(): Promise<{ services: import('./api').ServiceListItem[] }> {
    return this.api('/services');
  }

  /** 各服务历史统计（与 api.ts 同款分页拉取；远程网关若为旧版无分页字段也能兼容：单页即全量） */
  async fetchStats(fromMin?: number): Promise<{ services: import('./api').ServiceStats[] }> {
    const q = new URLSearchParams();
    if (fromMin != null) q.set('from', String(fromMin));
    q.set('step', '15');
    q.set('limit', '500');
    const all: import('./api').ServiceStats[] = [];
    let offset = 0;
    for (let guard = 0; guard < 100; guard++) {
      q.set('offset', String(offset));
      const page = await this.api<import('./api').StatsPage>(`/stats?${q.toString()}`);
      all.push(...(page.services ?? []));
      if (!page.hasMore || !(page.services ?? []).length) break;
      offset = page.nextOffset ?? offset + (page.services ?? []).length;
    }
    return { services: all };
  }

  /** 服务详情 */
  fetchServiceDetail(name: string): Promise<import('./api').ServiceDetail> {
    return this.api(`/services/${encodeURIComponent(name)}`);
  }

  /** 启动服务 */
  startService(name: string): Promise<unknown> {
    return this.api(`/services/${encodeURIComponent(name)}/start`, { method: 'POST' });
  }

  /** 停止服务 */
  stopService(name: string): Promise<unknown> {
    return this.api(`/services/${encodeURIComponent(name)}/stop`, { method: 'POST' });
  }

  /** 彻底关停 */
  disableService(name: string): Promise<unknown> {
    return this.api(`/services/${encodeURIComponent(name)}/disable`, { method: 'POST' });
  }

  /** 解除彻底关停 */
  enableService(name: string): Promise<unknown> {
    return this.api(`/services/${encodeURIComponent(name)}/enable`, { method: 'POST' });
  }

  /** 获取配置文件（authToken 已脱敏） */
  fetchConfig(): Promise<Record<string, any>> {
    return this.api('/config');
  }

  /** 保存配置（热更或自重启；_mtime 冲突检测，冲突时后端返回 409） */
  saveConfig(cfg: Record<string, any>): Promise<{ ok: boolean; reloaded?: boolean; restarting?: boolean }> {
    return this.api('/config', { method: 'PUT', body: JSON.stringify(cfg, null, 2) });
  }

  /** 连通性测试：拉网关信息验证地址与令牌 */
  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const info = await this.api<Record<string, unknown>>('/info');
      return { ok: true, message: `连接成功：${JSON.stringify(info).slice(0, 120)}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: msg === 'UNAUTHORIZED' ? '令牌无效（401）' : `连接失败：${msg}` };
    }
  }
}
