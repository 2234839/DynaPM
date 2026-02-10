/**
 * 临时测试：网关代理到 http://amd:6806/
 *
 * 使用 localhost 作为 hostname，无需配置域名
 *
 * 运行: pnpm tsx test/test-amd-proxy.ts
 */

import { Gateway } from '../src/core/gateway.js';
import type { DynaPMConfig } from '../src/config/types.js';
import { pino } from 'pino';

const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
    },
  },
});

const config = {
  port: 3000,
  host: '0.0.0.0',
  services: {
    // 使用 localhost 作为 hostname
    // 请求 http://localhost:3000/ 会被代理到 http://amd:6806/
    'localhost': {
      name: 'amd',
      // TODO: 把 amd 替换成实际的服务器 IP 地址
      // 例如: base: 'http://192.168.1.100:6806',
      base: 'http://192.168.1.244:6806',
      idleTimeout: 60000,
      startTimeout: 30000,
      // 纯代理模式：只做反向代理，不启动/停止服务
      proxyOnly: true,
      commands: {
        start: 'echo "not used"',
        stop: 'echo "not used"',
        check: 'true',
      },
    },
  },
} satisfies DynaPMConfig;

const gateway = new Gateway(config, logger);

gateway.start().then(() => {
  console.log('\n========================================');
  console.log('✅ 网关已启动！（纯代理模式）');
  console.log('========================================');
  console.log('📡 监听地址: http://0.0.0.0:3000');
  console.log(`🎯 代理目标: ${config.services.localhost.base}`);
  console.log('');
  console.log('测试命令:');
  console.log('  curl http://localhost:3000/');
  console.log('  curl http://127.0.0.1:3000/');
  console.log('========================================\n');
}).catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
