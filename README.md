# DynaPM

[English](./README.md) · [中文文档 (Chinese)](./README_zh.md) · [Detailed Docs](./docs/DETAILS.md)

> **Dynamic Process Manager** — Run hundreds of low-traffic services on a small server: started on demand when accessed, automatically reclaimed when idle.

![Tests](https://img.shields.io/badge/tests-5%2F5%20suites%20passing-green) ![Performance](https://img.shields.io/badge/overhead-25ms-brightgreen) ![Runtime](https://img.shields.io/badge/runtime-Rust%20%2B%20tokio-orange)

---

## The Problem It Solves

You have many side projects / internal tools / MCP services. They get little traffic, but must be available at all times. Keeping every one of them running will eat up a small server's memory; Kubernetes is way too heavy for this.

DynaPM is a **smart gateway**: when a request arrives, it looks up the target service by domain/port — if the service isn't running, it starts it and then forwards the request; when a service has been idle for a while, it is automatically stopped to free resources. The whole process is transparent to visitors.

- ⚡ **Cold-start overhead is only ~25ms** (excluding the service's own startup time) — virtually imperceptible
- 🚀 **Runtime proxy latency 1-2ms**, bidirectional streaming, SSE / WebSocket out of the box
- 🎛️ **Universal**: wire up PM2 / Docker / systemd / any bare process with bash commands — no infrastructure lock-in
- 🖥️ **Built-in admin panel**: service list, stats charts, remote start/stop, multi-server panel federation

## Getting Started

### 1. Download

Grab a prebuilt static binary from [GitHub Releases](https://github.com/2234839/DynaPM/releases) — Linux (x86_64 / aarch64, musl static, zero dependencies) and macOS (x86_64 / aarch64) are available:

```bash
# Example: Linux x86_64 — check the release page for the exact versioned filename
wget https://github.com/2234839/DynaPM/releases/download/<tag>/dynapm-<tag>-linux-x86_64.tar.gz
tar xzf dynapm-*-linux-x86_64.tar.gz && chmod +x dynapm
```

Prefer building from source? `cargo build --release` in `packages/gateway-rs` produces the same single binary.

### 2. Write a config

```jsonc
{
  "port": 3000,
  "services": {
    "app.example.com": {
      "base": "http://127.0.0.1:3001",
      "idleTimeout": 300000,          // auto-stop after 5 minutes idle
      "commands": {
        "start": "nohup node /path/to/app.js > logs/app.log 2>&1 &",
        "stop": "lsof -ti:3001 | xargs -r kill -9",
        "check": "lsof -ti:3001 >/dev/null 2>&1"
      }
    }
  }
}
```

### 3. Run

```bash
DYNAPM_CONFIG=./dynapm.config.json ./dynapm
# Admin panel: http://127.0.0.1:3000/_dynapm/panel
```

Now visiting `http://app.example.com:3000` starts the service automatically. For more options (health checks, port routing, keepWarm, timeout tuning, etc.), see the [detailed docs](./docs/DETAILS.md) and the [sample config](./packages/gateway-rs/dynapm.config.json).

## Use Cases

- 👨‍💻 Personal side projects: dozens of projects accessible at any time, with almost no memory footprint
- 🤖 AI Agents / MCP Servers: elastic hosting for naturally "low-frequency + on-demand" tool services
- 🛠️ Internal tools: on-demand access for dev / staging environments
- 💰 Small VPS cost optimization: run the most services with the least money

## Acknowledgements

DynaPM is built on these great open-source projects:

- [tokio](https://tokio.rs/) / [axum](https://github.com/tokio-rs/axum) — async runtime and HTTP framework
- [reqwest](https://github.com/seanmonstar/reqwest) / [tokio-tungstenite](https://github.com/snapview/tokio-tungstenite) — upstream HTTP and WebSocket clients
- [Bun](https://bun.sh/) — runtime for the regression test suites
- [Vue 3](https://vuejs.org/) / [ECharts](https://echarts.apache.org/) — admin panel

## Community

[![Scan to join the developer community](https://tsfullstack.heartstack.space/group/gs.svg?from=dynapm)](https://tsfullstack.heartstack.space/group/gs?from=dynapm)

- 🐛 Bug reports: [GitHub Issues](https://github.com/2234839/DynaPM/issues)
- 💡 Feature requests: [GitHub Discussions](https://github.com/2234839/DynaPM/discussions)
- 👤 Author: 崮生 (gs)

---

**⚡ Made with ❤️ for resource-conscious developers**
