import type { DynaPMConfig } from './src/config/types';

/**
 * passthrough 直通模式测试配置
 * 端口独立（3160/3161/3162），后端为 test-passthrough.ts 内嵌启动的模拟服务
 * proxyOnly + passthrough：WS upgrade 走 TCP 直通，普通 HTTP 走内部 uWS 流式代理
 */
const config: DynaPMConfig = {
  port: 3163,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
    port: 3162,
  },

  logging: {
    enableRequestLog: false,
    enableWebSocketLog: false,
    enablePerformanceLog: false,
  },

  services: {
    'pt-mock': {
      name: 'pt-mock',
      port: 3161,
      base: 'http://127.0.0.1:3160',
      proxyOnly: true,
      passthrough: true,
      idleTimeout: 60 * 1000,
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
