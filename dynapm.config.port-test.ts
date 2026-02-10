import type { DynaPMConfig } from './src/config/types';

const config: DynaPMConfig = {
  port: 3000,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
  },

  services: {
    // 只有 hostname 映射的服务
    'app1.test': {
      name: 'app1',
      base: 'http://127.0.0.1:3001',
      idleTimeout: 60 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: `node -e "require('http').createServer((req, res) => res.end('App1 on port 3001')).listen(3001)" &`,
        stop: 'lsof -ti:3001 | xargs -r kill -9',
        check: 'lsof -ti:3001 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // 有专属端口的管理界面
    'dynapm-admin': {
      name: 'dynapm-admin',
      port: 4000,
      base: 'http://127.0.0.1:4001',
      idleTimeout: 10 * 60 * 1000,
      startTimeout: 5 * 1000,

      commands: {
        start: 'node admin/server.js',
        stop: 'lsof -ti:4001 | xargs -r kill -9',
        check: 'lsof -ti:4001 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
