# DynaPM Gateway — Rust 实现（gateway-rs）

DynaPM 网关的 **唯一当前实现**（原 Bun/TS 版已废弃），单文件原生二进制，零运行时依赖。

## 能力清单

| 能力 | 状态 | 说明 |
|---|---|---|
| hostname 路由 | ✅ | Host 头分发，404 响应结构一致 |
| 端口路由（HTTP） | ✅ | 每端口独立监听器，独立代理 |
| 端口路由（TCP 直通） | ✅ | `passthrough: true` 时整条连接 tokio 双向拷贝 |
| 按需启动状态机 | ✅ | offline/starting/online/stopping，每服务互斥锁串行化启动，冷启动退避 2ms→50ms×1.5 |
| 健康检查 | ✅ | tcp（100ms 超时）/ http / command / none |
| 闲置回收 | ✅ | 3s 扫描，keepWarm 独立 warmIdleTimeout 阈值 |
| HTTP 流式代理 | ✅ | 请求体/响应体全流式（reqwest + axum Body），无缓冲 |
| 请求体 10MB 限制 | ✅ | content-length 预检 413 + chunked 流式计数超限中断 |
| 代理超时 504 / 502 | ✅ | proxyTimeoutMs 只覆盖「连接→响应头」；响应体时长由 stallTimeoutMs 管理（不会掐断 SSE/长流式响应） |
| 慢客户端停滞超时 | ✅ | stallTimeoutMs（默认 120s，0=禁用）：响应体/WS 消息两个方向一个 chunk 都不到即断连，防慢客户端占住上游连接 |
| 后端不可达重置 offline | ✅ | 无 body 请求自动重试冷启动 |
| WebSocket 代理 | ✅ | tokio-tungstenite 双向消息桥；**任意路径** Upgrade 嗅探接管（主监听 fallback 层 MaybeWs 提取器），`/_dynapm/ws-upgrade` 仅作兼容入口保留 |
| Admin API | ✅ | `/_dynapm/api/services[...]` + SSE events |
| keep-alive 连接池 | ✅ | reqwest 内置池（pool_max_idle_per_host=512） |
| CRLF 防注入 | ✅ | 请求头值剥离 \r\n |
| 配置格式 | ✅ | JSON（`dynapm.config.json`），字段命名与旧 TS 版一致（camelCase） |

## 已知差异 / 语义说明

- **流式超限语义**：chunked 请求体超过 10MB 时，若上游 200 响应头已返回，网关只能中断 body 传递（无法补发 413）；未收到响应头则回 413。
- **stopWaitMs 默认 30s**：未配置 stop 命令的服务闲置回收时，需等满 stopWaitMs 后 SIGKILL start 拉起的进程组兑底。

## 踩坑记录

### docker 类后端必须用 http 健康检查

`docker start` 返回后，docker-proxy **立即**监听映射端口并 accept 客户端连接，但容器内应用（如 Next.js 需数秒）尚未就绪。此时：

- `tcp` 健康检查 connect 立即成功 → 网关 3ms 误判「服务就绪」→ 转发全部失败 502
- 502 触发「后端不可达重置 offline」→ 下个请求再探测 → docker-proxy 仍假就绪 → 循环 502 直到应用真正起来

**结论：凡是通过 docker 端口映射暴露的后端，healthCheck 必须用 `{"type": "http"}`**（探测 base URL 状态码），tcp 检查只适用于「监听端口的进程就是服务进程本身」的直启场景。

## 构建与运行

```bash
cd packages/gateway-rs
cargo build --release        # 产物：target/release/dynapm

DYNAPM_CONFIG=./dynapm.config.json ./target/release/dynapm
```

## 回归测试

```bash
cd packages/gateway-rs
pkill -f 'release/dynapm'; pkill -f 'test/backend.ts'   # 清残留（WSL 下残留进程会导致端口黑洞）
bun test/run-all.ts        # 5 套件串行：core / coldstart / ws / limits / admin
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
