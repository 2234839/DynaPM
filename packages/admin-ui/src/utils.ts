/**
 * 通用工具函数（跨组件共享，禁止在各组件内联重写）
 */

/** 扁平数对数组 → [a,b] 对列表（后端扁平编码 [a,b,a,b,…] 的统一解码） */
export function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = [];
  /** 奇数位待配对值（for-of 迭代中暂存） */
  let head: number | undefined;
  for (const v of flat) {
    if (head === undefined) {
      head = v;
      continue;
    }
    out.push([head, v]);
    head = undefined;
  }
  return out;
}

/** 毫秒 → 友好时长。style：'uptime'（表格徽标，如 3h25m）、'cfg'（配置编辑，如 1m30s / 2h5m） */
export function formatDuration(ms: number | undefined, style: 'uptime' | 'cfg' = 'uptime'): string {
  if (ms == null || ms <= 0) return style === 'cfg' ? '' : '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (style === 'cfg') {
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  }
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}
