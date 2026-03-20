# DynaPM - Claude Code 项目配置

DynaPM 是一个智能网关(类似nginx)/进程管理工具(类似pm2)，通过按需启动(请求到达时通过查找配置判断请求属于哪个程序，然后网关转发请求，当程序还未启动会执行启动命令等待就绪后再实际转发)和闲置自动停止的方式，帮助用户在资源受限的服务器上运行成千上万个低频访问+少量高频访问的服务。

**核心特性：**
- ⚡ 极速冷启动
- 🚀 双向流式转发代理实现极低的请求延迟：将请求体流式给代理服务，将代理服务的响应流式给请求者 所以不需要缓冲请求或者响应，唯一的需要缓冲的时机就是请求到达网关，但是需要被网关唤起的程序还没有启动成功的时候
- 🌐 支持 SSE 和 WebSocket
- 🎛️ 基于bash的通用服务管理（可用于管理PM2、Docker、systemd 等任意服务）
- 🔄 闲置自动回收资源

## 技术栈

- **运行时**: Node.js 22+
- **Web 框架**: uWebSockets.js（最佳性能）
- **日志**: Pino
- **配置**: c12（支持 TypeScript）
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
├── .github/workflows/
│   └── release.yml              # 自动发布到 npm
├── CHANGELOG.md                  # 版本更新日志
├── README.md                     # 英文文档
├── README_zh.md                  # 中文文档

```

## 开发指南

```bash
# 运行测试
pnpm test

# 构建项目
pnpm build

# 性能测试
pnpm benchmark
```

### 发布新版本

流程 ： CHANGELOG → commit →更新 npm version （git add tag） →git push （github actions 会通过 oicd 发包 npm ）