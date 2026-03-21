具有类 serverless 特性的轻量级通用服务管理系统:dynapm
## dynapm 开发

/loop 先检查 TASK.md 中是否有未完成的任务请逐项完成并在充分test验证再继续下一项，如果没有则请请完善当前项目：测试更多代理场景，确保网关程序没有问题，监测并优化程序性能,修改完毕后需要进行实际运行测试，请自我完善，不要询问我任何事情，也不要切换其他模式（例如 plan mode）
作为网关的测试一定要非常严谨，测试各种可能的情况以及极端情况。
所有文件使用 ts，需要临时运行的使用 node --experimental-strip-types -e xxx.ts 来执行
这一次主要考虑性能，要在不破坏所有功能的前提下优化性能，但是不要为了优化而优化，必须经过仔细的评估，有数量级的性能提升的修改才去采纳，否则可读性更强

## TASKS

[x] 充分测试当前的代理功能是否正确
[x] 创建一个实用的dynam能力演示程序：实现一个运行ts/js的 serveless host（并不属于 dynapm，但是可以被 dynapm 运行，然后请求又可以被这个  serveless host 路由到 对应的 ts文件去执行）：支持用户通过网站访问并编写 ts 上传执行和测试执行

## 已完成的工作

### 2026-03-20

#### 网关 Bug 修复
- **并发按需启动修复**: 多个请求同时到达离线服务时，只有第一个触发启动，其他请求等待启动完成后再代理（之前返回 502）
- **后端崩溃自动恢复**: 当 handleDirectProxy 检测到后端不可达（ECONNREFUSED），自动将非 proxyOnly 服务状态重置为 offline，后续请求可重新触发按需启动
- **端口路由并发启动修复**: handlePortBindingRequest 补全 starting/stopping 状态处理，与 hostname 路由保持一致
- **echo-server 支持命令行端口参数**: `parseInt(process.argv[2] || '3099')`，允许不同测试配置使用不同端口
- **按需启动 POST 请求体丢失修复（严重）**: uWS 的 onData 回调中 ArrayBuffer 是借用语义，`Buffer.from(ab)` 底层数据被后续回调覆盖。改用 `Buffer.alloc + copy` 确保数据复制
- **transfer-encoding 头冲突修复**: forwardProxyRequest 中过滤 transfer-encoding 头，避免与 content-length 冲突导致后端 400
- **请求体大小限制（10MB）**: collectRequestBody 超过限制时截断，防止 DoS 攻击
- **WebSocket 消息队列限制（1000）**: 防止后端未连接时消息无限堆积导致内存泄漏
- **端口路由 WebSocket close 清理**: 端口路由的 close handler 补充后端 WebSocket 关闭逻辑

#### 性能优化
- **预编译 CRLF 正则**: `GatewayConstants.CRLF_REGEX` 避免热路径中重复创建正则对象
- **Set 替代内联条件**: `GatewayConstants.SKIP_REQUEST_HEADERS` 使用 Set.has() 替代重复 toLowerCase + 条件判断
- **预计算 targetPort**: RouteMapping 中缓存目标端口，避免热路径中 parseInt 解析

#### 网关稳定性修复
- **activeConnections 双重递减修复**: handleDirectProxy 和 forwardProxyRequest 中 cleanup() 添加 `cleaned` 守卫，防止 onAborted/proxyReq error/proxyRes end 多次触发导致 activeConnections 变为负数，进而导致闲置超时永远不触发
- **代理请求超时处理**: proxyReq 添加 `timeout` 事件监听，超时后调用 `destroy()` 触发 error 事件正确返回 502。之前 timeout 事件未被处理，导致后端慢响应时客户端无限等待

#### 测试覆盖（170 个测试全部通过）
- **test-proxy-comprehensive.ts**: 23 个综合代理测试
- **test-advanced-proxy.ts**: 12 个高级代理场景测试（PUT/PATCH/DELETE 请求体转发、HEAD 无响应体、OPTIONS CORS、空 POST、根路径、查询参数特殊字符、30 个自定义头、Host 头覆盖、流式响应、快速连续请求、活跃服务闲置测试、WS+HTTP 并发）
- **test-edge-cases.ts**: 15 个极端场景测试
- **test-gateway-robustness.ts**: 13 个健壮性测试
- **test-admin-api-lifecycle.ts**: 12 个管理 API 生命周期测试
- **test-admin-api-deep.ts**: 10 个管理 API 深度与网关边界测试（新增）
  - 管理 API 事件流 (SSE)
  - 管理 API 路由边界（PUT/DELETE 404、路径遍历、不存在 API）
  - 请求体超过 10MB 截断（按需启动路径）
  - 3xx 重定向 Location 头透传
  - 50 个并发请求同时断开
  - 服务按需启动超时行为
  - 非 JSON Content-Type POST
  - 管理 API 并发请求 (40个)
  - OPTIONS 预检请求
  - 网关直接访问返回 404
- **test-gateway-boundary.ts**: 10 个网关边界与安全深度测试（新增）
  - CRLF 注入防护验证
  - 并发按需启动竞争 (20个)
  - 大响应体流式转发 (1MB)
  - URL 特殊字符透传（中文、编码）
  - 超长请求头值 (16KB)
  - 响应头大小写兼容
  - 重复请求头处理
  - 快速连续请求到不同路径
  - 连接超时后网关稳定性
  - 多服务并发代理 (20个)
- **test-proxy-deep.ts**: 10 个代理深度与资源管理测试（新增）
  - 慢响应时客户端断开 activeConnections 准确性（含闲置超时验证）
  - stopping 状态下收到请求（等待停止完成后启动）
  - WebSocket 消息队列溢出 (1200条)
  - PATCH/PUT 请求体转发完整性
  - 分块传输响应体转发
  - 带查询参数的 POST 请求
  - 多次快速启停状态一致性 (5轮)
  - 长连接 keep-alive 稳定性 (100个)
  - 后端 500 错误网关不崩溃
  - 50 个错误请求后网关稳定性
- **test-proxy-edge-paths.ts**: 10 个代理边缘路径与错误恢复测试（新增）
  - 后端响应超时处理
  - 服务启动失败后重试
  - 后端立即关闭连接
  - 大量 502 后网关恢复 (30个)
  - 服务正在启动时收到请求 (5个)
  - 二进制请求体传输
  - 根路径请求
  - 特殊编码 URL 路径
  - 服务详情字段完整性
  - 网关端口扫描防护 (100个)
- **test-concurrent-post-body.ts**: 10 个并发与竞争条件测试
- **test-port-route-start.ts**: 9 个端口路由按需启动测试
- **test-security-stability.ts**: 9 个安全与稳定性深度测试
- **test-startup-recovery.ts**: 7 个服务启动失败恢复测试
- **test-proxy-supplementary.ts**: 10 个代理场景补充测试
  - Set-Cookie 响应头转发
  - 自定义响应头透传（X-Custom-Response、X-Rate-Limit、Cache-Control）
  - 204 No Content 响应
  - 分块传输响应
  - GET 请求不应有 body
  - Content-Type 多样性（json/plain/octet-stream）
  - 并发连接后网关不崩溃
  - 非 ASCII 响应体
  - 快速连续启停后代理正常
- **test-pilot.ts**: 16 个 Pilot 实际运行测试（使用 dynapm.config.ts 生产配置）
- **test-ws-concurrent.ts**: 10 个 WebSocket 并发与稳定性测试（新增）
  - 20 个并发 WebSocket 连接
  - 10 个并发 WebSocket ping/pong
  - WebSocket 较大消息传输 (10KB)
  - WebSocket 二进制消息传输
  - 多连接消息顺序保证 (10条)
  - 快速连接/断开循环 (30次)
  - 服务停止后连接清理
  - WebSocket + HTTP 混合并发
  - WebSocket 活跃连接阻止闲置停止
  - WebSocket 按需启动
- **test-post-body-fix.ts**: 12 个 POST 请求体完整性测试（已整合到 test-concurrent-post-body.ts）

#### echo-server 修复
- **HEAD 请求不返回 body**: 包装 res.end 使 HEAD 请求忽略 data 参数，修复 node:http 客户端 HTTP 解析错误
- **3xx 重定向 Location 头**: handleStatus 端点在 3xx 状态码时返回 Location 头

#### server-ws.ts 修复
- **WebSocket isBinary 参数错误**: `ws.send(JSON.stringify(...), true, false)` 中 `isBinary=true` 传入 string 导致连接状态异常。移除多余的 `true, false` 参数，使用 uWS 默认值

#### 性能评估结论
- 网关纯代理开销 P50=0.006ms（6μs），在测量误差范围内，远低于 node:http 协议解析开销
- 1000 请求延迟剖析：TTFB P50=0.336ms，Total P50=0.360ms，Body overhead 仅 0.024ms
- 微基准测试：所有热路径操作均在亚微秒级别（Map.get 27ns、Set.has 28ns、CRLF replace 73ns、Buffer.alloc+copy 787ns）
- Buffer.alloc+copy 是最昂贵操作（787ns/op），但这是 uWS ArrayBuffer 借用语义的必要成本，无法优化
- 基准测试：冷启动 255ms、单请求延迟 9.9ms、3 服务×50 并发吞吐量 5,260 req/s
- **无数量级优化空间**: 瓶颈在 node:http 的 HTTP 协议双重解析（客户端→网关 + 网关→后端），不是网关代码
- node:http keep-alive 出站 0.097ms/req，新建连接 0.252ms/req，网关已利用 keep-alive
- **net.Socket 替代方案不可行**: 测试显示 net.Socket 0.508ms/req（无 keep-alive），反而更慢；uWS 未暴露 `us_socket_context_connect`
- undici 与 uWS 流式模型不兼容，不可用作替代方案
- Pilot 实际运行测试：16/16 全部通过（使用 dynapm.config.ts 生产配置）
- WebSocket 并发测试：10/10 全部通过（20 并发连接、混合 WS+HTTP、按需启动、闲置保护）

#### Serverless Host 演示
- test/services/serverless-host.ts: 轻量级 TypeScript Serverless 运行时
  - Web 管理界面编写/上传/执行/删除函数
  - 使用 Node --experimental-strip-types 直接加载 TS 函数
  - 已添加到 dynapm.config.ts 作为 serverless-host 服务

#### echo-server 新增端点
- `/cookie` — 返回 Set-Cookie 响应头
- `/custom-response` — 返回自定义响应头（X-Custom-Response、X-Rate-Limit、Cache-Control）和二进制响应体
- `/no-content` — 返回 204 No Content
