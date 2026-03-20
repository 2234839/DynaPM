# DynaPM

[中文文档](./README_zh.md)

> **Dynamic Process Manager** - A lightweight, universal service management system with serverless-like features.

[![npm version](https://badge.fury.io/js/dynapm.svg)](https://www.npmjs.com/package/dynapm) ![Tests](https://img.shields.io/badge/tests-81%2F81%20passing-green) ![Performance](https://img.shields.io/badge/overhead-25ms-brightgreen)

DynaPM is a **lightweight alternative** to complex container orchestration platforms (like Knative, Sablier) for private deployments. It helps you manage hundreds of low-frequency services on resource-constrained servers by starting them on-demand and stopping them when idle.

---

## 🎯 Why DynaPM?

### The Problem

You have many side projects or internal tools that:
- 🐌 **Are accessed infrequently** but need to be available instantly
- 💸 **Consume valuable RAM/CPU** even when idle
- 😓 **Don't justify the complexity** of Kubernetes/serverless platforms
- 🤔 **Are managed differently** (PM2, Docker, systemd, etc.)

### 💡 The Solution

**DynaPM acts as a smart gateway** that:
1. **Intercepts** incoming requests to your services
2. **Automatically starts** the service if offline (**only 25ms overhead** ⚡)
3. **Stream-proxies** the request (**1-2ms latency** 🚀)
4. **Stops** the service after a period of inactivity

> 💡 **Performance Note**: 25ms is DynaPM's overhead (startup command: 8ms + port wait: 17ms). Total cold start time also includes the service's own startup time (e.g., ~475ms for Node.js apps, ~500ms total).

### 🏆 What Makes DynaPM Different?

| Feature | DynaPM | Sablier | traefik-lazyload | Knative |
|---------|--------|---------|------------------|---------|
| **Technology** | Node.js + **uWS** | Go | Go | Go + K8s |
| **Scope** | ⭐ **Universal** (any process) | Docker only | Docker only | K8s only |
| **Setup Complexity** | ⭐ **Simple** | ⭐⭐⭐ Medium | ⭐⭐⭐ Medium | ⭐⭐⭐⭐⭐ Complex |
| **Infrastructure** | Single server | Docker/K8s | Docker + Traefik | K8s cluster |
| **Cold Start** | ⚡ **~25ms** overhead | Container startup required | Container startup required | 2-4 seconds ([source](https://groups.google.com/g/knative-users/c/vqkP95ibq60)) |
| **Proxy Latency** | 🚀 **1-2ms** | Via reverse proxy | Via reverse proxy | Via Activator/Queue-proxy |
| **Perfect For** | **Personal projects/Small teams** | Docker environments | Docker + Traefic | Enterprise K8s |

---

## ✨ Key Features

### ⚡ **Blazing Fast Cold Start**

```log
🚀 [myapp] GET / - Starting service...
[myapp] Start command executed
✅ [myapp] Service ready (startup: 8ms, wait: 17ms)
📤 [myapp] GET / - 200 - 30ms
```

- **DynaPM overhead**: Only **25ms** (startup command: 8ms + port wait: 17ms)
- **Instant retry**: Zero-delay polling, forward immediately when port is ready
- **Total cold start**: ~185ms (including service boot time, e.g., ~160ms for Node.js apps)

### 🚀 **Stream Proxying**

When services are running, proxy latency is only **1-2ms**:

```log
📤 [myapp] GET / - 200 - 1ms
📤 [myapp] POST /api/data - 200 - 2ms
```

True streaming with **uWebSockets.js** - zero buffering, 10x+ performance vs Fastify!

### 🌐 **SSE & WebSocket Support**

DynaPM supports modern real-time protocols out of the box:

**Server-Sent Events (SSE):**
```log
✅ [sse-server] Service ready (startup: 3ms, wait: 429ms)
📤 [sse-server] GET /events - 200 - 5.45s
```

**WebSocket:**
```log
✅ [ws-server] Backend WebSocket connected
📨 [ws-server] Forward message to backend: 30 bytes
🔌 [ws-server] Client WebSocket closed
```

**Smart connection tracking** prevents long connections from being shut down:
- Active SSE/WebSocket connections increment connection counter
- Services only stop when `activeConnections === 0` AND timeout expires
- No more premature service kills during active sessions

### 🎛️ **Universal Service Management**

Configure ANY service using bash commands - no limits:

```typescript
// PM2 services
{
  commands: {
    start: 'pm2 start app.js --name myapp',
    stop: 'pm2 stop myapp',
    check: 'pm2 status | grep myapp | grep online',
  }
}

// Docker containers
{
  commands: {
    start: 'docker run -d -p 3000:3000 myimage',
    stop: 'docker stop mycontainer',
    check: 'docker inspect -f {{.State.Running}} mycontainer',
  }
}

// systemd services
{
  commands: {
    start: 'systemctl start myservice',
    stop: 'systemctl stop myservice',
    check: 'systemctl is-active myservice',
  }
}

// Direct processes
{
  commands: {
    start: 'nohup node app.js > logs/app.log 2>&1 &',
    stop: 'lsof -ti:3000 | xargs -r kill -9',
    check: 'lsof -ti:3000 >/dev/null 2>&1',
  }
}
```

### 🔄 **Idle Resource Reclamation**

- Services auto-stop after X minutes of inactivity
- Configurable timeout per service
- Frees up RAM/CPU for active services
- Check interval: 3 seconds
- **Smart connection tracking**: Active long connections (SSE/WebSocket) prevent premature shutdown

### 📊 **High Performance Metrics**

```
Test Environment: Node.js HTTP Server (autocannon benchmark)

✅ Cold start:       ~185ms (DynaPM: 25ms + service boot: 160ms)
✅ Stream proxy:     Avg 10.3ms (range: 9-12ms)
✅ Throughput:       5,942 req/s (multi-service, 150 concurrent)
✅ Load test:        Low latency even under high concurrency
✅ Memory overhead:  ~50MB (Node.js runtime)
✅ Bundle size:      21.7KB (minified)
✅ Logging:          Structured JSON logging (Pino)
```

---

## 🚀 Quick Start

### Installation

```bash
# Install globally
npm install -g dynapm

# Or use with pnpm
pnpm install -g dynapm
```

### Configuration

Create a `dynapm.config.ts` file in your project directory:

```typescript
import type { DynaPMConfig } from 'dynapm';

const config: DynaPMConfig = {
  port: 3000,
  host: '127.0.0.1',

  // Logging configuration (optional, disable for better performance in production)
  logging: {
    enableRequestLog: false,      // Enable request/response logging (high frequency, affects performance)
    enableWebSocketLog: false,    // Enable WebSocket lifecycle logging
    // Error logging is always enabled
  },

  services: {
    'app.example.com': {
      name: 'my-app',
      base: 'http://127.0.0.1:3001',
      idleTimeout: 5 * 60 * 1000, // Auto-stop after 5 minutes idle
      startTimeout: 10 * 1000,    // Startup timeout

      commands: {
        start: 'nohup node /path/to/app.js > logs/app.log 2>&1 &',
        stop: 'lsof -ti:3001 | xargs -r kill -9',
        check: 'lsof -ti:3001 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp', // TCP port check (default, no service code changes needed)
      },
    },
  },
};

export default config;
```

### Usage

```bash
# Start the DynaPM gateway
dynapm

# Or use with npx
npx dynapm
```

Now access your services at `http://app.example.com:3000` - they'll start automatically!

---

## 🧪 Running Tests

DynaPM comes with a comprehensive automated test suite covering all core features.

### Quick Test

```bash
# Clone the project
git clone https://github.com/2234839/DynaPM.git
cd DynaPM

# Install dependencies
pnpm install

# Run the full test suite
pnpm test
```

### Test Coverage

The automated tests validate 81 test cases across 6 test suites:

1. ✅ **On-demand start** - Services auto-start when offline
2. ✅ **Hot start** - Direct proxy when service is running
3. ✅ **Auto-stop** - Services auto-stop after timeout
4. ✅ **404 handling** - Unconfigured services return 404
5. ✅ **Multi-service** - Manage multiple services concurrently
6. ✅ **Health checks** - TCP and HTTP check methods
7. ✅ **Path proxying** - Different paths proxy correctly
8. ✅ **Idle protection** - Continuous requests update idle time
9. ✅ **POST requests** - POST method support
10. ✅ **SSE streaming** - Server-Sent Events proxy support
11. ✅ **WebSocket** - WebSocket bidirectional communication support
12. ✅ **Long connections** - Active connections prevent premature shutdown
13. ✅ **Concurrent startup** - Multiple requests to offline service
14. ✅ **Security hardening** - Body size limits, CRLF injection protection
15. ✅ **Port routing** - Direct port-based proxy and on-demand start

### Test Output Example

```
============================================================
Test Results Summary
============================================================
✓ Test 1: On-demand start (773ms)
✓ Test 2: Hot start (service running) (11ms)
✓ Test 3: Auto-stop (18025ms)
✓ Test 4: 404 error handling (11ms)
✓ Test 5: Multi-service concurrent start (843ms)
✓ Test 6: Different health checks (20ms)
✓ Test 7: Path proxying (10ms)
✓ Test 8: Idle time update on continuous requests (14112ms)
✓ Test 9: POST requests (12ms)
✓ Test 10: SSE streaming (3963ms)
✓ Test 11: WebSocket (1098ms)
✓ Test 12: Long connections (10110ms)

------------------------------------------------------------
Total: 12 tests
Passed: 12 ✓
Failed: 0
🎉 All tests passed!
```

### Performance Verification

Tests output detailed performance logs:

```log
🚀 [app1] GET / - Starting service...
[app1] Start command executed
✅ [app1] Service ready (startup: 8ms, wait: 17ms)
📤 [app1] GET / - 200 - 30ms

# Subsequent requests (service already running)
📤 [app1] GET / - 200 - 1ms
📤 [app1] POST /api/data - 200 - 2ms
```

---

## 📊 Performance Benchmarking

DynaPM includes an automated performance test script to verify system metrics.

### Running Performance Tests

```bash
# Clone the project
git clone https://github.com/2234839/DynaPM.git
cd DynaPM

# Install dependencies
pnpm install

# Build the project
pnpm build

# Run performance benchmark
pnpm benchmark
```

### Performance Test Output

```
🚀 DynaPM Performance Benchmark

============================================================
Cold Start Performance
============================================================
✓ Cold start success, total time: 48ms
  DynaPM overhead: ~25ms (startup command + port wait)
  Service boot: ~23ms (Node.js application)

============================================================
Stream Proxy Latency
============================================================
✓ Stream proxy test completed (10 requests)
  Average latency: 9.5ms
  Min latency: 8ms
  Max latency: 14ms
  Latency range: 8ms - 14ms

============================================================
Throughput Test (autocannon)
============================================================
ℹ Running 5s load test (50 concurrent)...
  Multi-service throughput: 8,383 req/s
  Single-service throughput: 4,225+ req/s
  Average latency: ~23ms
  Zero errors under high concurrency
```

### Test Requirements

- **Node.js**: Run DynaPM gateway
- **curl**: Basic functionality testing
- **autocannon** (optional): Throughput load testing

Install autocannon:
```bash
npm install -g autocannon
```

---

## 📖 Configuration Examples

Check out [dynapm.config.example.ts](./dynapm.config.example.ts) for complete examples including:
- PM2-managed Node.js apps
- Docker containers
- systemd services
- Direct process management
- Environment variables
- Custom health checks (HTTP/TCP/Command)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│              User Request                        │
│   http://app.example.com:3000/api/data          │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│      DynaPM Gateway (uWebSockets.js)             │
│  - Check service status (memory cached)          │
│  - Execute start command if needed (8ms)         │
│  - Fast TCP port polling (17ms, zero-delay retry)│
│  - Stream proxy request (1-2ms)                  │
│  - Structured logging (Pino, async)              │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│              Your Services                       │
│  - PM2, Docker, systemd, or any process         │
│  - Auto-stopped when idle                        │
└─────────────────────────────────────────────────┘
```

### Core Optimizations

1. **Memory state cache** - No bash command execution on every request
2. **Fast TCP port check** - 100ms timeout, instant retry on failure
3. **Stream forward instead of wait** - Forward immediately when port is ready
4. **Startup time breakdown** - Clear display of command time vs wait time

---

## 📊 Performance Benchmarks

All performance data measured via `pnpm benchmark` script.

### Cold Start Performance

```
Test: Total time from offline to first accessible request

Results:
├─ DynaPM overhead:   25ms (startup command: 8ms + TCP port wait: 17ms)
├─ Service boot:      160ms (Node.js application)
└─ Total cold start:  185ms
```

### Stream Proxy Performance

```
Test: Single request latency when service is running

Results:
├─ Average latency:  10.3ms
├─ Min latency:      9ms
├─ Max latency:      12ms
└─ Latency range:    9-12ms
```

### Throughput Performance

```
Test: Multi-service benchmark (3 services × 50 concurrent, 5 seconds)

Results:
├─ Total requests:      29,710 requests
├─ Average throughput:  5,942 req/s
├─ Per-service:         ~1,980 req/s
├─ Errors:              0
└─ Test duration:       5 seconds
```

### Resource Usage

```
Runtime resource usage:

├─ Memory:          ~50MB (Node.js runtime)
├─ CPU:             <1% when idle
├─ Disk:            21.7KB (bundle size, minified)
├─ Network:         Proxy traffic only, no overhead
└─ Logging:         Async structured logging (Pino)
```

---

## 🎨 Use Cases

- **👨‍💻 Personal projects**: Keep dozens of side projects ready without eating RAM
- **🛠️ Internal tools**: On-demand access to development/testing environments
- **🔧 Microservices**: Lightweight alternative to Kubernetes for small deployments
- **💰 Resource optimization**: Maximize server utilization by stopping idle services
- **📦 Cost saving**: Run more services on smaller VPS instances
- **🎓 Learning & experiments**: Easily manage multiple test projects

---

## 🔧 Roadmap

- [ ] 🎛️ **Web Dashboard** - Service monitoring and management UI
- [ ] 📈 **Prometheus Integration** - Metrics collection and visualization
- [ ] 📋 **Service Templates** - One-click PM2/Docker config generation
- [ ] 🔄 **Multi-instance Support** - Distributed locking and state sync
- [ ] 🔌 **Plugin System** - Custom integrations and extensions
- [ ] 🌐 **More Health Checks** - gRPC, Redis, etc.
- [x] ⚡ **uWebSockets.js Migration** - Completed (10x+ performance improvement)
- [x] 📊 **Structured Logging** - Completed (Pino async logging)

---

## 📦 Publishing Releases

DynaPM uses GitHub Actions to automatically publish to npm, requiring no manual tokens or 2FA.

### Release Process

The project uses **npm OIDC (OpenID Connect) Trusted Publishing**, automatically triggered by Git tags:

```bash
# Method 1: patch version (bug fixes)
npm version patch
git push origin main --tags

# Method 2: minor version (new features)
npm version minor
git push origin main --tags

# Method 3: major version (breaking changes)
npm version major
git push origin main --tags
```

### Automated Release Workflow

After pushing a tag, GitHub Actions automatically:

1. ✅ **Build project** - Compile TypeScript with rslib
2. ✅ **Verify build** - Check output file integrity
3. ✅ **Publish to npm** - Use OIDC, no tokens needed
4. ✅ **Create Release** - Generate release notes on GitHub

### Monitor Release Status

- **GitHub Actions**: https://github.com/2234839/DynaPM/actions
- **npm package**: https://www.npmjs.com/package/dynapm

### Verify Release

```bash
# Check latest version
npm view dynapm version

# View version history
npm view dynapm versions --json

# Install and test
npm install -g dynapm@latest
```

### Publishing Configuration

This project uses **npm Trusted Publishing**:
- ✅ No NPM_TOKEN environment variable needed
- ✅ No two-factor authentication (2FA) required
- ✅ Automatic verification via GitHub Actions OIDC
- ✅ More secure (short-lived tokens, auto-expiry)

For detailed setup: [docs/NPM_OIDC_SETUP.md](./docs/NPM_OIDC_SETUP.md)

### Version Numbering

Follows [Semantic Versioning](https://semver.org/):

- **1.0.4** → **1.0.5** (`patch`): Bug fixes
- **1.0.4** → **1.1.0** (`minor`): New features, backward compatible
- **1.0.4** → **2.0.0** (`major`): Breaking changes

---

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

Workflow:
1. Fork the project
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

ISC

---

## 🙏 Acknowledgments

Built with amazing open-source tools:
- [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) - Highest performance web server for Node.js (10x+ faster than Fastify)
- [Pino](https://getpino.io/) - Extreme fast structured logger
- [c12](https://github.com/unjs/c12) - Configuration loader

---

## 📮 Support

- 🐛 **Bug Reports**: [GitHub Issues](https://github.com/2234839/DynaPM/issues)
- 💡 **Feature Requests**: [GitHub Discussions](https://github.com/2234839/DynaPM/discussions)
- 👤 **Author**: 崮生

---

**⚡ Made with ❤️ for resource-conscious developers**
