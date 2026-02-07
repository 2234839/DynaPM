import type { DynaPMConfig } from './src/config/types';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 创建日志目录
const logDir = join(process.cwd(), 'logs');
try {
  mkdirSync(logDir, { recursive: true });
} catch (err) {
  // 目录可能已存在
}

const config: DynaPMConfig = {
  port: 3000,
  host: '127.0.0.1',

  services: {
    // 测试服务1：使用端口检查
    'app1.test': {
      name: 'app1',
      base: 'http://127.0.0.1:3001',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        // 使用 nohup 后台启动，输出到日志文件
        start: `nohup node ${process.cwd()}/test/services/app1.js > ${logDir}/app1.log 2>&1 &`,
        // 使用端口查找并杀死进程（更可靠）
        stop: `lsof -ti:3001 | xargs -r kill -9`,
        // 使用 lsof 检查端口是否被监听
        check: `lsof -ti:3001 >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // 测试服务2：HTTP检查
    'app2.test': {
      name: 'app2',
      base: 'http://127.0.0.1:3002',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node ${process.cwd()}/test/services/app2.js > ${logDir}/app2.log 2>&1 &`,
        stop: `lsof -ti:3002 | xargs -r kill -9`,
        check: `lsof -ti:3002 >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'http',
        url: 'http://127.0.0.1:3002/',
        expectedStatus: 200,
      },
    },

    // 测试服务3：TCP检查
    'app3.test': {
      name: 'app3',
      base: 'http://127.0.0.1:3003',
      idleTimeout: 15 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node ${process.cwd()}/test/services/app3.js > ${logDir}/app3.log 2>&1 &`,
        stop: `lsof -ti:3003 | xargs -r kill -9`,
        check: `lsof -ti:3003 >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
