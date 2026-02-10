# DynaPM - Claude Code 项目配置

DynaPM 是一个智能网关，通过按需启动和闲置自动停止的方式，帮助用户在资源受限的服务器上管理数百个低频访问的服务。

**核心特性：**
- ⚡ 极速冷启动（开销仅 25ms）
- 🚀 流式代理（1-2ms 延迟）
- 🌐 支持 SSE 和 WebSocket
- 🎛️ 通用服务管理（可替代PM2、Docker、systemd 等）
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
GitHub Actions 自动发布到 npm
详见：[CONTRIBUTING.md](./CONTRIBUTING.md)