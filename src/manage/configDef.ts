import type { StartOptions } from 'pm2';

export type DynaPM_Config = { [host: string]: DynaPM_items };
export type DynaPM_items = pm2ItemConfig;
type baseConfig = {
  // 需要和 ecosystem 中的 那么相同
  base: string;
  latestTime: number;
  stopTime: number;
  maxAwaitLaunchTime: number;
  runCheck: runCheck;
  runStatus: 'launching' | 'running' | 'stop' | 'unknown';
};
export type runCheck = /** 请求 base 路径获得 200 响应码 */ 'getBase200';

export type pm2ItemConfig = baseConfig & {
  pm2Options: StartOptions & { name: string };
};
