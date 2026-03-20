import type { DynaPMConfig } from './src/config/types';

const config: DynaPMConfig = {
  port: 3090,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
    port: 3091,
  },

  logging: {
    enableRequestLog: true,
    enableWebSocketLog: true,
    enablePerformanceLog: false,
  },

  services: {
    /** 思源笔记 - 纯代理模式 */
    'siyuan-note': {
      name: 'siyuan-note',
      port: 3093,
      base: 'https://note.shenzilong.cn',
      proxyOnly: true,
      idleTimeout: 10 * 60 * 1000,
      startTimeout: 5 * 1000,

      commands: {
        start: 'echo "proxy only"',
        stop: 'echo "proxy only"',
        check: 'echo "proxy only"',
      },
    },
  },
};

export default config;
