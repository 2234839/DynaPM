/**
 * 远程 DynaPM 面板接入：面板注册表（localStorage 持久化）+ 按面板独立的 API 客户端。
 * 每个远程面板一个 baseUrl + token，token 与本地面板令牌完全隔离存放
 */
import { createClient, type AdminClient } from './client';

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

/** 远程面板 API 客户端：端点实现统一来自 client.ts 工厂（与本地面板同构），此处只做面板令牌绑定 */
export class PanelClient implements AdminClient {
  /** 所属面板元信息 */
  panel: RemotePanel;

  /** 工厂创建的底层客户端（baseUrl/令牌取自面板条目） */
  private c: AdminClient;

  constructor(panel: RemotePanel) {
    this.panel = panel;
    this.c = createClient(panel.baseUrl, () => panel.token);
  }

  /** 服务列表 */
  fetchServices(epoch?: number): Promise<{ epoch?: number; services: import('./api').ServiceListItem[] }> {
    return this.c.fetchServices(epoch);
  }

  /** 各服务历史统计（分页拉取在工厂内统一实现） */
  fetchStats(fromMin?: number, toMin?: number, step?: number): Promise<{ services: import('./api').ServiceStats[] }> {
    return this.c.fetchStats(fromMin, toMin, step);
  }

  /** 服务详情 */
  fetchServiceDetail(name: string): Promise<import('./api').ServiceDetail> {
    return this.c.fetchServiceDetail(name);
  }

  /** 启动服务 */
  startService(name: string): Promise<unknown> {
    return this.c.startService(name);
  }

  /** 停止服务 */
  stopService(name: string): Promise<unknown> {
    return this.c.stopService(name);
  }

  /** 彻底关停 */
  disableService(name: string): Promise<unknown> {
    return this.c.disableService(name);
  }

  /** 解除彻底关停 */
  enableService(name: string): Promise<unknown> {
    return this.c.enableService(name);
  }

  /** 获取配置文件（authToken 已脱敏） */
  fetchConfig(): Promise<Record<string, any>> {
    return this.c.fetchConfig();
  }

  /** 保存配置（热更或自重启；_mtime 冲突检测，冲突时后端返回 409） */
  saveConfig(cfg: Record<string, any>): Promise<{ ok: boolean; reloaded?: boolean; restarting?: boolean }> {
    return this.c.saveConfig(cfg);
  }

  /** 网关实例信息 */
  info(): Promise<Record<string, unknown>> {
    return this.c.info();
  }

  /** 连通性测试：拉网关信息验证地址与令牌 */
  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const info = await this.info();
      return { ok: true, message: `连接成功：${JSON.stringify(info).slice(0, 120)}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: msg === 'UNAUTHORIZED' ? '令牌无效（401）' : `连接失败：${msg}` };
    }
  }
}
