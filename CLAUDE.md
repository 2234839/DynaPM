# DynaPM - Claude Code 项目配置

DynaPM 是一个智能网关(类似nginx)/进程管理工具(类似pm2)，通过按需启动(请求到达时通过查找配置判断请求属于哪个程序，然后网关转发请求，当程序还未启动会执行启动命令等待就绪后再实际转发)和闲置自动停止的方式，帮助用户在资源受限的服务器上运行成千上万个低频访问+少量高频访问的服务。

**核心特性：**
- ⚡ 极速冷启动
- 🚀 双向流式转发代理实现极低的请求延迟：将请求体流式给代理服务，将代理服务的响应流式给请求者 所以不需要缓冲请求或者响应，唯一的需要缓冲的时机就是请求到达网关，但是需要被网关唤起的程序还没有启动成功的时候
- 🌐 支持 SSE 和 WebSocket（任意路径 WS 升级嗅探接管）
- 🎛️ 基于bash的通用服务管理（可用于管理PM2、Docker、systemd 等任意服务）
- 🔄 闲置自动回收资源

## 技术栈

- **唯一实现**: Rust（packages/gateway-rs）：tokio + axum 0.8 + reqwest 0.12 + tokio-tungstenite，~4000 行，`cargo build --release` 产出单文件二进制 `target/release/dynapm`
- **管理面板**: packages/admin-ui（Vue3 + ECharts）
- **测试**: packages/gateway-rs/test/（Bun 1.4+ 原生 fetch/WebSocket），`bun test/run-all.ts` 串行 5 套件；跑前先 pkill 残留网关/backend 进程（WSL 残留进程占端口会 TCP 黑洞）

## 项目结构

```
DynaPM/
├── packages/
│   ├── admin-ui/              # Vue3 管理面板
│   ├── gateway-rs/            # 唯一网关实现（Rust）
│   │   ├── src/
│   │   │   ├── gateway.rs     # 核心网关（HTTP/WS 代理、按需启动、停滞超时）
│   │   │   ├── state.rs       # 服务状态机/启停
│   │   │   ├── health.rs      # 健康检查（TCP/HTTP/命令）
│   │   │   ├── executor.rs    # Bash 命令执行器
│   │   │   ├── admin.rs       # 管理 API + SSE
│   │   │   ├── config.rs      # 配置类型 + JSON loader
│   │   │   └── main.rs        # 主入口/路由
│   │   ├── test/              # 回归测试套件（5 套件）
│   │   └── dynapm.config.json # 配置示例
│   └── gateway/               # 已废弃的 Bun 版（仅 README 墓碑）
├── docs/
├── CHANGELOG.md
├── README.md / README_zh.md
```

## 开发指南

```bash
cd packages/gateway-rs
cargo build --release       # 产物 target/release/dynapm（注意不是 dynapm-rs，那是历史残留名）
bun test/run-all.ts         # 回归测试（先清残留进程）
```

### 发布新版本

待定：musl 静态二进制 + GitHub Release（旧 npm OIDC 流程已随 Bun 版废弃）。流程：CHANGELOG → commit → tag → push → CI 构建发布。