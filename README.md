# DynaPM

[中文文档 (Chinese Documentation)](./README_zh.md)

> **Dynamic Process Manager** - A lightweight, universal service management system with serverless-like features.
>
> ⚙️ The current implementation is a single-file native Rust binary ([`packages/gateway-rs`](./packages/gateway-rs)). The legacy Bun/TS version is deprecated (only a [README tombstone](./packages/gateway/README.md) remains).

![Tests](https://img.shields.io/badge/tests-5%2F5%20suites%20passing-green) ![Performance](https://img.shields.io/badge/overhead-25ms-brightgreen) ![Runtime](https://img.shields.io/badge/runtime-Rust%20%2B%20tokio-orange)

DynaPM is a **lightweight alternative** to complex container orchestration platforms (like Knative, Sablier) for private deployments. It helps you manage hundreds (or thousands) of low-frequency services on resource-constrained servers by starting them on-demand and stopping them when idle.

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
| **Technology** | **Rust** (tokio + axum, single binary) | Go | Go | Go + K8s |
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

True bidirectional streaming (request body → upstream, response body → client) with **zero buffering** — the only time DynaPM buffers is when a request arrives while the service is still cold-starting.

Slow clients can't hold upstream connections hostage: `timeouts.stallTimeoutMs` (default 120s, `0` disables) disconnects a stream or WebSocket where **not a single chunk** arrives within the window. `proxyTimeoutMs` only covers *connect → response headers*, so SSE and long streaming responses are never cut off prematurely.

### 🌐 **SSE & WebSocket Support**

DynaPM supports modern real-time protocols out of the box — WebSocket upgrades are sniffed and taken over on **any path** (no rewrite rules needed):

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

### �️ **Panel Federation (Aggregated Management)**

The admin panel can connect to other DynaPM gateways, letting you view/start/stop/edit services across all your servers from a single panel:

- **Config-based onboarding**: Fill in the remote gateway's URL + admin token in the panel's "Panel Manager" dialog; stored in browser localStorage, no centralized component needed
- **Full capability**: Remote service lists, stats charts, service details, start/stop/disable, and in-place remote config editing — same experience as the local panel
- **Security model**: Cross-origin access is controlled by the `adminApi.corsOrigins` origin whitelist (exact match, **empty by default = all cross-origin requests denied**); auth is still enforced by `adminApi.authToken`

```jsonc
// Gateway config of the gateway being connected (which panel origins may access the admin API cross-origin)
{
  "adminApi": {
    "authToken": "<token>",
    "host": "dynapm.example.com",
    "corsOrigins": ["http://dynapm.localhost", "https://panel.other.com"]
  }
}
```

### �📊 **High Performance Metrics**

```
Test Environment: Node.js HTTP Server (autocannon benchmark)

✅ Cold start:       ~185ms (DynaPM: 25ms + service boot: 160ms)
✅ Stream proxy:     Avg 10.3ms (range: 9-12ms)
✅ Throughput:       5,942 req/s (multi-service, 150 concurrent)
✅ Load test:        Low latency even under high concurrency
✅ Memory overhead:  ~10MB RSS (native Rust binary)
✅ Binary size:      ~10MB (static musl build, zero runtime deps)
✅ Logging:          Structured JSON logging (built-in)
```

---

## 🚀 Quick Start

### Installation

Build from source (Rust toolchain required):

```bash
git clone https://github.com/2234839/DynaPM.git
cd DynaPM/packages/gateway-rs
cargo build --release
# Binary: target/release/dynapm

# Optional: fully static build (runs on any Linux)
RUSTFLAGS="-C target-feature=+crt-static" \
  cargo build --release --target x86_64-unknown-linux-musl
```

### Configuration

Create a `dynapm.config.json` file in your project directory:

```jsonc
{
  "port": 3000,
  "host": "127.0.0.1",

  // Optional: timeout tuning (defaults shown)
  "timeouts": {
    "proxyTimeoutMs": 30000,  // connect → response headers
    "stallTimeoutMs": 120000  // response/WS stall disconnect (0 disables)
  },

  // Logging configuration (optional, disable for better performance in production)
  "logging": {
    "enableRequestLog": false,
    "enableWebSocketLog": false
  },

  "services": {
    "my-app": {
      "base": "http://127.0.0.1:3001",
      "host": "app.example.com",   // route by Host header
      "idleTimeout": 300000,        // auto-stop after 5 minutes idle
      "startTimeout": 10000,
      "commands": {
        "startExec": ["node", "/path/to/app.js"]
      },
      "healthCheck": {
        "type": "tcp"              // TCP port check (default)
      }
    }
  }
}
```

### Usage

```bash
# Start the DynaPM gateway
DYNAPM_CONFIG=./dynapm.config.json ./dynapm

# Admin panel: http://127.0.0.1:3000/_dynapm/panel
```

Requests to `http://app.example.com:3000` now start the service automatically!

---

## 🧪 Running Tests

DynaPM comes with a regression suite of 5 test suites (66 assertions) covering the gateway core.

```bash
git clone https://github.com/2234839/DynaPM.git
cd DynaPM/packages/gateway-rs

# Clean up leftover processes first (required on WSL: stale listeners cause TCP black holes)
pkill -f 'release/dynapm'; pkill -f 'test/backend.ts'

# Run all 5 suites serially (requires Bun >= 1.4)
bun test/run-all.ts
```

### Test Coverage

1. ✅ **test-core** (20) - hostname routing, request/response streaming, status & header passthrough, unknown-Host 404, CRLF injection stripping, 50-way concurrency
2. ✅ **test-coldstart** (17) - on-demand start state machine, concurrent start single-flight, startup failure 503, idle reclamation, keepWarm, disable/enable
3. ✅ **test-ws** (9) - any-path WS upgrade, subprotocol passthrough, close-code passthrough, binary frames, cold-start WS
4. ✅ **test-limits** (9) - 413 precheck & streaming cutoff, 504 proxy timeout, stall-timeout disconnect, no false kills
5. ✅ **test-admin** (11) - admin API, SSE lifecycle events, stats, panel, admin-plane isolation

```log
test-core:     20 passed, 0 failed
test-coldstart: 17 passed, 0 failed
test-ws:        9 passed, 0 failed
test-limits:    9 passed, 0 failed
test-admin:    11 passed, 0 failed
========== Summary: 5/5 suites passed ==========
```

---

## 📊 Performance Benchmarking

Benchmarks use the built binary plus any HTTP load generator (e.g. autocannon):

```bash
npm install -g autocannon

cd packages/gateway-rs && cargo build --release
# point dynapm.config.json at a backend, start the gateway, then:
autocannon -c 50 -d 5 http://127.0.0.1:3000/
```

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

- **Rust toolchain**: Build the gateway (`cargo build --release`)
- **Bun** (>= 1.4): Run the regression test suite
- **curl** / **autocannon** (optional): Manual & load testing (`npm install -g autocannon`)

---

## 📖 Configuration Examples

Check out [`packages/gateway-rs/dynapm.config.json`](./packages/gateway-rs/dynapm.config.json) for complete examples including:
- PM2-managed Node.js apps
- Docker containers (tip: use `http` health checks — docker-proxy accepts TCP before the app is ready)
- systemd services
- Direct process management
- Port-based routing & TCP passthrough
- Custom health checks (HTTP/TCP/Command)
- Timeout tuning (`proxyTimeoutMs` / `stallTimeoutMs` / `stopWaitMs`)

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
│      DynaPM Gateway (Rust: tokio + axum)         │
│  - Route by Host header / dedicated port        │
│  - On-demand start state machine (25ms)         │
│  - Fast TCP port polling (backoff retry)        │
│  - Bidirectional stream proxy (zero buffering)  │
│  - Any-path WebSocket upgrade sniffing          │
│  - Stall timeout for slow clients               │
│  - Structured logging (JSON lines, built-in)     │
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
Runtime resource usage (native Rust binary):

├─ Memory:          ~10MB RSS
├─ CPU:             <1% when idle
├─ Disk:            ~10MB (static musl binary, zero runtime deps)
├─ Network:         Proxy traffic only, no overhead
└─ Logging:         Structured JSON logging (built-in)
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

- [x] 🎛️ **Web Dashboard** - Service monitoring and management UI ([admin-ui](./packages/admin-ui), Vue3 + ECharts)
- [x] ⚡ **Rust rewrite** - Completed (tokio + axum, single-file static binary)
- [x] 🌐 **Any-path WebSocket upgrade** - Upgrade-header sniffing on every route
- [x] 🐌 **Slow-client stall timeout** - `timeouts.stallTimeoutMs`
- [ ] 📈 **Prometheus Integration** - Metrics collection and visualization
- [ ] 📋 **Service Templates** - One-click PM2/Docker config generation
- [ ] 🔄 **Multi-instance Support** - Distributed locking and state sync
- [ ] 🔌 **Plugin System** - Custom integrations and extensions
- [ ] 🌐 **More Health Checks** - gRPC, Redis, etc.
- [x] 📊 **Structured Logging** - Completed (JSON-line logging)

---

## 📦 Publishing Releases

Releases ship as **static musl binaries attached to GitHub Releases** (the legacy npm-publish workflow was retired along with the Bun version).

Planned process: update CHANGELOG → commit → tag → push → CI builds & publishes the release.

Historical npm OIDC setup notes are kept in [docs/NPM_OIDC_SETUP.md](./docs/NPM_OIDC_SETUP.md).

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
- [tokio](https://tokio.rs/) / [axum](https://github.com/tokio-rs/axum) - Async runtime & HTTP framework
- [reqwest](https://github.com/seanmonstar/reqwest) / [tokio-tungstenite](https://github.com/snapview/tokio-tungstenite) - Upstream HTTP & WebSocket clients
- [Bun](https://bun.sh/) - Test suite runtime
- [Vue 3](https://vuejs.org/) / [ECharts](https://echarts.apache.org/) - Admin dashboard

---

## 📮 Support

[![扫码加入微信群 / Join our WeChat group](https://tsfullstack.heartstack.space/group/gs.svg?from=dynapm)](https://tsfullstack.heartstack.space/group/gs?from=dynapm)

- 🐛 **Bug Reports**: [GitHub Issues](https://github.com/2234839/DynaPM/issues)
- 💡 **Feature Requests**: [GitHub Discussions](https://github.com/2234839/DynaPM/discussions)
- 👤 **Author**: 崮生

---

**⚡ Made with ❤️ for resource-conscious developers**
