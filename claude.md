# DynaPM - Claude Code 项目配置

> 动态进程管理器，具有类 serverless 特性的轻量级通用服务管理系统

## 项目概述

DynaPM 是一个智能网关，通过按需启动和闲置自动停止的方式，帮助用户在资源受限的服务器上管理数百个低频访问的服务。

**核心特性：**
- ⚡ 极速冷启动（开销仅 25ms）
- 🚀 流式代理（1-2ms 延迟）
- 🌐 支持 SSE 和 WebSocket
- 🎛️ 通用服务管理（PM2、Docker、systemd 等）
- 🔄 闲置自动回收

## 技术栈

- **运行时**: Node.js 22+
- **Web 框架**: uWebSockets.js（性能比 Fastify 快 10 倍以上）
- **日志**: Pino（异步结构化日志）
- **配置**: c12（支持 TypeScript）
- **构建**: rslib
- **包管理**: pnpm
- **测试**: tsx + 自定义测试套件

## 项目结构

```
DynaPM/
├── src/
│   ├── core/
│   │   ├── gateway.ts          # 核心网关实现（HTTP/WebSocket代理）
│   │   ├── service-manager.ts  # 服务启动/停止管理
│   │   ├── health-checker.ts    # 健康检查（TCP/HTTP/命令）
│   │   └── command-executor.ts  # Bash 命令执行器
│   ├── config/
│   │   ├── types.ts             # TypeScript 类型定义
│   │   └── loader.ts            # 配置加载器
│   └── index.ts                 # 主入口
├── test/
│   ├── test-all.ts              # 完整测试套件（12个测试）
│   ├── server-*.ts              # 测试服务器
│   └── benchmark.js             # 性能测试
├── docs/
│   └── NPM_OIDC_SETUP.md        # npm OIDC 发布配置指南
├── .github/workflows/
│   └── release.yml              # 自动发布到 npm
├── CHANGELOG.md                  # 版本更新日志
├── README.md                     # 英文文档
├── README_zh.md                  # 中文文档
└── claude.md                     # 本文件（Claude 配置）

```

## 开发指南

### 快速开始

```bash
# 安装依赖
pnpm install

# 运行测试
pnpm test

# 构建项目
pnpm build

# 性能测试
pnpm benchmark
```

### 发布新版本

**⚠️ 重要：发布前必须更新 CHANGELOG.md！**

1. **更新 CHANGELOG.md**（顶部添加新版本）
2. **提交 CHANGELOG**
3. **创建版本标签并推送**：
   ```bash
   npm version patch  # 或 minor/major
   git push origin main --tags
   ```
4. GitHub Actions 自动发布到 npm

详见：[CONTRIBUTING.md](./CONTRIBUTING.md)

### 代码规范

- **类型安全**: 禁止使用 `as` 改变类型（尤其是 `as any`）
- **注释**: 使用 JSDoc `/** */` 格式
- **迭代**: 使用 `for of` 替代 `for i++`
- **错误处理**: 开发阶段 `let it crash`，不过度使用 try-catch

### 最近的重要更新

**v1.0.5** (2025-02-10):
- 添加 CHANGELOG.md 版本更新日志
- GitHub Release 自动从 CHANGELOG 提取发布说明
- 添加贡献者指南文档

**v1.0.4** (2025-02-10):
- 修复服务启动超时后状态卡死问题
- 添加 WebSocket 背压恢复机制
- 添加 GitHub Actions 自动发布到 npm
- 配置 npm OIDC 可信发布

## 测试

项目包含 12 个自动化测试，覆盖所有核心功能：

1. 按需启动
2. 热启动（服务已运行）
3. 自动停止
4. 404 错误处理
5. 多服务并发
6. 不同健康检查
7. 路径代理
8. 连续请求更新闲置时间
9. POST 请求
10. SSE 流式传输
11. WebSocket 连接
12. 长连接代理

所有测试通过：✅ 12/12

## 性能指标

```
冷启动时间：   ~48ms (DynaPM: 25ms + 服务启动: 23ms)
流式代理延迟：  平均 9.5ms
吞吐量：       8,383 req/s (多服务, 60 并发)
内存开销：     ~50MB
代码体积：     153.5 kB (未压缩)
```

## 关键设计决策

### 1. 为什么选择 uWebSockets.js？

比 Express/Fastify 快 10 倍以上，真正的流式转发，零缓冲。

### 2. 为什么使用 Bash 命令管理服务？

通用性 - 支持 PM2、Docker、systemd 等任何管理方式。

### 3. 为什么使用内存状态缓存？

避免每次请求都执行 bash 命令检查状态，性能优化关键。

### 4. 为什么使用 npm OIDC 发布？

无需 NPM_TOKEN，无需 2FA，更安全（短期令牌）。

## 常见任务

### 添加新功能
1. 在对应分支开发
2. 更新测试（如有需要）
3. 更新文档
4. 提交 PR

### 修复 Bug
1. 定位问题代码
2. 编写测试用例
3. 修复并验证
4. 提交 PR

### 发布版本
1. 更新 CHANGELOG.md
2. `npm version patch/minor/major`
3. `git push origin main --tags`
4. 等待 GitHub Actions 自动发布

## 相关链接

- **GitHub**: https://github.com/2234839/DynaPM
- **npm 包**: https://www.npmjs.com/package/dynapm
- **文档**: [README_zh.md](./README_zh.md) | [README.md](./README.md)
- **贡献指南**: [CONTRIBUTING.md](./CONTRIBUTING.md)
- **更新日志**: [CHANGELOG.md](./CHANGELOG.md)
- **发布配置**: [docs/NPM_OIDC_SETUP.md](./docs/NPM_OIDC_SETUP.md)

## 作者

崮生

## 许可证

ISC
