import type { DynaPMConfig } from './src/config/types';

const config: DynaPMConfig = {
  port: 3000,
  host: '127.0.0.1',

  adminApi: {
    enabled: true,
  },

  services: {
    'test-app': {
      name: 'test-app',
      host: 'test-app.local',
      base: 'http://127.0.0.1:5000',
      idleTimeout: 60 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: 'node -e "require(\"http\").createServer((req, res) => res.end(\"Hello from test app\")).listen(5000)" &',
        stop: 'lsof -i:5000 -P -n 2>/dev/null | grep LISTEN | awk \'{print $2}\' | sort -u | xargs -r kill -9',
        check: 'lsof -i:5000 -P -n 2>/dev/null | grep LISTEN >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    'dynapm-admin': {
      name: 'dynapm-admin',
      host: 'admin.dynapm.local',
      base: 'http://127.0.0.1:4000',
      idleTimeout: 10 * 60 * 1000,
      startTimeout: 5 * 1000,

      commands: {
        start: 'node admin/server.js',
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
