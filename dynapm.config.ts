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

  // 管理 API 配置
  adminApi: {
    enabled: true,
    port: 4000,
  },

  // 日志配置（生产环境建议关闭以提升性能）
  logging: {
    // 是否启用请求日志（每个 HTTP 请求响应记录）- 高频，影响性能
    enableRequestLog: false,
    // 是否启用 WebSocket 生命周期日志 - 中频，调试时有用
    enableWebSocketLog: false,
    // 是否启用性能分析日志（用于性能优化调试）- 仅在优化时启用
    enablePerformanceLog: true,
    // 错误日志始终启用，不受此开关控制
    // enableErrorLog: true,
  },

  services: {
    // ==================== DynaPM 管理界面 ====================
    // 访问地址: http://127.0.0.1:4001
    'dynapm-admin': {
      name: 'dynapm-admin',
      port: 4001,  // 独立端口
      base: 'http://127.0.0.1:4002',  // 实际运行端口
      idleTimeout: 10 * 60 * 1000,  // 10分钟
      startTimeout: 5 * 1000,

      commands: {
        start: `nohup node ${process.cwd()}/admin/server.js >> ${logDir}/admin.log 2>&1 &`,
        stop: 'lsof -ti:4002 | xargs -r kill -9',
        check: 'lsof -ti:4002 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // 测试服务1：使用端口检查
    'app1.test': {
      name: 'app1',
      base: 'http://127.0.0.1:3001',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        // 使用 nohup 后台启动，统一输出到 services.log
        start: `nohup node ${process.cwd()}/test/services/app1.js >> ${logDir}/services.log 2>&1 &`,
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
        start: `nohup node ${process.cwd()}/test/services/app2.js >> ${logDir}/services.log 2>&1 &`,
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
        start: `nohup node ${process.cwd()}/test/services/app3.js >> ${logDir}/services.log 2>&1 &`,
        stop: `lsof -ti:3003 | xargs -r kill -9`,
        check: `lsof -ti:3003 >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // SSE 测试服务
    'sse.test': {
      name: 'sse-server',
      base: 'http://127.0.0.1:3010',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup npx tsx ${process.cwd()}/test/server-sse.ts >> ${logDir}/services.log 2>&1 &`,
        stop: `lsof -ti:3010 | xargs -r kill -9`,
        check: `lsof -ti:3010 >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // WebSocket 测试服务
    'ws.test': {
      name: 'ws-server',
      base: 'http://127.0.0.1:3011',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup npx tsx ${process.cwd()}/test/server-ws.ts >> ${logDir}/services.log 2>&1 &`,
        stop: `lsof -ti:3011 | xargs -r kill -9`,
        check: `lsof -ti:3011 >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
