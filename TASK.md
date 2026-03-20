具有类 serverless 特性的轻量级通用服务管理系统:dynapm
## dynapm 开发

/loop 先检查 TASK.md 中是否有未完成的任务请逐项完成并在充分test验证再继续下一项，如果没有则请请完善当前项目：测试更多代理场景，确保网关程序没有问题，监测并优化程序性能,修改完毕后需要使用 pilot 进行实际运行测试，请自我完善，不要询问我任何事情，也不要切换其他模式（例如 plan mode）
作为网关的测试一定要非常严谨，测试各种可能的情况以及极端情况。
所有文件使用 ts，需要临时运行的使用 node --experimental-strip-types -e xxx.ts 来执行

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

#### 测试覆盖（81 个测试全部通过）
- **test-proxy-comprehensive.ts**: 23 个综合代理测试
- **test-edge-cases.ts**: 15 个极端场景测试
- **test-gateway-robustness.ts**: 13 个健壮性测试
- **test-port-route-start.ts**: 9 个端口路由按需启动测试
- **test-admin-api-lifecycle.ts**: 12 个管理 API 生命周期测试
- **test-security-stability.ts**: 9 个安全与稳定性深度测试
  - 端口路由并发按需启动（10个同时请求）
  - 端口路由多种 HTTP 方法（GET/POST/PUT/DELETE/OPTIONS/PATCH）
  - 端口路由查询参数转发（含中文编码）
  - 端口路由大请求体转发（100KB）
  - 端口路由流式响应（20 chunks）
  - 端口路由状态码透传（200/201/400/404/500）
  - 端口路由 CRLF 注入防护
  - 端口路由后端崩溃恢复
  - 端口路由闲置后重新按需启动

#### Serverless Host 演示
- test/services/serverless-host.ts: 轻量级 TypeScript Serverless 运行时
  - Web 管理界面编写/上传/执行/删除函数
  - 使用 Node --experimental-strip-types 直接加载 TS 函数
  - 已添加到 dynapm.config.ts 作为 serverless-host 服务
