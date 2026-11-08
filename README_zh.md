# DynaPM

[English](./README.md) · [详细技术文档](./docs/DETAILS_zh.md)

> **动态进程管理器** — 在一台小服务器上跑**上万**个低频服务，访问时自动拉起，闲置时自动回收。

![Tests](https://img.shields.io/badge/tests-5%2F5%20suites%20passing-green) ![Performance](https://img.shields.io/badge/overhead-25ms-brightgreen) ![Scale](https://img.shields.io/badge/benchmark-10k%20services%20%40%206.4%25%20concurrency-blue) ![Runtime](https://img.shields.io/badge/runtime-Rust%20%2B%20tokio-orange)

---

## 它解决什么问题

你有很多副业项目 / 内部工具 / MCP 服务，它们访问频率低，但得随时可用。每个都常驻运行会把小服务器内存吃光；上 Kubernetes 又太重。

DynaPM 是一个**智能网关**：请求到达时按域名/端口找到对应服务——没启动就自动拉起并转发；服务闲置一段时间后自动停止、释放资源。整个过程对访问者透明。

- ⚡ **冷启动开销仅 ~25ms**（不含服务自身启动时间），用户基本无感
- 🚀 **运行时代理延迟 1-2ms**，双向流式转发，SSE / WebSocket 开箱即用
- 📈 **万级实测**：10,000 个真实启停实例压测，成功率 99.97%，Zipf 访问分布下并发进程峰值仅 6.4%，网关内存 <700MB
- 🎛️ **通用**：用 bash 命令即可接入 PM2 / Docker / systemd / 任意裸进程，不锁定基础设施
- 🖥️ **自带管理面板**：服务列表、统计图表、远程启停、多服务器面板联邦，万级规模下筛选/排序/分页保持流畅

## 怎么用

### 1. 下载

从 [GitHub Releases](https://github.com/2234839/DynaPM/releases) 直接下载预编译二进制 —— 提供 Linux（x86_64 / aarch64，musl 静态链接，零依赖）与 macOS（x86_64 / aarch64）：

```bash
# 以 Linux x86_64 为例 —— 具体文件名带版本号，见 Releases 页
wget https://github.com/2234839/DynaPM/releases/download/<tag>/dynapm-<tag>-linux-x86_64.tar.gz
tar xzf dynapm-*-linux-x86_64.tar.gz && chmod +x dynapm
```

想从源码构建的话，在 `packages/gateway-rs` 里 `cargo build --release` 即可得到同样的单文件二进制。

### 2. 写一份配置

```jsonc
{
  "port": 3000,
  "services": {
    "app.example.com": {
      "base": "http://127.0.0.1:3001",
      "idleTimeout": 300000,          // 闲置 5 分钟自动停止
      "commands": {
        "start": "nohup node /path/to/app.js > logs/app.log 2>&1 &",
        "stop": "lsof -ti:3001 | xargs -r kill -9",
        "check": "lsof -ti:3001 >/dev/null 2>&1"
      }
    }
  }
}
```

### 3. 启动

```bash
DYNAPM_CONFIG=./dynapm.config.json ./dynapm
# 管理面板：http://127.0.0.1:3000/_dynapm/panel
```

现在访问 `http://app.example.com:3000`，服务会自动启动。更多配置项（健康检查、端口路由、keepWarm、超时调优等）见[详细文档](./docs/DETAILS_zh.md)与[配置示例](./packages/gateway-rs/dynapm.config.json)。

## 适用场景

- 👨‍💻 个人副业项目：几十个项目随时可访问，但几乎不占内存
- 🤖 AI Agent / MCP Server：天然「低频 + 按需」的工具服务弹性托管
- 🛠️ 内部工具：开发 / 测试环境按需访问
- 💰 小 VPS 成本优化：用最少的钱跑最多的服务

## 压测数据

复现命令在 `packages/gateway-rs/test/`：

| 场景 | 命令 | 结果 |
|---|---|---|
| 万级转发吞吐 | `bun test/bench-10k.ts --services 10000 --concurrency 20` | 14,638 req/s，p99 7.2ms，管理面板 API gzip 后 2.6KB |
| 万实例真实启停 | `bun test/bench-churn-10k.ts --services 10000 --users 100` | 120s 内 31k 请求成功率 99.97%，6,500+ 次真实冷启动 p50 1.3s，并发进程峰值 6.4%，无泄漏 |

> 万级成立的前提是「低频 + 长尾」访问分布（Zipf）；瞬时万级冷启动受启动并发上限保护会排队。单机压测环境：Linux x86_64 / WSL2。

## 鸣谢

DynaPM 构建在这些优秀的开源项目之上：

- [tokio](https://tokio.rs/) / [axum](https://github.com/tokio-rs/axum) — 异步运行时与 HTTP 框架
- [reqwest](https://github.com/seanmonstar/reqwest) / [tokio-tungstenite](https://github.com/snapview/tokio-tungstenite) — 上游 HTTP 与 WebSocket 客户端
- [Bun](https://bun.sh/) — 回归测试套件运行时
- [Vue 3](https://vuejs.org/) / [ECharts](https://echarts.apache.org/) — 管理面板

## 社群

[![扫码加入开发者社群](https://tsfullstack.heartstack.space/group/gs.svg?from=dynapm)](https://tsfullstack.heartstack.space/group/gs?from=dynapm)

- 🐛 Bug 反馈：[GitHub Issues](https://github.com/2234839/DynaPM/issues)
- 💡 功能建议：[GitHub Discussions](https://github.com/2234839/DynaPM/discussions)
- 👤 作者：崮生

---

**⚡ Made with ❤️ for resource-conscious developers**
