# DynaPM

[English](./README.md) · [中文文档 (Chinese)](./README_zh.md) · [Detailed Docs](./docs/DETAILS.md)

> **Dynamic Process Manager** — Run **thousands** of low-traffic services on a small server: started on demand when accessed, automatically reclaimed when idle.

![Tests](https://img.shields.io/badge/tests-5%2F5%20suites%20passing-green) ![Performance](https://img.shields.io/badge/overhead-25ms-brightgreen) ![Scale](https://img.shields.io/badge/benchmark-10k%20services%20%40%206.4%25%20concurrency-blue) ![Runtime](https://img.shields.io/badge/runtime-Rust%20%2B%20tokio-orange)

---

## The Problem It Solves

You have many side projects / internal tools / MCP services. They get little traffic, but must be available at all times. Keeping every one of them running will eat up a small server's memory; Kubernetes is way too heavy for this.

DynaPM is a **smart gateway**: when a request arrives, it looks up the target service by domain/port — if the service isn't running, it starts it and then forwards the request; when a service has been idle for a while, it is automatically stopped to free resources. The whole process is transparent to visitors.

- ⚡ **Cold-start overhead is only ~25ms** (excluding the service's own startup time) — virtually imperceptible
- 🚀 **Runtime proxy latency 1-2ms**, bidirectional streaming, SSE / WebSocket out of the box
- 📈 **Proven at 10k scale**: benchmarked with 10,000 real start/stop instances — 99.97% success rate, peak concurrency only 6.4% under Zipf traffic, gateway memory < 700MB
- 🎛️ **Universal**: wire up PM2 / Docker / systemd / any bare process with bash commands — no infrastructure lock-in
- 🖥️ **Built-in admin panel**: service list, stats charts, remote start/stop, multi-server panel federation — filtering/sorting/pagination stays smooth at 10k scale

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

## Benchmarks

Reproduce with the scripts in `packages/gateway-rs/test/`:

| Scenario | Command | Result |
|---|---|---|
| 10k forwarding throughput | `bun test/bench-10k.ts --services 10000 --concurrency 20` | 14,638 req/s, p99 7.2ms, admin API 2.6KB gzipped |
| 10k real start/stop churn | `bun test/bench-churn-10k.ts --services 10000 --users 100` | 31k requests @ 99.97% success in 120s, 6,500+ real cold starts (p50 1.3s), peak concurrency 6.4%, no leak |

> The 10k claim assumes a low-frequency, long-tail traffic distribution (Zipf); instantaneous 10k cold starts queue behind the startup concurrency cap (by design). Benchmark environment: Linux x86_64 / WSL2, single machine.

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
