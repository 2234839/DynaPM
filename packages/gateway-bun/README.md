# DynaPM Gateway — Bun 实现

基于 **Bun 1.4+** 的 DynaPM 网关并行实现，与 `packages/gateway`（Node.js + uWebSockets.js）行为对齐。支持按需启动、双向流式转发、SSE/WebSocket、闲置自动回收。

## 运行

```bash
bun run src/index.ts        # DYNAPM_CONFIG=配置文件路径
```

## 测试

```bash
cd packages/gateway-bun
bun run test/test-correctness-fixes.ts   # 正确性（6 用例）
bun run test/test-timeout-paths.ts       # 超时路径
bun run test/test-ws-siyuan.ts           # WS 思源场景（9 用例）
bun run test/test-passthrough.ts         # TCP 透传
bun run test/test-upgrade-sniffer.ts     # 升级嗅探
bun run test/test-keepwarm.ts            # 保活
bun run test/bun-test-slow-client.ts     # 慢客户端
bun run test/bun-test-agent-cleanup.ts   # agent 清理 / NODELAY
```

测试前后自动清理端口；每个测试以退出码 0/1 表示绿/红。

## 与 Node 版的行为差异

以下差异均经 Bun 1.4.0 本地探针（20+ 个最小复现）实测确认，测试断言已按平台语义适配。

### 1. 慢客户端停滞超时：后端侧止损（最重要）

- **Node 版**：响应停滞超时触发时，用 `res.close()` **主动断开客户端 socket**，立即释放连接。
- **Bun 版**：`Bun.serve` 无 per-request 断开 API。实测 `server.timeout(req, 0/1)`、`server.closeIdleConnections()`、`controller.error()` 均不能断开**写缓冲有积压**的客户端连接（uWS 发送缓冲非空时 idle 计时不工作）。因此改为**后端侧止损**：abort 上游 fetch（`AbortController`），保证后端连接与读流资源被终止、`activeConnections` 归零、服务可正常闲置回收；客户端 socket 留待两层兜底：
  - serve 级 `idleTimeout: 10`（秒，4 处 Bun.serve 均已配置）在流静默且写缓冲 flush 后回收；
  - 客户端主动断开。

### 2. 请求体停滞（冷启动 POST）

- **Bun 版**：挂起的请求体读取（包装计数流）被 uWS 视为 I/O 活动，**完全阻止 idleTimeout 计时**。客户端声明 `Content-Length` 但不发 body 时，客户端 socket 无法被服务端断开；代理超时后只能等待后端止损 + 服务回收。
- **Node 版**：`collectRequestBody` 超时后可直接断开客户端。

### 3. TCP_NODELAY

- **Node 版**：TCP 透传路径显式 `socket.setNoDelay(true)`。
- **Bun 版**：`Bun.fetch` / `Bun.connect` 默认 NODELAY，无需显式设置。测试以「小包往返无 Nagle 延迟积压（中位 RTT < 40ms，实测 1–2ms）」等价断言。

### 4. 101 升级响应

- **Bun 版**：`Bun.fetch` 路径无法向客户端回 101（降级为空体 200 兜底）；WebSocket 一律走独立 upgrade 通道（`upgrade` handler + 嗅探）。
- **Node 版**：可在同端口透传 upgrade 响应。

### 5. 连接池

- **Node 版**：`http.Agent` 精细配置（keepAlive、maxSockets 等）。
- **Bun 版**：`Bun.fetch` 内置连接复用；网关维护登记/计数语义对齐层保证 `activeConnections` 统计一致。

### 6. 413 流式超限

- **Bun 版**：流式转发，超限触发时请求前缀字节可能已到达后端（响应面一致：413 状态与响应体不变）。
- **Node 版**：先缓冲到阈值再转发，超限时后端收不到字节。

### 7. 测试编写注意

`bun-test-agent-cleanup.ts` 类同进程监听端口的测试，finally 中必须先 `await gateway.cleanup()`（关闭本进程 `Bun.serve` 监听）再 `killPort()`，否则 lsof 找到测试进程自身的监听 fd，`kill -9` 自杀（exit 137）。
