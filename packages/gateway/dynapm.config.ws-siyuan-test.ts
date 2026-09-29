import type { DynaPMConfig } from './src/config/types';

/**
 * 模拟思源笔记场景的测试配置
 * 后端为 test-ws-siyuan.ts 内嵌启动的模拟服务（127.0.0.1:3140）
 * proxyOnly 纯代理模式，与用户当年代理思源的方式一致
 */
const config: DynaPMConfig = {
  port: 3150,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
    port: 3152,
  },

  logging: {
    enableRequestLog: false,
    enableWebSocketLog: false,
    enablePerformanceLog: false,
  },

  services: {
    /** 模拟思源 - 纯代理模式（同 dynapm.config.note-test.ts 的方式） */
    'siyuan-mock': {
      name: 'siyuan-mock',
      port: 3151,
      base: 'http://127.0.0.1:3140',
      proxyOnly: true,
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
