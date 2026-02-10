import type { DynaPMConfig } from './src/config/types';

const config: DynaPMConfig = {
  port: 3000,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
  },

  services: {
    'test-app.local': {
      name: 'test-app',
      base: 'http://127.0.0.1:5000',
      idleTimeout: 60 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: 'node -e "require(\"http\").createServer((req, res) => res.end(\"Hello from test app\")).listen(5000)" &',
        stop: 'lsof -ti:5000 | xargs -r kill -9',
        check: 'lsof -ti:5000 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    'admin.dynapm.local': {
      name: 'dynapm-admin',
      base: 'http://127.0.0.1:4000',
      idleTimeout: 10 * 60 * 1000,
      startTimeout: 5 * 1000,

      commands: {
        start: 'node admin/server.js',
        stop: 'lsof -ti:4000 | xargs -r kill -9',
        check: 'lsof -ti:4000 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
