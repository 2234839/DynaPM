# 更新日志

所有重要的项目变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
