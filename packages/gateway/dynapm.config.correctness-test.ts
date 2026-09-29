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

/**
 * 正确性修复测试专用配置
 * 端口独立（3130/3131），避免与其他测试冲突
 */
const config: DynaPMConfig = {
  port: 3130,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
    port: 3131,
    /**
     * 白名单验证：c12 会与 loader 默认值深合并（默认含 127.0.0.1/::1）。
     * 因此真实 remoteAddress 是 127.0.0.1 必然通过；
     * 本测试断言「伪造 XFF: 10.88.77.66 的请求被拒绝」——旧实现信任 XFF 头会通过，
     * 新实现用真实 remoteAddress(127.0.0.1)，而 127.0.0.1 也在合并后白名单里，
     * 所以这里必须让 XFF 伪造值也不在白名单、且真实 IP 在白名单之外才能区分两种实现。
     * 权衡后采用：allowedIps 设为一个非本机 IP，同时测试断言伪造 XFF=白名单 IP 被拒
     * （真实 remoteAddress=127.0.0.1 不在白名单 -> 403；旧实现信任 XFF -> 200）。
     * 但 c12 合并把 127.0.0.1 也放进来了，因此改为在测试内跳过 loader 默认值：
     * 配置 allowedIps: ['10.99.99.99', '0.0.0.0']，断言 XFF: 10.99.99.99 的请求
     * 收到 403（真实 IP 127.0.0.1 在默认合并白名单中，仍会 200）。
     */
    allowedIps: ['10.99.99.99', '0.0.0.0'],
  },

  logging: {
    enableRequestLog: false,
    enableWebSocketLog: false,
    enablePerformanceLog: false,
  },

  services: {
    /** Echo 服务（hostname 路由），用于 413 超限请求体测试 */
    'echo-host': {
      name: 'echo-host',
      host: 'echo-host.test',
      base: 'http://127.0.0.1:3099',
      idleTimeout: 60 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `nohup bun run ${process.cwd()}/test/services/echo-server.ts >> ${logDir}/echo-correctness-test.log 2>&1 &`,
        stop: 'lsof -i:3099 -P -n 2>/dev/null | grep LISTEN | awk \'{print $2}\' | sort -u | xargs -r kill -9',
        check: 'lsof -i:3099 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    /** 慢启动 WS 服务（延迟 2 秒启动后端），用于消息队列超限测试 */
    'ws-slow': {
      name: 'ws-slow',
      host: 'ws-slow.test',
      base: 'http://127.0.0.1:3111',
      idleTimeout: 60 * 1000,
      startTimeout: 15 * 1000,

      commands: {
        start: `sleep 2 && nohup bun run ${process.cwd()}/test/services/server-ws.ts 3111 >> ${logDir}/ws-slow-test.log 2>&1 &`,
        stop: 'lsof -i:3111 -P -n 2>/dev/null | grep LISTEN | awk \'{print $2}\' | sort -u | xargs -r kill -9',
        check: 'lsof -i:3111 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
