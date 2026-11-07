# DynaPM

[English](./README.md) · [详细技术文档](./docs/DETAILS_zh.md)

> **动态进程管理器** — 在一台小服务器上跑几百个低频服务，访问时自动拉起，闲置时自动回收。

![Tests](https://img.shields.io/badge/tests-5%2F5%20suites%20passing-green) ![Performance](https://img.shields.io/badge/overhead-25ms-brightgreen) ![Runtime](https://img.shields.io/badge/runtime-Rust%20%2B%20tokio-orange)

---

## 它解决什么问题

你有很多副业项目 / 内部工具 / MCP 服务，它们访问频率低，但得随时可用。每个都常驻运行会把小服务器内存吃光；上 Kubernetes 又太重。

DynaPM 是一个**智能网关**：请求到达时按域名/端口找到对应服务——没启动就自动拉起并转发；服务闲置一段时间后自动停止、释放资源。整个过程对访问者透明。

- ⚡ **冷启动开销仅 ~25ms**（不含服务自身启动时间），用户基本无感
- 🚀 **运行时代理延迟 1-2ms**，双向流式转发，SSE / WebSocket 开箱即用
- 🎛️ **通用**：用 bash 命令即可接入 PM2 / Docker / systemd / 任意裸进程，不锁定基础设施
- 🖥️ **自带管理面板**：服务列表、统计图表、远程启停、多服务器面板联邦

## 怎么用

### 1. 构建

```bash
git clone https://github.com/2234839/DynaPM.git
cd DynaPM/packages/gateway-rs
cargo build --release
# 产物：target/release/dynapm（单文件二进制，无运行时依赖）
```

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
