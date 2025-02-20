import type { StartOptions } from 'pm2';

export type DynaPM_Config = pm2Config;
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

type pm2Config = baseConfig & {
  pm2Options: StartOptions;
};
