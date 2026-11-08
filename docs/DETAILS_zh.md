<!-- 本文档为详细技术文档，README 只保留「解决什么问题 / 怎么用 / 鸣谢 / 社群」，细节都在这里 -->

# DynaPM

> ⚠️ **当前主实现为 Rust 版 [`packages/gateway-rs`](./packages/gateway-rs)**（单文件原生二进制）。原 Bun/TS 版（packages/gateway）已废弃，仅保留 [README 墓碑](./packages/gateway/README.md)；本文档部分章节描述的是旧版行为。

[English Documentation](./README.md)

> **动态进程管理器** - 具有类 serverless 特性的轻量级通用服务管理系统

[![npm version](https://badge.fury.io/js/dynapm.svg)](https://www.npmjs.com/package/dynapm) ![Tests](https://img.shields.io/badge/tests-81%2F81%20passing-green) ![Performance](https://img.shields.io/badge/overhead-25ms-brightgreen)

DynaPM 是**复杂容器编排平台（如 Knative、Sablier）的轻量级替代方案**，专为私有化部署设计。它通过按需启动和闲置自动停止的方式，帮助你在资源受限的服务器上管理数百个低频访问的服务。


> 🤖 **AI 时代的最佳拍档**：DynaPM 是 [MCP Server](#-ai-agent-时代的新场景mcp-server-按需启动) 弹性托管的理想底座——AI Agent 的工具服务天然是「低频 + 按需」的，详见文末[专章](#-ai-agent-时代的新场景mcp-server-按需启动)。

---

## 🎯 为什么选择 DynaPM？

### 你面临的问题

你可能有很多副业项目或内部工具，它们：
- 🐌 **访问频率低**，但需要随时可用
- 💸 **即使闲置也会消耗**宝贵的内存和 CPU
- 😓 **不值得引入** Kubernetes/serverless 平台的复杂性
- 🤔 **使用不同的管理方式**（PM2、Docker、systemd 等）

### 💡 DynaPM 的解决方案

**作为一个智能网关**，DynaPM 会：
1. **拦截**发往你服务的请求
2. 如果服务离线，**自动启动**（**仅 25ms 开销** ⚡）
3. **流式代理**请求（延迟仅 **1-2ms** 🚀）
4. 服务闲置后**自动停止**释放资源

> 💡 **性能说明**：25ms 是 DynaPM 的开销（启动命令 8ms + 端口等待 17ms），总冷启动时间还包括服务本身启动时间（如 Node.js 应用约 475ms，总计约 500ms）

### 🏆 与其他方案对比

| 特性 | DynaPM | Sablier | traefik-lazyload | Knative |
|------|--------|---------|------------------|---------|
| **技术栈** | **Bun** (Bun.serve) | Go | Go | Go + K8s |
| **适用范围** | ⭐ **通用**（任意进程） | 仅 Docker | 仅 Docker | 仅 K8s |
| **部署复杂度** | ⭐ **简单** | ⭐⭐⭐ 中等 | ⭐⭐⭐ 中等 | ⭐⭐⭐⭐⭐ 复杂 |
| **基础设施** | 单台服务器 | Docker/K8s | Docker + Traefik | K8s 集群 |
| **冷启动** | ⚡ **~25ms** 开销 | 需要启动容器 | 需要启动容器 | 2-4 秒 ([来源](https://groups.google.com/g/knative-users/c/vqkP95ibq60)) |
| **代理延迟** | 🚀 **1-2ms** | 通过反向代理 | 通过反向代理 | 通过 Activator/Queue-proxy |
| **完美适用于** | **个人项目/小团队** | Docker 环境 | Docker + Traefic | 企业级 K8s |

---

## ✨ 核心特性

### ⚡ **极速冷启动**

```log
🚀 [myapp] GET / - 启动服务...
[myapp] 启动命令已执行
✅ [myapp] 服务就绪 (启动8ms, 等待17ms)
📤 [myapp] GET / - 200 - 30ms
```

- **DynaPM 开销**：仅 **25ms**（启动命令 8ms + 端口等待 17ms）
- **失败立即重试**：无延迟轮询，端口可用即刻转发
- **总冷启动**：~185ms（包括服务本身启动时间，如 Node.js 应用 ~160ms）

### 🚀 **流式代理**

服务运行时，代理延迟仅 **1-2ms**：

```log
📤 [myapp] GET / - 200 - 1ms
📤 [myapp] POST /api/data - 200 - 2ms
```

使用 **Bun.serve** 实现真正的流式转发，零缓冲，吞吐最大化！

### 🌐 **SSE 和 WebSocket 支持**

DynaPM 原生支持现代实时通信协议：

**Server-Sent Events (SSE):**
```log
✅ [sse-server] 服务就绪 (启动: 3ms, 等待: 429ms)
📤 [sse-server] GET /events - 200 - 5.45s
```

**WebSocket:**
```log
✅ [ws-server] 后端 WebSocket 连接已建立
📨 [ws-server] 转发消息到后端: 30 字节
🔌 [ws-server] 客户端 WebSocket 连接关闭
```

**智能连接追踪**防止长连接被意外关闭：
- 活跃的 SSE/WebSocket 连接会增加连接计数
- 只有当 `activeConnections === 0` 且超时才会停止服务
- 不再出现活跃会话期间服务被关闭的问题

### 🎛️ **通用服务管理**

通过 bash 命令配置**任意**服务 - 没有限制：

```typescript
// PM2 管理的服务
{
  commands: {
    start: 'pm2 start app.js --name myapp',
    stop: 'pm2 stop myapp',
    check: 'pm2 status | grep myapp | grep online',
  }
}

// Docker 容器
{
  commands: {
    start: 'docker run -d -p 3000:3000 myimage',
    stop: 'docker stop mycontainer',
    check: 'docker inspect -f {{.State.Running}} mycontainer',
  }
}

// systemd 服务
{
  commands: {
    start: 'systemctl start myservice',
    stop: 'systemctl stop myservice',
    check: 'systemctl is-active myservice',
  }
}

// 直接启动的进程
{
  commands: {
    start: 'nohup node app.js > logs/app.log 2>&1 &',
    stop: 'lsof -ti:3000 | xargs -r kill -9',
    check: 'lsof -ti:3000 >/dev/null 2>&1',
  }
}
```

### 🔄 **闲置自动回收**

- 服务闲置 X 分钟后自动停止
- 每个服务可配置独立的超时时间
- 为活跃服务释放内存和 CPU
- 定时检查间隔：3 秒

### �️ **多面板联邦（聚合管理）**

管理面板支持接入其他 DynaPM 网关，在一个面板里统一查看/启停/编辑所有服务器的服务：

- **配置式接入**：面板内「面板管理」对话框填对方的地址 + 管理令牌即可，存浏览器 localStorage，无需中心化组件
- **能力完整**：远程服务列表、统计图表、服务详情、启动/停止/彻底关停、原地编辑远程配置，与本地面板体验一致
- **安全模型**：跨域走 `adminApi.corsOrigins` Origin 白名单（精确匹配，**默认为空 = 禁止一切跨域**），鉴权仍由 `adminApi.authToken` 把关；被接入方显式信任面板来源后才能读

```jsonc
// 被接入方网关配置（允许哪些面板 Origin 跨域访问管理 API）
{
  "adminApi": {
    "authToken": "<令牌>",
    "host": "dynapm.example.com",
    "corsOrigins": ["http://dynapm.localhost", "https://panel.other.com"]
  }
}
```

### �📊 **高性能指标**

```
测试环境：Node.js HTTP 服务器 (autocannon 压测)

✅ 冷启动时间：   ~185ms (DynaPM: 25ms + 服务启动: 160ms)
✅ 流式代理延迟：  平均 10.3ms (范围: 9-12ms)
✅ 吞吐量：       5,942 req/s (多服务, 150 并发)
✅ 压测延迟：     高并发下保持低延迟
✅ 内存开销：     ~50MB (Bun 运行时)
✅ 代码体积：     21.7KB (压缩后)
✅ 日志系统：     结构化 JSON 日志 (内置日志)
```

---

## 🚀 快速开始

### 安装

```bash
# 全局安装（需 Bun >= 1.4 运行时）
npm install -g dynapm

# 或使用 pnpm
pnpm install -g dynapm
```

### 配置

在项目目录创建 `dynapm.config.ts` 文件：

```typescript
import type { DynaPMConfig } from 'dynapm';

const config: DynaPMConfig = {
  port: 3000,
  host: '127.0.0.1',

  // 日志配置（可选，生产环境建议关闭以提升性能）
  logging: {
    enableRequestLog: false,      // 是否启用请求日志（高频，影响性能）
    enableWebSocketLog: false,    // 是否启用 WebSocket 生命周期日志
    // 错误日志始终启用，不受此开关控制
  },

  services: {
    'app.example.com': {
      name: 'my-app',
      base: 'http://127.0.0.1:3001',
      idleTimeout: 5 * 60 * 1000, // 5分钟无访问后自动停止
      startTimeout: 10 * 1000,    // 启动超时时间

      commands: {
        start: 'nohup node /path/to/app.js > logs/app.log 2>&1 &',
        stop: 'lsof -ti:3001 | xargs -r kill -9',
        check: 'lsof -ti:3001 >/dev/null 2>&1',
      },

      healthCheck: {
        type: 'tcp', // TCP 端口检查（默认，无需服务修改代码）
      },
    },
  },
};

export default config;
```

### 使用

```bash
# 启动 DynaPM 网关
dynapm

# 或使用 npx
npx dynapm
```

现在访问 `http://app.example.com:3000` - 服务会自动启动！

---

## 🧪 运行测试

DynaPM 包含完整的自动化测试套件，覆盖所有核心功能。

### 快速测试

```bash
# 克隆项目
git clone https://github.com/2234839/DynaPM.git
cd DynaPM

# 安装依赖
pnpm install

# 运行完整测试套件
pnpm test
```

### 测试覆盖场景

自动化测试会验证以下 81 个测试用例（6 个测试套件）：

1. ✅ **按需启动** - 服务离线时自动启动
2. ✅ **热启动** - 服务运行时直接代理，无需重新启动
3. ✅ **自动停止** - 闲置超时后自动停止服务
4. ✅ **404 错误处理** - 未配置的服务返回 404
5. ✅ **多服务并发** - 同时管理多个服务
6. ✅ **不同健康检查** - TCP 和 HTTP 检查方式
7. ✅ **路径代理** - 不同路径正确代理到后端
8. ✅ **闲置时间保护** - 连续请求更新闲置时间
9. ✅ **POST 请求** - POST 方法支持
10. ✅ **SSE 流式传输** - Server-Sent Events 代理支持
11. ✅ **WebSocket** - WebSocket 双向通信支持
12. ✅ **长连接代理** - 活跃连接阻止服务被提前关闭
13. ✅ **并发启动** - 多个请求同时到达离线服务
14. ✅ **安全加固** - 请求体大小限制、CRLF 注入防护
15. ✅ **端口路由** - 端口直连代理和按需启动

### 测试输出示例

```
============================================================
测试结果汇总
============================================================
✓ 测试1: 按需启动 (773ms)
✓ 测试2: 热启动（服务已运行） (11ms)
✓ 测试3: 自动停止 (18025ms)
✓ 测试4: 404 错误处理 (11ms)
✓ 测试5: 多服务并发启动 (843ms)
✓ 测试6: 不同健康检查方式 (20ms)
✓ 测试7: 路径代理 (10ms)
✓ 测试8: 连续请求更新闲置时间 (14112ms)
✓ 测试9: POST 请求 (12ms)
✓ 测试10: SSE 流式传输 (3963ms)
✓ 测试11: WebSocket (1098ms)
✓ 测试12: 长连接代理 (10110ms)

------------------------------------------------------------
总计: 12 个测试
通过: 12 个 ✓
失败: 0 个
🎉 所有测试通过！
```

### 性能验证

测试会输出详细的性能日志：

```log
🚀 [app1] GET / - 启动服务...
[app1] 启动命令已执行
✅ [app1] 服务就绪 (启动8ms, 等待17ms)
📤 [app1] GET / - 200 - 30ms

# 后续请求（服务已运行）
📤 [app1] GET / - 200 - 1ms
📤 [app1] POST /api/data - 200 - 2ms
```

---

## 📊 性能测试

DynaPM 包含自动化性能测试脚本，可验证系统性能指标。

### 运行性能测试

```bash
# 克隆项目
git clone https://github.com/2234839/DynaPM.git
cd DynaPM

# 安装依赖
pnpm install

# 构建项目
pnpm build

# 运行性能测试
pnpm benchmark
```

### 性能测试输出示例

```
🚀 DynaPM 性能测试

============================================================
冷启动性能测试
============================================================
✓ 冷启动成功，总耗时: 42ms
  DynaPM 开销: ~25ms (启动命令 + 端口等待)
  服务启动时间: ~17ms (Node.js 应用)

============================================================
流式代理延迟测试
============================================================
✓ 流式代理延迟测试完成 (10 次请求)
  平均延迟: 9.3ms
  最小延迟: 8ms
  最大延迟: 12ms
  延迟范围: 8ms - 12ms

============================================================
吞吐量测试 (autocannon)
============================================================
ℹ 运行 5 秒压测 (50 并发)...
  请求数/秒: 4,225 req/s
  平均延迟: 23.16ms
  总请求数: 42k (耗时 10s)
```

### 测试要求

- **Bun** (>= 1.4)：运行 DynaPM 网关与测试
- **curl**: 测试基本功能
- **autocannon** (可选): 运行吞吐量压测

安装 autocannon:
```bash
npm install -g autocannon
```

---

## 📖 配置示例

查看 [dynapm.config.example.ts](./dynapm.config.example.ts) 获取完整示例，包括：
- PM2 管理的 Node.js 应用
- Docker 容器
- systemd 服务
- 直接进程管理
- 环境变量配置
- 自定义健康检查（HTTP/TCP/命令）

---

## 🏗️ 架构设计

```
┌─────────────────────────────────────────────────┐
│              用户请求                             │
│   http://app.example.com:3000/api/data          │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│      DynaPM 网关 (Bun.serve)                     │
│  - 检查服务状态（内存缓存）                       │
│  - 需要时执行启动命令（8ms）                      │
│  - 快速轮询 TCP 端口（17ms，无延迟重试）          │
│  - 流式代理请求（1-2ms）                         │
│  - 结构化日志记录（内置日志，异步）                   │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│              你的服务                             │
│  - PM2、Docker、systemd 或任意进程               │
│  - 闲置时自动停止                                 │
└─────────────────────────────────────────────────┘
```

### 核心优化

1. **内存状态缓存** - 不每次执行 bash 命令检查
2. **快速 TCP 端口检查** - 100ms 超时，失败立即重试
3. **流式转发替代等待** - 端口可用后立即转发，不等其他检查
4. **启动时间分解** - 清晰显示启动命令时间和端口等待时间

---

## 📊 性能基准测试

所有性能数据通过 `pnpm benchmark` 脚本实测获得。

### 冷启动性能

```
测试：服务从离线到首次可访问

结果：
├─ DynaPM 开销：   25ms (启动命令 8ms + TCP 端口等待 17ms)
├─ 服务启动时间：   160ms (Node.js 应用)
└─ 总冷启动时间：   185ms
```

### 流式代理性能

```
测试：服务运行时的单次请求延迟

结果：
├─ 平均延迟：      10.3ms
├─ 最小延迟：      9ms
├─ 最大延迟：      12ms
└─ 延迟范围：      9-12ms
```

### 吞吐量性能

```
测试：多服务混合压测 (3 服务 × 50 并发, 5 秒)

结果：
├─ 请求数/秒：     5,942 req/s
├─ 平均延迟：      ~10ms
├─ 总请求数：      29,710 requests
└─ 测试时长：      5 秒
```

### 资源占用

```
运行时资源占用：

├─ 内存：          ~50MB (Node.js 运行时)
├─ CPU：           闲置时 <1%
├─ 磁盘：          12KB (代码体积)
└─ 网络：          仅代理流量，无额外开销
```

---

## 🎨 适用场景

- **👨‍💻 个人项目**：保持数十个副业项目随时待命，不占用内存
- **🛠️ 内部工具**：按需访问开发/测试环境
- **🔧 微服务**：小规模部署的 Kubernetes 轻量级替代方案
- **🤖 AI Agent / MCP Server 托管**：让上百个工具服务随 Agent 的调用弹性启停（见下文专章）
- **💰 资源优化**：通过停止闲置服务最大化服务器利用率
- **📦 节省成本**：在更小的 VPS 实例上运行更多服务
- **🎓 学习实验**：轻松管理多个测试项目

---

## 🤖 AI Agent 时代的新场景：MCP Server 按需启动

[MCP（Model Context Protocol）](https://modelcontextprotocol.io) 已经成为 AI Agent 连接工具与数据源的事实标准。一个中度使用的 AI 工作流背后，往往挂着**几十个 MCP Server**——文件系统、数据库查询、浏览器自动化、GitHub、各类 API 封装……

### 这恰好是 DynaPM 的甜蜜点

MCP Server 的负载特征与「副业项目」惊人地一致，甚至更极端：

| 特征 | MCP Server | 传统低频服务 |
|---|---|---|
| 访问模式 | **只在 Agent 调用工具的瞬间活跃** | 低频但有规律 |
| 闲置比例 | **>99%**（一次对话可能只调用几次工具） | 90%+ |
| 单实例成本 | Node/Python 进程，50-200MB | 50-200MB |
| 数量 | 每个工作流/Agent 一套，**极易上百** | 数十 |
| 长连接 | SSE / Streamable HTTP（原生支持 ✅） | 部分 |

挂 50 个 MCP Server ≈ **5-10GB 内存常驻浪费**，其中绝大部分在两次工具调用之间完全空闲。而它们 99% 的空闲时间里，你只需要一个端口占位符。

### 用 DynaPM 托管 MCP Server

```typescript
services: {
  // 每个用户/工作流一个 MCP Server 实例，按需弹性伸缩
  'mcp-user-a.example.com': {
    name: 'mcp-filesystem-a',
    base: 'http://127.0.0.1:9101',
    idleTimeout: 60 * 1000,        // Agent 工具调用间隔通常很短，1 分钟即可回收
    keepWarm: true,                // 高频使用的核心工具保持热备（独立 30s 预热阈值）
    commands: {
      start: 'nohup npx -y @modelcontextprotocol/server-filesystem /data/user-a --port 9101 > logs/mcp-a.log 2>&1 &',
      stop: 'lsof -ti:9101 | xargs -r kill -9',
      check: 'lsof -ti:9101 >/dev/null 2>&1',
    },
  },
}
```

**实际效果**：

```
🤖 Agent: "帮我看下这个目录里有什么"
   → MCP 调用到达网关 → 服务离线 → 自动启动（~25ms 网关开销）
   → Streamable HTTP/SSE 流式代理，工具结果流回 Agent
   → 对话结束，60s 后服务自动停止，内存归还
   → 下次调用再冷启，或 keepWarm 热备直取
```

- 💰 **内存从 5-10GB 常驻 → 按需几十 MB 峰值**，一台小 VPS 承载上百个 MCP Server
- 🌐 **原生 SSE / Streamable HTTP 长连接支持**，智能连接追踪保证活跃会话期间不被误回收
- 🎛️ **多租户天然成型**：`mcp-user-a` / `mcp-user-b` 各自独立实例、独立回收策略、互不干扰
- ⚡ 对延迟不敏感的 Agent 场景，冷启动的 ~200ms 完全无感——**Agent 等待 LLM 推理的秒级延迟面前，这点开销可忽略**

> 💡 **思路延伸**：MCP 只是一个例子。任何「由 AI 按需触发、调用稀疏、实例轻量」的服务（Agent 的浏览器实例、临时计算 worker、Per-user 沙箱 API）都适用同一模型——DynaPM 让「为每个 AI 任务动态准备一套工具」的成本趋近于零。

---

## 🔧 开发路线图

- [ ] 🎛️ **Web 仪表板** - 服务监控和管理界面
- [ ] 📈 **Prometheus 集成** - 指标收集和可视化
- [ ] 📋 **服务模板** - 一键 PM2/Docker 配置生成
- [ ] 🔄 **多实例支持** - 分布式锁和状态同步
- [ ] 🔌 **插件系统** - 自定义集成和扩展
- [ ] 🌐 **更多健康检查** - gRPC、Redis 等
- [x] ⚡ **Bun 迁移** - 已完成（单运行时，bun --compile 单文件二进制）
- [x] 📊 **结构化日志** - 已完成（内置日志 异步日志）

---

## 📦 发布新版本

DynaPM 使用 GitHub Actions 自动发布到 npm，无需手动配置令牌或双因素认证。

### 发布流程

项目采用 **npm OIDC (OpenID Connect) 可信发布**，通过 Git 标签自动触发发布：

```bash
# 方式一：patch 版本（修复 bug）
npm version patch
git push origin main --tags

# 方式二：minor 版本（新功能）
npm version minor
git push origin main --tags

# 方式三：major 版本（破坏性变更）
npm version major
git push origin main --tags
```

### 自动化发布流程

推送标签后，GitHub Actions 会自动执行：

1. ✅ **构建项目** - 使用 rslib 编译 TypeScript
2. ✅ **验证打包** - 检查输出文件完整性
3. ✅ **发布到 npm** - 使用 OIDC 无需令牌
4. ✅ **创建 Release** - 在 GitHub 生成发布说明

### 查看发布状态

- **GitHub Actions**: https://github.com/2234839/DynaPM/actions
- **npm 包页面**: https://www.npmjs.com/package/dynapm

### 验证发布

```bash
# 查看最新版本
npm view dynapm version

# 查看版本历史
npm view dynapm versions --json

# 安装测试
npm install -g dynapm@latest
```

### 发布配置说明

项目使用 **npm Trusted Publishing**（可信发布）：
- ✅ 无需 NPM_TOKEN 环境变量
- ✅ 无需双因素认证（2FA）
- ✅ 通过 GitHub Actions OIDC 自动验证
- ✅ 更安全（短期令牌，自动过期）

详细配置说明：[docs/NPM_OIDC_SETUP.md](./docs/NPM_OIDC_SETUP.md)

### 版本号规范

遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- **1.0.4** → **1.0.5** (`patch`): Bug 修复
- **1.0.4** → **1.1.0** (`minor`): 新功能，向后兼容
- **1.0.4** → **2.0.0** (`major`): 破坏性变更

---

## 🤝 贡献

欢迎贡献！随时提交 issue 或 pull request。

开发流程：
1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

---

## 📄 许可证

ISC

---

## 🙏 致谢

基于优秀的开源工具构建：
- [Bun](https://bun.sh/) - 一体化 JavaScript 运行时与工具链（Bun.serve、bun --compile 单文件二进制）
- [c12](https://github.com/unjs/c12) - 配置加载器

---

## 📮 支持

[![扫码加入微信群](https://streamhold.heartstack.space/svg/tsfullstack/group/gs.svg?from=dynapm)](https://tsfullstack.heartstack.space/group/gs?from=dynapm)

- 🐛 **Bug 报告**：[GitHub Issues](https://github.com/2234839/DynaPM/issues)
- 💡 **功能建议**：[GitHub Discussions](https://github.com/2234839/DynaPM/discussions)
- 👤 **作者**：崮生

---

**⚡ 用 ❤️ 为资源意识强的开发者打造**
