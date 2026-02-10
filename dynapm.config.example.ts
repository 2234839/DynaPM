import type { DynaPMConfig } from './src/config/types';

/**
 * DynaPM配置示例
 *
 * 此配置文件展示了如何配置不同类型的服务管理方式
 * 包括PM2、Docker、systemd和直接启动等方式
 *
 * 启动方式：tsx src/index.ts
 * 访问管理界面：http://127.0.0.1:4001/
 */
const config: DynaPMConfig = {
  // 网关监听配置
  port: 3000,
  host: '127.0.0.1',

  // ==================== 管理 API 配置 ====================
  adminApi: {
    // 启用管理 API（默认：true）
    enabled: true,

    // 管理 API 端口（独立监听，提供 REST API）
    port: 4000,

    // 可选：设置认证令牌（建议在生产环境中设置）
    // authToken: process.env.DYNAPM_ADMIN_TOKEN,

    // 可选：限制允许访问的 IP（默认：仅本地）
    // allowedIps: ['127.0.0.1', '::1'],
  },

  // 服务配置映射：hostname -> 服务配置
  services: {
    // ==================== PM2 管理的 Node.js 应用 ====================
    'node-app.example.com': {
      name: 'my-node-app',
      base: 'http://127.0.0.1:3001',
      idleTimeout: 5 * 60 * 1000, // 5分钟无访问后停止
      startTimeout: 10 * 1000, // 最多等待10秒启动

      commands: {
        // PM2启动命令
        start: 'pm2 start /path/to/app.js --name my-node-app',

        // PM2停止命令
        stop: 'pm2 stop my-node-app',

        // PM2状态检查命令
        check: 'pm2 status | grep my-node-app | grep online',
      },

      // HTTP健康检查
      healthCheck: {
        type: 'http',
        url: 'http://127.0.0.1:3001/health',
        expectedStatus: 200,
        timeout: 5000,
      },
    },

    // ==================== Docker 容器应用 ====================
    'python-api.example.com': {
      name: 'python-api',
      base: 'http://127.0.0.1:8000',
      idleTimeout: 10 * 60 * 1000, // 10分钟
      startTimeout: 30 * 1000, // Docker启动较慢，给30秒

      commands: {
        // Docker启动命令
        start: 'docker run -d --name python-api -p 8000:8000 python-api-image',

        // Docker停止命令
        stop: 'docker stop python-api && docker rm python-api',

        // Docker状态检查命令
        check: 'docker inspect -f {{.State.Running}} python-api | grep true',
      },

      healthCheck: {
        type: 'http',
        url: 'http://127.0.0.1:8000/api/health',
        expectedStatus: 200,
      },
    },

    // ==================== systemd 服务 ====================
    'golang-service.example.com': {
      name: 'my-go-service',
      base: 'http://127.0.0.1:8080',
      idleTimeout: 15 * 60 * 1000, // 15分钟

      commands: {
        // systemd启动命令
        start: 'systemctl start my-go-service',

        // systemd停止命令
        stop: 'systemctl stop my-go-service',

        // systemd状态检查命令
        check: 'systemctl is-active my-go-service',
      },

      // 不进行健康检查，只要服务运行即可
      healthCheck: {
        type: 'none',
      },
    },

    // ==================== 直接启动的 Node.js 应用 ====================
    'direct-node.example.com': {
      name: 'simple-server',
      base: 'http://127.0.0.1:3002',
      idleTimeout: 3 * 60 * 1000, // 3分钟

      commands: {
        // 直接启动（使用nohup和重定向）
        start: 'nohup node /path/to/simple-server.js > /tmp/simple-server.log 2>&1 & echo $!',

        // 通过pkill停止
        stop: 'pkill -f "node /path/to/simple-server.js"',

        // 通过pgrep检查
        check: 'pgrep -f "node /path/to/simple-server.js"',
      },

      healthCheck: {
        type: 'http',
      },
    },

    // ==================== 带环境变量的服务 ====================
    'env-service.example.com': {
      name: 'env-aware-service',
      base: 'http://127.0.0.1:4000',
      idleTimeout: 5 * 60 * 1000,

      commands: {
        start: 'pm2 start /path/to/app.js --name env-service',
        stop: 'pm2 stop env-service',
        check: 'pm2 status | grep env-service | grep online',

        // 工作目录
        cwd: '/path/to/project',

        // 环境变量
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://localhost/mydb',
          API_KEY: 'your-api-key',
        },
      },

      healthCheck: {
        type: 'none',
      },
    },

    // ==================== Go 应用（Docker） ====================
    'go-app.example.com': {
      name: 'go-web-app',
      base: 'http://127.0.0.1:8081',
      idleTimeout: 8 * 60 * 1000,

      commands: {
        start: 'docker run -d --name go-web-app -p 8081:8080 my-go-app:latest',
        stop: 'docker stop go-web-app && docker rm go-web-app',
        check: 'docker inspect -f {{.State.Running}} go-web-app | grep true',
      },

      healthCheck: {
        type: 'http',
        url: 'http://127.0.0.1:8081/ping',
        expectedStatus: 200,
      },
    },

    // ==================== DynaPM 管理界面（专属端口） ====================
    // 访问地址: http://127.0.0.1:4001
    // 注意：专属端口不需要配置 hostname，直接通过端口访问
    'dynapm-admin': {
      name: 'dynapm-admin',
      port: 4001,  // 专属端口配置（注意与管理 API 端口 4000 分开）
      base: 'http://127.0.0.1:4002',
      idleTimeout: 10 * 60 * 1000, // 10分钟无操作后停止
      startTimeout: 5 * 1000,

      commands: {
        start: 'node admin/server.js',
        stop: 'lsof -ti:4002 | xargs -r kill -9',
        check: 'lsof -ti:4002 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // ==================== 多后端服务（不同路由指向不同端口） ====================
    // 一个服务同时监听多个端口，通过网关的不同入口访问
    // 访问方式 1: http://multi.test:3000 -> 转发到后端 8001 端口
    // 访问方式 2: http://127.0.0.1:5000 -> 转发到后端 8002 端口
    'multi-backend': {
      name: 'multi-backend',
      // base 字段仍然需要（用于健康检查或作为默认值）
      base: 'http://127.0.0.1:8001',
      // 使用 routes 配置指定不同的后端地址
      routes: [
        { type: 'host', value: 'multi.test', target: 'http://127.0.0.1:8001' },
        { type: 'port', value: 5000, target: 'http://127.0.0.1:8002' },
      ],
      idleTimeout: 5 * 60 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: 'nohup node /path/to/multi-backend.js > logs/multi.log 2>&1 &',
        stop: 'pkill -f "node /path/to/multi-backend.js"',
        check: 'pgrep -f "node /path/to/multi-backend.js"',
      },

      healthCheck: {
        type: 'tcp',
      },
    },

    // ==================== 通用服务（同时支持 hostname 和专属端口） ====================
    // 访问方式 1: http://universal.test:3000
    // 访问方式 2: http://127.0.0.1:5001
    'universal': {
      name: 'universal',
      host: 'universal.test',  // hostname 映射（可选）
      port: 5001,              // 专属端口（可选）
      base: 'http://127.0.0.1:5002',
      idleTimeout: 5 * 60 * 1000,
      startTimeout: 10 * 1000,

      commands: {
        start: 'nohup node /path/to/universal.js > logs/universal.log 2>&1 &',
        stop: 'lsof -ti:5001 | xargs -r kill -9',
        check: 'lsof -ti:5001 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp',
      },
    },
  },
};

export default config;
