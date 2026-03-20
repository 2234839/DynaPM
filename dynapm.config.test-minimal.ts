
import type { DynaPMConfig } from './src/config/types';
const config: DynaPMConfig = {
  port: 3090,
  host: '127.0.0.1',
  adminApi: { enabled: true, port: 3091 },
  logging: { enableRequestLog: false, enableWebSocketLog: false, enablePerformanceLog: false },
  services: {
    'test-proxy': {
      name: 'test-proxy',
      host: 'test-proxy.test',
      base: 'http://127.0.0.1:3099',
      proxyOnly: true,
      idleTimeout: 60000,
      startTimeout: 5000,
      commands: { start: 'echo x', stop: 'echo x', check: 'echo x' },
    },
  },
};
export default config;
