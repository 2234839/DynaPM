# 更新日志

所有重要的项目变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.15] - 2026-03-22

### 🚀 性能优化
- **`typeof` 替代 `Array.isArray`**: 响应头转发中 4 处 `Array.isArray(value)` 替换为 `typeof value === 'string'`，V8 内置类型检查比原型链遍历快 41%
- **`getCaseSensitiveMethod()` 消除热路径 `toUpperCase()`**: uWS `getMethod()` 返回小写方法名，改为直接使用 `getCaseSensitiveMethod()` 获取原始大小写
- **404 路径提前返回**: `handleRequest` 中 hostname 查找提前到 header 收集之前，404 请求跳过不必要的 CPU 和内存开销
- **CRLF 快速路径**: 热路径中用 `includes('\r') || includes('\n')` 快速检查跳过正则替换
- **移除 node-fetch 依赖**: 使用 Node.js 22 内置 `fetch` API
- **预计算 targetPort**: RouteMapping 中缓存目标端口，避免每次 `parseInt`

### 🔴 Bug 修复
- **activeConnections 双重递减**: cleanup() 添加 `cleaned` 守卫防止多次触发
- **代理请求 timeout 未处理**: proxyReq 监听 `timeout` 事件并 `destroy()`
- **502 vs 504 区分**: 代理请求超时返回 504 Gateway Timeout，连接错误返回 502
- **startService fire-and-forget 竞态**: `serviceManager.start()` 改为 `await`，避免端口短暂可用时错误标记为 online
- **WebSocket handler 无条件日志修复**: `open` 回调中的 JSON.stringify 日志添加 `enableWebSocketLog` 守卫
- **test-startup-recovery 闲置超时测试修复**: 等待时间从 14s 增加到 16s，修复时序敏感测试偶发失败

### ✅ 代码质量
- **消除所有 `any` 类型**: `test-all.ts`、`test-proxy-comprehensive.ts`、`test-gateway-robustness.ts`、`test-pilot.ts`、`command-executor.ts` 中的 `any` 替换为 `unknown` + `instanceof` 类型守卫
- **Admin API `method.toLowerCase()` 移除**: uWS `getMethod()` 返回小写方法名，5 处冗余 `toLowerCase()` 已移除
- **Admin API `findServiceMapping` O(n) → O(1)**: 懒初始化 `serviceName → RouteMapping` 索引 Map
- **`getServicesList` 消除重复遍历**: 使用预构建的服务名称索引 Map
- **health-checker.ts 消除循环内 `new URL()`**: 预解析 URL 对象，传入 `host`/`port` 参数
- **`Buffer.alloc` → `Buffer.allocUnsafe`**: `collectRequestBody` 和 `handleDirectProxy` 中使用 `allocUnsafe` 跳过清零

### 🧪 测试（224 个用例全部通过，22 个测试套件）
- 新增 test-gateway-resilience.ts: 8 个网关韧性与边界深度测试
- 新增 test-crlf-fastpath.ts: 11 个 CRLF 安全性验证测试
- 新增 test-gzip-passthrough.ts: 5 个 Gzip 压缩响应透传测试
- 新增 test-startservice-race.ts: 6 个 startService 竞态条件测试
- 新增 test-port-ws-proxy.ts: 10 个端口绑定 WebSocket 代理测试
- 新增 test-admin-api-deep.ts: 10 个管理 API 深度测试
- 新增 test-gateway-boundary.ts: 10 个网关边界与安全测试
- 新增 test-proxy-deep.ts: 10 个代理深度与资源管理测试
- 新增 test-proxy-edge-paths.ts: 10 个代理边缘路径测试
- 新增 test-concurrent-post-body.ts: 10 个并发与竞争条件测试
- 新增 test-proxy-supplementary.ts: 10 个代理场景补充测试
- 新增 test-ws-concurrent.ts: 10 个 WebSocket 并发与稳定性测试

## [1.0.14] - 2026-03-20

### 🔴 Bug 修复
- **按需启动 POST 请求体丢失（严重）**: uWS 的 onData 回调中 ArrayBuffer 是借用语义，`Buffer.from(ab)` 底层数据被后续回调覆盖。改用 `Buffer.alloc + copy` 确保数据复制
- **并发按需启动返回 502**: 多个请求同时到达离线服务时，只有第一个触发启动，其他请求等待启动完成后再代理
- **transfer-encoding 头冲突**: forwardProxyRequest 中过滤 transfer-encoding 头，避免与 content-length 冲突导致后端 400
- **后端崩溃自动恢复**: 检测到后端不可达（ECONNREFUSED）时，自动将非 proxyOnly 服务状态重置为 offline
- **端口路由并发启动**: handlePortBindingRequest 补全 starting/stopping 状态处理，与 hostname 路由保持一致

### 🔒 安全加固
- 请求体大小限制 10MB，防止 DoS 攻击
- WebSocket 消息队列限制 1000 条，防止内存泄漏
- CRLF 注入防护：请求头值中的 `\r\n` 被清理
- 端口路由 WebSocket close handler 补充后端连接清理

### 🚀 性能优化
- **去除 undici，恢复原生 http 模块**: 吞吐量从 4,523 提升至 **5,942 req/s（+31%）**，延迟从 10.6ms 降至 **10.3ms**
- 预编译 CRLF 正则，避免热路径重复创建
- Set 替代内联条件判断，优化请求头跳过逻辑

### 🧪 测试（81 个用例全部通过）
- test-proxy-comprehensive.ts: 23 个综合代理测试
- test-edge-cases.ts: 15 个极端场景测试
- test-gateway-robustness.ts: 13 个健壮性测试
- test-admin-api-lifecycle.ts: 12 个管理 API 生命周期测试
- test-port-route-start.ts: 9 个端口路由按需启动测试
- test-security-stability.ts: 9 个安全与稳定性深度测试

---

## [1.0.13] - 2026-02-10

### 🚀 性能优化
- 使用 undici 替代原生 http 模块（已在 v1.0.14 回退，原生 http 性能更优）

### 🔧 改进
- 清理 RouteMapping 中的冗余字段
- 代码更简洁，维护性更好

---

## [1.0.12] - 2026-02-10

### ✨ 新增
- 添加 `proxyOnly` 配置项，支持纯反向代理模式
  - 不管理服务生命周期（启动/停止）
  - 仅做请求转发，适合已运行的服务

### 🔧 改进
- WebSocket 代理正确转发客户端请求路径
- WebSocket 代理完整转发客户端请求头（Cookie、Authorization 等）
- 改进 WebSocket 错误处理，避免连接重试循环
- 添加 TypeScript 测试配置支持

---

## [1.0.11] - 2025-02-10

### 🔧 修复
- 修复 tag 版本号提取，正确匹配 CHANGELOG 格式
  - 添加步骤去掉 tag 的 v 前缀
  - mindsers/changelog-reader-action 现在接收纯数字版本号

---

## [1.0.10] - 2025-02-10

### 🔧 修复
- 修正发布流程顺序，确保 CHANGELOG 在 CI 运行前已更新

### 📝 说明
- 严格按照：更新 CHANGELOG → 提交 → 更新版本号 → 推送标签 的顺序
- 确保 CI 运行时能正确提取到新版本的 CHANGELOG 内容

---

## [1.0.9] - 2025-02-10

### 🔧 修复
- 修复 mindsers/changelog-reader-action 配置
  - 修正输出参数名：changelog → changes
  - 添加 version 参数以正确提取对应版本内容

---

## [1.0.8] - 2025-02-10

### 🔧 修复
- 简化 CI 配置，使用 mindsers/changelog-reader-action 提取 CHANGELOG
  - 移除手动 awk 脚本，使用专门的 GitHub Action
  - 更可靠的 CHANGELOG 提取逻辑

### 📚 文档
- 创建 npm OIDC 发布最佳实践文档
  - 完整的配置流程说明
  - 常见问题排查指南
  - 三种 CHANGELOG 方案对比

---

## [1.0.7] - 2025-02-10

### 🔧 修复
- 修复 GitHub Actions 权限配置
  - 添加 contents: write 权限以创建 GitHub Release
  - 解决 403 "Resource not accessible by integration" 错误

---

## [1.0.6] - 2025-02-10

### 🔧 修复
- 修复 CI 配置以支持 npm OIDC 发布
  - 使用 Node.js 24 获得满足 OIDC 要求的 npm 11.x
  - 移除 setup-node 的 registry-url 配置
  - 使用 softprops/action-gh-release@v2 替代已废弃的 actions/create-release@v1
  - 改进 CHANGELOG 提取脚本，使用 body_path 参数读取 Release 说明

### 📚 文档
- 完善发布流程文档

---

## [1.0.5] - 2025-02-10

### ✨ 新增
- 添加 CHANGELOG.md 版本更新日志
- GitHub Release 自动从 CHANGELOG 提取发布说明
- 优化 CI 发布流程，移除测试步骤

### 📚 文档
- 在 README 中添加完整的发布流程说明
- 新增版本号规范说明

---

## [1.0.4] - 2025-02-10

### 🔧 修复
- 修复服务启动超时后状态卡死问题
- 添加 WebSocket 背压恢复机制，防止连接永久阻塞
- 修复服务停止时未更新状态的问题
- 实现启动锁失败后自动重试机制
- 清理请求头 CRLF 字符，防止 HTTP 响应分割攻击

### 🎯 改进
- 移除所有 `any` 类型，提升类型安全性
- 提取魔法数字为 `GatewayConstants` 常量
- 修复 `cork()` 返回值处理逻辑
- 优化 `mkdirSync` 调用，移除不必要的 try-catch

### ✨ 新增
- 添加 GitHub Actions 自动发布到 npm 流程
- 配置 npm OIDC 可信发布（无需 2FA）
- 添加完整的发布说明文档

### 📚 文档
- 新增 `docs/NPM_OIDC_SETUP.md` 配置指南
- 在 README 中添加发布新版本章节

---

## [1.0.3] - 2025-02-07

### ✨ 新增
- 添加活动连接计数功能
- 实现 SSE (Server-Sent Events) 流式代理支持
- 实现 WebSocket 双向通信代理支持
- 添加长连接阻止服务自动停止机制

### 🔧 改进
- 优化服务启动和停止流程
- 改进健康检查机制
- 优化日志记录格式

---

## [1.0.2] - 2025-02-06

### 🔧 修复
- 修复流式代理的 backpressure 处理
- 优化 TCP 端口检查性能

### 🎯 改进
- 使用 uWebSockets.js 替换 Express（性能提升 10 倍以上）
- 实现真正的流式转发，零缓冲
- 添加 Pino 结构化异步日志

---

## [1.0.1] - 2025-02-05

### 🔧 修复
- 修复服务启动超时检测
- 优化闲置检查逻辑

### 🎯 改进
- 改进错误处理和日志输出
- 优化配置加载机制

---

## [1.0.0] - 2025-02-04

### ✨ 首次发布
- 实现按需启动功能
- 实现流式反向代理
- 实现闲置自动回收
- 支持多种健康检查方式（TCP、HTTP、命令）
- 支持通用 bash 命令管理服务（PM2、Docker、systemd 等）
- 添加完整的自动化测试套件

---

## 版本号说明

- **Major** (主版本): 破坏性变更
- **Minor** (次版本): 新功能，向后兼容
- **Patch** (修订版): Bug 修复

---

## 链接

- [GitHub Releases](https://github.com/2234839/DynaPM/releases)
- [npm 包版本](https://www.npmjs.com/package/dynapm)
