import type { DynaPMConfigInput } from './src/config/types';

/**
 * 本地思源笔记转发网关配置（验证用）
 * 网关监听 3180，转发到本机思源 6806
 */
const config: DynaPMConfigInput = {
  port: 3180,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
    port: 3181,
  },

  logging: {
    enableRequestLog: true,
    enableWebSocketLog: true,
    enablePerformanceLog: false,
  },

  services: {
    /** 思源笔记本地实例 - 纯代理模式（服务已由用户自行运行） */
    '127.0.0.1': {
      name: 'siyuan-local',
      base: 'http://127.0.0.1:6806',
      proxyOnly: true,
      idleTimeout: 10 * 60 * 1000,
      startTimeout: 5 * 1000,

      commands: {
        start: 'echo "proxy only"',
        stop: 'echo "proxy only"',
        check: 'lsof -ti:6806 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
