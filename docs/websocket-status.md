# WebSocket 代理实现状态

## 当前成果

✅ **11/12 测试通过**
- 按需启动
- 热启动（服务已运行）
- 自动停止
- 404 错误处理
- 多服务并发启动
- TCP/HTTP 健康检查
- 路径代理
- 连续请求更新闲置时间
- POST 请求
- **SSE (Server-Sent Events) 连接** ✅
- **SSE 长连接代理** ✅

## WebSocket 代理现状

### 已实现
1. ✅ WebSocket 升级请求检测（通过 `Upgrade` 头识别）
2. ✅ 服务按需启动
3. ✅ 后端服务器正确响应 101 Switching Protocols
4. ✅ 101 响应特殊处理（不读取 body）
5. ✅ 响应头正确转发

### 当前问题
❌ **测试 11 失败**：WebSocket 连接测试

**症状**：
- curl 命令超时（~10 秒）
- `http.request()` 回调未被触发
- 网关日志显示服务启动成功，但没有后续代理日志
- 后端日志显示收到升级请求并成功处理

**根本原因**（推测）：
Node.js 的 `http.request()` 对 WebSocket 升级（101 Switching Protocols）有特殊处理：
1. 当收到 101 响应时，Node.js 会尝试将连接升级到 WebSocket
2. 但 uWebSockets.js 的 `HttpResponse` 对象在 HTTP 请求处理完成后可能无法处理升级后的连接
3. 需要底层的 TCP socket 双向转发，这超出了 HTTP 代理的范围

## 建议

考虑到：
1. SSE 流式代理已经工作正常
2. WebSocket 需要专门的客户端处理
3. uWS 不支持 WebSocket 客户端功能

**建议**：暂时接受当前限制，专注于优化 SSE 和标准 HTTP 代理。

## 测试结果

| 测试 | 状态 |
|------|------|
| 测试 1-10 | ✅ 全部通过 |
| 测试 11: WebSocket 连接 | ❌ 超时失败 |
| 测试 12: SSE 长连接 | ✅ 通过 |
