import type { DynaPMConfigInput } from './src/config/types';

/**
 * 超时路径测试配置（独立端口 3140/3141，后端 3150-3152）
 * 通过注入极短 timeouts 验证启动超时/代理超时/停止等待超时三条路径
 */
export default {
  port: 3140,
  host: '127.0.0.1',
  adminApi: {
    enabled: true,
    port: 3141,
  },
  timeouts: {
    /** 探针请求等待 stopping 结束的上限：800ms 后返回 503 */
    stopWaitMs: 800,
    /** stop 命令执行超时必须 > stopWaitMs，否则 stop 先失败、状态回 online，探针走重新启动 */
    stopTimeoutMs: 5000,
    proxyTimeoutMs: 800,
  },
  logging: {
    enableErrorLog: true,
  },
  services: {
    'timeout-start.test': {
      base: 'http://127.0.0.1:3150',
      host: 'timeout-start.test',
      startTimeout: 300,
      commands: {
        /** 启动命令瞬间成功但端口永不监听 → 触发启动就绪轮询超时 */
        start: 'true',
        stop: 'true',
        check: 'false',
      },
    },
    'timeout-proxy.test': {
      base: 'http://127.0.0.1:3151',
      host: 'timeout-proxy.test',
      startTimeout: 5000,
      commands: {
        /** 启动 hang server：接受连接但永不响应 → 触发代理超时 504（输出重定向避免 exec 等待管道关闭） */
        start: 'nohup node /tmp/dynapm-timeout-hang-server.js >/dev/null 2>&1 &',
        stop: 'true',
        check: 'false',
      },
    },
    'timeout-stop.test': {
      base: 'http://127.0.0.1:3152',
      host: 'timeout-stop.test',
      startTimeout: 5000,
      commands: {
        /** 启动快速 echo server（输出重定向避免 exec 等待管道关闭） */
        start: 'nohup node /tmp/dynapm-timeout-echo-server.js >/dev/null 2>&1 &',
        /** stop 命令挂起 60s → 触发 stopping 等待超时 */
        stop: 'sleep 60',
        check: 'false',
      },
    },
  },
} satisfies DynaPMConfigInput;
