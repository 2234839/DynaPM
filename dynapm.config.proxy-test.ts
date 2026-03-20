import type { DynaPMConfig } from './src/config/types';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 创建日志目录 */
const logDir = join(process.cwd(), 'logs');
try {
  mkdirSync(logDir, { recursive: true });
} catch {
  // 目录可能已存在
}

const config: DynaPMConfig = {
  port: 3090,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
    port: 3091,
  },

  logging: {
    enableRequestLog: false,
    enableWebSocketLog: false,
    enablePerformanceLog: false,
  },

  services: {
    /** Echo 测试服务（hostname 路由） */
    'echo-host': {
      name: 'echo-host',
      host: 'echo-host.test',
      base: 'http://127.0.0.1:3099',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/services/echo-server.ts >> ${logDir}/echo-test.log 2>&1 &`,
        stop: 'lsof -ti:3099 | xargs -r kill -9',
        check: 'lsof -ti:3099 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    /** Echo 测试服务（端口路由，纯代理模式） */
    'echo-proxy': {
      name: 'echo-proxy',
      port: 3092,
      base: 'http://127.0.0.1:3099',
      proxyOnly: true,
      idleTimeout: 10 * 1000,
      startTimeout: 5 * 1000,

      commands: {
        start: 'echo "proxy only"',
        stop: 'echo "proxy only"',
        check: 'echo "proxy only"',
      },
    },

    /** SSE 测试服务 */
    'sse-test': {
      name: 'sse-test',
      host: 'sse-proxy.test',
      base: 'http://127.0.0.1:3010',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/server-sse.ts >> ${logDir}/sse-test.log 2>&1 &`,
        stop: 'lsof -ti:3010 | xargs -r kill -9',
        check: 'lsof -ti:3010 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    /** WebSocket 测试服务 */
    'ws-test': {
      name: 'ws-test',
      host: 'ws-proxy.test',
      base: 'http://127.0.0.1:3011',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/server-ws.ts >> ${logDir}/ws-test.log 2>&1 &`,
        stop: 'lsof -ti:3011 | xargs -r kill -9',
        check: 'lsof -ti:3011 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
