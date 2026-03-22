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
    enablePerformanceLog: false,
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
        stop: 'lsof -i:4002 -P -n 2>/dev/null | grep LISTEN | awk \'{print $2}\' | sort -u | xargs -r kill -9',
        check: 'lsof -i:4002 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // 测试服务1：使用端口检查
    'app1': {
      name: 'app1',
      host: 'app1.test',
      base: 'http://127.0.0.1:3001',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        // 使用 nohup 后台启动，统一输出到 services.log
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/services/app1.ts >> ${logDir}/services.log 2>&1 &`,
        // 使用端口查找并杀死 LISTEN 状态的进程（避免误杀网关）
        stop: `lsof -i:3001 -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9`,
        // 使用 lsof 检查端口是否被监听
        check: `lsof -i:3001 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // 测试服务2：HTTP检查
    'app2': {
      name: 'app2',
      host: 'app2.test',
      base: 'http://127.0.0.1:3002',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/services/app2.ts >> ${logDir}/services.log 2>&1 &`,
        stop: `lsof -i:3002 -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9`,
        check: `lsof -i:3002 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'http',
        url: 'http://127.0.0.1:3002/',
        expectedStatus: 200,
      },
    },

    // 测试服务3：TCP检查
    'app3': {
      name: 'app3',
      host: 'app3.test',
      base: 'http://127.0.0.1:3003',
      idleTimeout: 15 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/services/app3.ts >> ${logDir}/services.log 2>&1 &`,
        stop: `lsof -i:3003 -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9`,
        check: `lsof -i:3003 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // SSE 测试服务
    'sse-server': {
      name: 'sse-server',
      host: 'sse.test',
      base: 'http://127.0.0.1:3010',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/server-sse.ts >> ${logDir}/services.log 2>&1 &`,
        stop: `lsof -i:3010 -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9`,
        check: `lsof -i:3010 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // WebSocket 测试服务
    'ws-server': {
      name: 'ws-server',
      host: 'ws.test',
      base: 'http://127.0.0.1:3011',
      idleTimeout: 10 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/server-ws.ts >> ${logDir}/services.log 2>&1 &`,
        stop: `lsof -i:3011 -P -n 2>/dev/null | grep LISTEN | awk '{print $2}' | sort -u | xargs -r kill -9`,
        check: `lsof -i:3011 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1`,
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // 流式转发测试服务（纯代理模式，用于测试双向流式转发）
    // 网关在端口 3998 监听，代理到后端的 3999
    'stream-test': {
      name: 'stream-test',
      port: 3998,  // 网关监听端口
      base: 'http://127.0.0.1:3999',  // 后端服务器端口
      proxyOnly: true,  // 纯代理模式，不管理服务生命周期
      idleTimeout: 10 * 1000,
      startTimeout: 5 * 1000,
      commands: {
        start: 'echo "proxy only - no start command"',
        stop: 'echo "proxy only - no stop command"',
        check: 'echo "proxy only - no check command"',
      },
    },

    // Serverless Host 演示服务
    // 访问地址: http://127.0.0.1:4001 （Web 管理界面）
    'serverless-host': {
      name: 'serverless-host',
      host: 'serverless.test',
      base: 'http://127.0.0.1:4000',
      idleTimeout: 10 * 60 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup node --experimental-strip-types ${process.cwd()}/test/services/serverless-host/index.ts 4000 >> ${logDir}/serverless.log 2>&1 &`,
        stop: 'lsof -i:4000 -P -n 2>/dev/null | grep LISTEN | awk \'{print $2}\' | sort -u | xargs -r kill -9',
        check: 'lsof -i:4000 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
