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
  port: 3080,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
    port: 3081,
  },

  logging: {
    enableRequestLog: false,
    enableWebSocketLog: false,
    enablePerformanceLog: false,
  },

  services: {
    /** Echo 测试服务（端口路由，非 proxyOnly，按需启动） */
    'port-echo': {
      name: 'port-echo',
      port: 3082,
      base: 'http://127.0.0.1:3098',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/services/echo-server.ts 3098 >> ${logDir}/port-echo.log 2>&1 &`,
        stop: 'lsof -i:3098 -P -n 2>/dev/null | grep LISTEN | awk \'{print $2}\' | sort -u | xargs -r kill -9',
        check: 'lsof -i:3098 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
