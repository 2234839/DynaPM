具有类 serverless 特性的轻量级通用服务管理系统:dynapm
## dynapm 开发

/loop 先检查 TASK.md 中是否有未完成的任务请逐项完成并在充分test验证再继续下一项，如果没有则请请完善当前项目：监测并优化程序性能,修改完毕后需要进行实际运行测试，请自我完善，不要询问我任何事情，也不要切换其他模式（例如 plan mode）
作为网关的测试一定要非常严谨，测试各种可能的情况以及极端情况。
所有文件使用 ts，需要临时运行的使用 node --experimental-strip-types -e xxx.ts 来执行
这一次主要考虑性能，要在不破坏所有功能的前提下优化性能，但是不要为了优化而优化，必须经过仔细的评估，不要无脑上缓存，缓存很容易出bug，否则可读性更强。然后咱们的网关可能已经到达了一般情况下的上限，所以你可能需要去互联网上查找node的一些大神使用的技巧

## TASKS

[x] 请在各个层面完善一下 serveless host 这个功能，尤其是前端，太low了，至少也得有 https://www.typescriptlang.org/play/ 这种水准的编辑和运行体验吧
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

#### 测试覆盖（224 个测试全部通过）
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
- **test-gateway-resilience.ts**: 8 个网关韧性与边界深度测试（新增）
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

#### 代码质量优化（第十三轮 2026-03-22）
- **`Array.isArray` → `typeof` 优化**: 网关响应头转发中 4 处 `Array.isArray(value) ? value.join(', ') : value` 替换为 `typeof value === 'string' ? value : value.join(', ')`。微基准验证 `typeof` 比 `Array.isArray` 快 41.2%（10ms vs 17ms，500 万次迭代），因为 `typeof` 是 V8 内置类型检查，无需遍历原型链
- **V8 微基准全面验证**: 系统性测试了 ProxyState 对象创建（1ns/op）、headers 迭代（for...in 最优，比 Object.keys 快 43.8%）、hostname 提取（substring vs slice 差异 0.1ns/req）、http.request options 创建（1.5ns/op）。结论：当前所有热路径写法已是 V8 最优
- **test-startup-recovery.ts 闲置超时等待修复**: 等待时间从 14s 增加到 16s（10s idleTimeout + 3s 检查间隔 + 3s 停止执行 buffer），修复时序敏感测试偶发失败
- **224 个测试全部通过**（22 个测试套件），基准测试 5,368 req/s（wrk -t4 -c50 -d10s），性能无退化

#### 代码质量优化（第十二轮 2026-03-22）
- **消除 `any` 类型**: 修复 `test-all.ts`、`test-proxy-comprehensive.ts`、`test-gateway-robustness.ts`、`test-pilot.ts`、`command-executor.ts` 中的 `any` 类型，替换为 `unknown` + `instanceof` 类型守卫或具体接口类型（`{ name?: string }`）
- **`for...in` vs `Object.keys()` 微基准验证**: 100 万次迭代测试显示 `Object.keys()` 比 `for...in` 慢 43.8%（391ms vs 272ms），确认当前 `for...in` 写法是最优选择，不做替换
- **互联网调研 Node.js 性能技巧**: 研究了 Node.js 22+ HTTP Agent 调优（`agentKeepAliveTimeoutBuffer`、`maxSockets`、`scheduling`）、DNS 缓存（`cacheable-lookup`）、V8 Maglev 编译器友好代码模式、`Buffer.allocUnsafeSlow` 等。结论：自定义 HTTP Agent 已在第五轮测试中验证（QPS 下降 14.6%），DNS 直连对 `127.0.0.1` 无意义（已是 IP），`for...in` 已是最优
- **224 个测试全部通过**（22 个测试套件），基准测试 5,193 req/s（wrk -t4 -c50 -d10s），性能无退化

#### 代码质量与性能优化（第十一轮 2026-03-22）
- **404 路径提前返回优化**: `handleRequest` 中将 `hostnameRoutes.get(hostname)` 检查提前到 `req.forEach` header 收集之前。对 404 请求（未知 hostname）跳过 header 遍历和 `Record<string, string>` 对象分配，减少不必要的 CPU 和内存开销
- **212 个测试全部通过**（21 个测试套件），基准测试 5,132 req/s（wrk -t4 -c50 -d10s），性能无退化

#### 代码质量与性能优化（第十轮 2026-03-22）
- **`getMethod()` → `getCaseSensitiveMethod()` 消除热路径 `toUpperCase()`**: uWS 的 `getMethod()` 返回小写方法名（如 `get`），传给 `http.request()` 前需要 `toUpperCase()` 转为大写。改为直接使用 `getCaseSensitiveMethod()` 获取原始大小写方法名（如 `GET`），消除 `handleRequest`、`handlePortBindingRequest` 入口处和 `handleDirectProxy`、`forwardProxyRequest` 中共 2 处 `toUpperCase()` 调用
- **test-crlf-fastpath.ts `rawTcpRequestBytes` EPIPE 修复**: 原实现在连接回调中同步写入所有 buffer 后才注册 error handler。当 uWS 拒绝畸形请求并关闭连接时，后续 `socket.write()` 触发 `EPIPE`。改为先注册 error handler，将 EPIPE 视为正常响应（服务端关闭连接），并在写入前检查 `socket.destroyed`
- **212 个测试全部通过**（21 个测试套件），基准测试 5,132 req/s（wrk -t4 -c50 -d10s），性能无退化

#### 代码质量与性能优化（第九轮 2026-03-22）
- **test-startup-recovery.ts `ensureEchoOffline` 测试 bug 修复**: 当服务已经是 offline 时，原代码发请求尝试重置状态，但反而触发了按需启动。改为先通过 admin API 查询服务状态，仅在 online/stopping 时才发请求触发 ECONNREFUSED 重置
- **移除未使用的 `getTargetHostPort` 辅助函数**: gateway.ts 中的 `getTargetHostPort` 已被内联为直接属性访问 `mapping.targetUrl!.hostname` 和 `mapping.targetPort`，删除未使用的函数定义
- **全量回归测试 212 个用例全部通过**（21 个测试套件顺序运行）
- **基准测试验证**: 5,347 req/s（wrk -t4 -c50 -d10s），微基准 P50 纯代理开销 0.286ms，与之前基准一致无退化
- **性能优化调研结论**: 经过互联网调研（uWS 最佳实践、Node.js 22+ 网络优化、V8 引擎优化）和代码审查，确认所有已知的 JS 层优化已实施，网关已到达 HTTP 协议双重解析的理论极限。剩余可能的优化（highWaterMark 调优、Buffer 预分配、V8 hidden classes 一致性）均为微优化，收益 < 1%

#### 代码质量与性能优化（第七轮 2026-03-22）
- **admin-api.ts `startService` fire-and-forget 竞态条件修复（正确性 bug）**: `serviceManager.start()` 原来是 fire-and-forget（不 await），如果启动命令失败但端口短暂可用，TCP 就绪循环会将状态错误地标记为 online。改为先 `await start()` 完成后再做 TCP 就绪检查
- **WebSocket handler 无条件 JSON.stringify 日志修复**: hostname 路由的 WebSocket `open` 回调中有一行 `JSON.stringify(backendHeaders, null, 2)` 日志没有 `enableWebSocketLog` 守卫，每次 WebSocket 连接都执行。改为仅在 `enableWebSocketLog` 开启时记录
- **CRLF 替换快速路径**: 热路径 `handleRequest` 和 `handlePortBindingRequest` 的 headers 收集中，先用 `value.includes('\r') || value.includes('\n')` 快速检查是否需要正则替换。正常请求（99.99%+）直接跳过 `replace()` 调用，节省 ~400-1800ns/req
- **fullUrl 拼接方式统一**: `handlePortBindingRequest` 中的模板字符串 `${url}?${queryString}` 改为字符串拼接 `url + '?' + queryString`，与 `handleRequest` 保持一致
- **移除 node-fetch 依赖**: `health-checker.ts` 中 `import fetch from 'node-fetch'` 改为使用 Node.js 22 内置的全局 `fetch` API。`pnpm remove node-fetch` 移除生产依赖，减小安装体积
- **212 个扩展测试全部通过**，基准测试 5,347 req/s（wrk -t4 -c50 -d10s），冷启动 201ms

#### 新增测试套件（第八轮 2026-03-22）
- **test-crlf-fastpath.ts**: 11 个 CRLF 安全性验证测试（新增）
  - 正常原始 TCP 请求（验证 chunked 响应解析正确性）
  - CRLF 快速路径正常请求不受影响
  - URL 路径特殊字符安全
  - uWS 层安全：裸 \n 被 uWS 拒绝 (400)
  - uWS 层安全：裸 \r 被 uWS 拒绝或忽略
  - uWS 层安全：\r\n+非法行被 uWS 拒绝 (400)
  - uWS 层安全：\r\n+合法头被 uWS 解析为独立头（标准 HTTP 行为）
  - uWS 层安全：\r\n+多个注入头解析
  - CRLF 不产生额外响应头（响应头注入防护）
  - 响应头注入防护
  - 20 个并发 CRLF 请求不崩溃
- **test-gzip-passthrough.ts**: 5 个 Gzip 压缩响应透传测试（新增）
  - gzip Content-Encoding 头透传（hostname 路由）
  - gzip 响应体可解压验证
  - 无 Accept-Encoding 时 gzip 透传
  - 多 Accept-Encoding 时 gzip 透传
  - 端口路由 gzip 响应透传
- **test-startservice-race.ts**: 6 个 startService 竞态条件修复验证测试（新增）
  - startService 正常启动
  - startService 后代理功能正常
  - starting 状态重复调用返回 400
  - online 状态调用返回 400
  - startCount 正确递增
  - 启动超时机制验证
- **test-port-ws-proxy.ts**: 10 个端口绑定 WebSocket 代理测试（新增）
  - 端口路由 WS 基本连接与消息收发
  - 端口路由 WS 二进制消息
  - 端口路由 WS 较大消息 (10KB)
  - 端口路由 WS 并发连接 (10个)
  - 端口路由 WS 快速连接/断开循环 (20次)
  - 端口路由 WS + HTTP 混合并发
  - 端口路由 WS 按需启动
  - 端口路由 WS 消息队列
  - 端口路由 WS 长连接稳定性 (5s)
  - 端口路由 WS 后端崩溃后连接清理

#### CRLF 安全架构分析结论
- **双层安全模型**: uWS HTTP 解析器（第一层）+ 网关 CRLF 清理（第二层）
- **uWS 解析器**: 裸 \n / \r 违反 HTTP 规范，uWS 直接返回 400 Bad Request
- **\r\n 行为**: uWS 将 \r\n 解析为 HTTP 头分隔符（标准行为），\r\n+合法头成为独立头，\r\n+非法行导致 400
- **网关 CRLF 清理**: 对 `req.forEach` 迭代的每个 header value 做防御性 `[\r\n]` 替换，保护通过程序化路径（如中间件）传入的脏数据
- **快速路径优化**: `value.includes('\r') || value.includes('\n')` 先检查，正常请求（99.99%+）跳过正则替换

#### 代码质量与性能优化（第六轮 2026-03-22）
- **admin-api.ts 删除重复的 `checkTcpPort` 函数**: 与 gateway.ts 中的实现功能完全相同，且每次调用都 `new URL()` 解析。改为在 `startService` 循环外预解析 URL，内联 TCP 检查逻辑
- **health-checker.ts 消除循环内 `new URL()` 冗余解析**: `wait` 方法在循环外预解析 `service.base` 为 `targetHost` 和 `targetPort`，传入 `checkTcp` 方法。`checkTcp` 签名改为直接接收 host/port 参数
- **admin-api.ts `method.toLowerCase()` 全部移除**: uWS `getMethod()` 返回小写方法名，5 处 `method.toLowerCase()` 是冗余操作。直接比较 `method === 'get'` / `method === 'post'`
- **168 个扩展测试全部通过**，基准测试 4,680 req/s（正常波动范围）

#### 代码质量与性能优化（第五轮 2026-03-22）
- **`Buffer.alloc` → `Buffer.allocUnsafe`**: `collectRequestBody` 和 `handleDirectProxy` 的 `onData` 回调中，`Buffer.alloc` 会先 memset 清零再被 `copy()` 覆盖。改用 `allocUnsafe` 跳过清零，减少每次回调的 CPU 开销。安全性分析：`Buffer.from(ab).copy(chunk)` 立即覆盖所有字节，不存在数据泄露风险
- **WebSocket headers 构建优化**: 两处 WebSocket `open` 回调中的 `Object.entries(clientHeaders)` + `key.toLowerCase()` 改为 `for...in` + 直接 `has(key)`。uWS `req.forEach` 的 key 已是小写，`WS_SKIP_HEADERS` 的 key 也是小写
- **复用 `startTime` 替代第二次 `Date.now()`**: `handleRequest` 和 `handlePortBindingRequest` 中 `service._state!.lastAccessTime` 直接使用 `startTime`，省掉一次系统调用（idle checker 精度 3 秒，差异可忽略）
- **代理请求超时返回 504 而非 502（功能性修复）**: `proxyReq.on('timeout')` 设置 `state.timedOut` 标志，`error` handler 据此区分返回 504 Gateway Timeout（超时）和 502 Bad Gateway（连接错误）。`handleDirectProxy` 和 `forwardProxyRequest` 两处修复
- **专用 HTTP Agent 评估**: 创建 `PROXY_AGENT`（maxSockets:256, maxFreeSockets:32）后基准测试显示 QPS 从 4,936 降到 4,214。原因：DynaPM 后端全在 localhost，TCP 握手 ~50us 极快，`maxSockets:Infinity` 不是问题；而 `maxFreeSockets:32`（默认 256）导致空闲连接频繁回收重建。已回退使用 `globalAgent`
- **TCP_NODELAY 确认**: Node.js v18+ 的 `http.ClientRequest` 默认已启用 TCP_NODELAY，无需额外设置
- **168 个扩展测试全部通过**，基准测试 4,954 req/s（3 服务×50 并发），P50 延迟 ~31ms

#### 代码质量与性能优化（第四轮 2026-03-22）

#### 代码质量与性能优化（第三轮 2026-03-22）
- **checkTcpPort 消除每次调用的 `new URL()` 开销**: 改为直接接收 `host` 和 `port` 参数，利用已缓存的 `RouteMapping.targetUrl`/`targetPort`；WebSocket 启动等待中也提前创建 `targetUrl` 避免重复解析
- **Admin API `findServiceMapping` O(n) → O(1)**: 构建懒初始化的 `serviceName → RouteMapping` 索引 Map，替代每次请求的线性遍历
- **Admin API `getServicesList` 消除重复遍历**: 使用预构建的服务名称索引 Map，替代每次请求时遍历所有路由表构建去重列表
- **178 个测试全部通过**（含新增的 8 个网关韧性测试）

#### 性能优化（第二轮 2026-03-21）
- **消除响应头过滤冗余 toLowerCase**: `proxyRes.headers` 的 key 已经是小写的，4 处 `.toLowerCase()` 调用是冗余的，移除后代码更正确
- **微基准验证**: CRLF 替换 includes 优化 13.5x（正常值）、一次遍历合并节省 22.6%——但综合影响 < 1% 的总延迟
- **确认 node:http 22 默认 globalAgent 已最优**: `keepAlive: true, maxSockets: Infinity`
- **架构瓶颈确认**: 所有 JS 层面微优化合计节省 ~300ns/req，在 34ms 延迟中占比 < 1%
- **最终结论**: 网关已接近 node:http 出站连接的理论极限，瓶颈在 HTTP 协议双重解析（客户端→uWS + node:http→后端）
- 基准测试：4,936 req/s（3 服务×50 并发），P50 延迟 ~31ms，170 个测试全部通过

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
- test/services/serverless-host/: 独立目录结构
  - index.ts: 后端服务（Worker 线程隔离执行 TS 函数）
  - public/: 前端静态文件（CodeMirror 6 IDE 界面）
- 前端升级到 IDE 级别体验：
  - CodeMirror 6 编辑器（语法高亮、自动缩进、行号）
  - 可拖拽调整大小的侧边栏和输出面板
  - 自定义请求体编辑面板（POST/PUT/PATCH）
  - HTTP 方法选择、请求路径输入、模板下拉菜单
  - JSON 语法高亮输出、快捷键面板（Ctrl+Enter 运行、Ctrl+S 保存）
  - 脏状态标记、Toast 通知、函数删除确认
- 后端完善：
  - 静态文件服务（pipe 流式传输、Cache-Control）
  - GET /_fn/:name 读取函数源码端点
  - 请求体大小限制（64KB）、请求日志
  - 支持子路径执行（/:fnName/sub/path）

#### echo-server 新增端点
- `/cookie` — 返回 Set-Cookie 响应头
- `/custom-response` — 返回自定义响应头（X-Custom-Response、X-Rate-Limit、Cache-Control）和二进制响应体
- `/no-content` — 返回 204 No Content
- `/gzip` — 返回 gzip 压缩的 JSON 响应（Content-Encoding: gzip）
