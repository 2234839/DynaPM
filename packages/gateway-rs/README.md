# DynaPM Gateway — Rust 实现（gateway-rs）

DynaPM 网关的 Rust 并行实现，与 Bun 版（`packages/gateway`）行为对齐，定位是**更高吞吐 / 更低 RSS / 单文件原生二进制**的第二实现。

## 与 Bun 版的对齐矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| hostname 路由 | ✅ | Host 头分发，404 响应结构一致 |
| 端口路由（HTTP） | ✅ | 每端口独立监听器，独立代理 |
| 端口路由（TCP 直通） | ✅ | `passthrough: true` 时整条连接 tokio 双向拷贝 |
| 按需启动状态机 | ✅ | offline/starting/online/stopping，每服务互斥锁串行化启动，冷启动退避 2ms→50ms×1.5 |
| 健康检查 | ✅ | tcp（100ms 超时）/ http / command / none |
| 闲置回收 | ✅ | 3s 扫描，keepWarm 独立 warmIdleTimeout 阈值 |
| HTTP 流式代理 | ✅ | 请求体/响应体全流式（reqwest + axum Body），无缓冲 |
| 请求体 10MB 限制 | ✅ | content-length 预检 413 + chunked 流式计数超限中断 413 |
| 代理超时 504 / 502 | ✅ | proxyTimeoutMs |
| 后端不可达重置 offline | ✅ | 与 Bun 版一致 |
| WebSocket 代理 | ✅ | tokio-tungstenite 双向消息桥 |
| Admin API | ✅ | `/_dynapm/api/services[...]` 路径与响应结构对齐 + SSE events |
| keep-alive 连接池 | ✅ | reqwest 内置池（pool_max_idle_per_host=32） |
| 配置格式 | ⚠️ | 字段与 TS 版一致，但为 **JSON**（`dynapm.config.json`），TS 配置需转换 |

## 已知差异 / 路线图

- **WS 升级入口**：Bun 版靠 socket 级升级嗅探（任意路径）；Rust 版需要客户端把 `Upgrade: websocket` 请求发到 `/_dynapm/ws-upgrade`（网关按 Host 路由桥接），或在 nginx 层重写。后续可引入 hyper service 手动处理 upgrade 以实现任意路径。
- **慢客户端停滞超时**：Bun 版有背压停滞检测；Rust 版依赖 tokio 流自然背压 + 系统层 socket 缓冲，暂无应用层停滞计时。
- **CRLF 防注入**：已实现（请求头值剥离 \r\n）。
- **`handlePortRequest` starting/stopping 等待语义**：已并入统一的 `route_request`。

## 踩坑记录

### docker 类后端必须用 http 健康检查

`docker start` 返回后，docker-proxy **立即**监听映射端口并 accept 客户端连接，但容器内应用（如 Next.js 需数秒）尚未就绪。此时：

- `tcp` 健康检查 connect 立即成功 → 网关 3ms 误判「服务就绪」→ 转发全部失败 502
- 502 触发「后端不可达重置 offline」→ 下个请求再探测 → docker-proxy 仍假就绪 → 循环 502 直到应用真正起来

**结论：凡是通过 docker 端口映射暴露的后端，healthCheck 必须用 `{"type": "http"}`**（探测 base URL 状态码），tcp 检查只适用于「监听端口的进程就是服务进程本身」的直启场景。

## 构建与运行

```bash
cd packages/gateway-rs
cargo build --release        # 产物：target/release/dynapm-rs

DYNAPM_CONFIG=./dynapm.config.json ./target/release/dynapm-rs
```

## 配置示例

见 `dynapm.config.json`。字段命名与 Bun 版 `dynapm.config.ts` 完全一致
（camelCase），`name` 缺省取 services key，`idleTimeout`/`startTimeout` 有默认兜底，
`host`/`port` 快捷字段会展开为 routes——loader 语义与 Bun 版 loader 对齐。

## 代码结构

```
src/
├── main.rs              # 入口：路由组装、监听、优雅退出
├── config.rs            # 配置类型 + JSON loader（字段对齐 types.ts）
├── state.rs             # ServiceRuntime / 状态机 / start/stop / 就绪等待
├── gateway.rs           # 核心网关：路由、流式代理、WS 桥、TCP 直通、闲置回收
├── admin.rs             # 管理 API（与 admin-api.ts 对齐）
├── health.rs            # tcp/http/command 健康检查
├── executor.rs          # bash 命令执行器（进程组 kill）
└── logger.rs            # JSON-line 日志
```
