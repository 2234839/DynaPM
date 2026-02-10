# 贡献指南

感谢你有兴趣为 DynaPM 做出贡献！请阅读以下指南了解开发流程。

## 📋 开发流程

### 1. Fork 并克隆项目

```bash
# Fork 项目到你的 GitHub 账号
# 然后克隆你的 fork
git clone https://github.com/YOUR_USERNAME/DynaPM.git
cd DynaPM

# 添加上游仓库
git remote add upstream https://github.com/2234839/DynaPM.git
```

### 2. 创建特性分支

```bash
git checkout -b feature/your-feature-name
# 或
git checkout -b fix/your-bug-fix
```

### 3. 开发和测试

```bash
# 安装依赖
pnpm install

# 运行测试
pnpm test

# 构建项目
pnpm build
```

### 4. 提交更改

遵循以下提交信息格式：

```
<type>: <description>

[optional body]

[optional footer]
```

**类型（type）：**
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式（不影响功能）
- `refactor`: 重构
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建/工具相关

**示例：**

```bash
git commit -m "feat: 添加服务状态缓存功能

- 使用内存缓存避免频繁执行 bash 命令
- 优化服务状态检查性能

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

### 5. 推送到你的 Fork

```bash
git push origin feature/your-feature-name
```

### 6. 创建 Pull Request

访问 GitHub 创建 PR：
```
https://github.com/2234839/DynaPM/compare/main...YOUR_USERNAME:feature/your-feature-name
```

---

## 📦 发布版本流程

**⚠️ 重要：发布版本前必须更新 CHANGELOG.md！**

### 发布步骤

#### 1. 更新 CHANGELOG.md

在 `CHANGELOG.md` 文件**顶部**添加新版本条目：

```markdown
## [1.0.6] - 2025-02-XX

### ✨ 新增
- 新功能描述

### 🔧 修复
- Bug 修复描述

### 🎯 改进
- 改进内容描述

### 📚 文档
- 文档更新内容

### ⚠️ 破坏性变更
- 如有不兼容变更，在此说明

---

## [1.0.5] - 2025-02-10
...（之前的内容）
```

#### 2. 提交 CHANGELOG

```bash
git add CHANGELOG.md
git commit -m "chore: 添加 v1.0.6 版本更新日志"
```

#### 3. 更新版本号

```bash
# patch 版本（修复 bug）：1.0.5 -> 1.0.6
npm version patch

# minor 版本（新功能）：1.0.5 -> 1.1.0
npm version minor

# major 版本（破坏性变更）：1.0.5 -> 2.0.0
npm version major
```

#### 4. 推送标签触发自动发布

```bash
# 推送主分支和标签
git push origin main --tags
```

#### 5. 自动发布流程

推送标签后，GitHub Actions 会自动：

1. ✅ **构建项目** - 编译 TypeScript
2. ✅ **验证打包** - 检查输出文件
3. ✅ **发布到 npm** - 使用 OIDC 无需令牌
4. ✅ **创建 GitHub Release** - 自动从 CHANGELOG 提取说明

#### 6. 验证发布

```bash
# 查看最新版本
npm view dynapm version

# 查看 Release 说明
# 访问：https://github.com/2234839/DynaPM/releases
```

---

## 🎯 代码规范

### TypeScript 规范

- **禁止使用 `as` 改变类型**（尤其是 `as any`）
- 使用 JSDoc 注释：
  ```typescript
  /** 服务配置 */
  interface ServiceConfig {
    /** 服务名称 */
    name: string;
  }
  ```
- 使用 `for of` 替代 `for i++`

### 错误处理

- 开发阶段使用 `let it crash` 原则
- 不要过度使用 `try-catch`，除非功能设计需要
- 只在系统边界（用户输入、外部 API）进行验证

### 注释规范

- 使用 `/** */` 形式的 JSDoc 注释
- 注释放在变量/函数/属性的上方
- 示例：
  ```typescript
  /** 检查服务是否运行中 */
  async isRunning(service: ServiceConfig): Promise<boolean> {
    // ...
  }
  ```

---

## 🧪 测试指南

### 运行测试

```bash
# 运行完整测试套件
pnpm test

# 监听模式（开发时）
pnpm test:watch
```

### 测试覆盖

当前测试覆盖 12 个核心功能：
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

### 性能测试

```bash
# 运行性能测试
pnpm benchmark

# 多服务性能测试
pnpm benchmark:multi
```

---

## 📝 CHANGELOG 格式规范

### 版本标题格式

```markdown
## [1.0.6] - 2025-02-10
```

### 变更类型

使用以下分类（按顺序）：

- **✨ 新增** (Added): 新功能
- **🔧 修复** (Fixed): Bug 修复
- **🎯 改进** (Changed): 现有功能的改进
- **📚 文档** (Docs): 文档更新
- **⚠️ 破坏性变更** (Breaking): 不兼容的变更
- **⚡ 性能** (Performance): 性能优化
- **🔒 安全** (Security): 安全修复

### 格式要求

- 每个变更前使用对应的 emoji 图标
- 使用列表格式（`-` 开头）
- 保持简洁明了，重点突出

### 示例

```markdown
## [1.0.6] - 2025-02-10

### ✨ 新增
- 添加服务状态缓存功能
- 支持自定义健康检查间隔

### 🔧 修复
- 修复 WebSocket 背压恢复机制
- 修复服务启动超时后的状态卡死

### 🎯 改进
- 优化 TCP 端口检查性能
- 改进日志输出格式

### ⚠️ 破坏性变更
- 移除 `--no-daemon` 选项（请使用 systemd 或 PM2）

---

## [1.0.5] - 2025-02-10
...
```

---

## 🐛 Bug 报告

报告 Bug 时请提供：

1. **环境信息**
   - Node.js 版本：`node -v`
   - DynaPM 版本：`dynapm --version`（或 `npm info dynapm version`）
   - 操作系统

2. **重现步骤**
   - 配置文件
   - 执行的命令
   - 预期行为 vs 实际行为

3. **日志**
   - `logs/dynapm.log` 中的相关错误信息

在 [GitHub Issues](https://github.com/2234839/DynaPM/issues) 提交问题。

---

## 💡 功能建议

功能建议请包含：

1. **使用场景** - 这个功能解决什么问题？
2. **实现建议** - 你认为应该如何实现？
3. **替代方案** - 是否有其他方式达到同样目的？

在 [GitHub Discussions](https://github.com/2234839/DynaPM/discussions) 讨论想法。

---

## 📧 联系方式

- 👤 **作者**: 崮生
- 🐛 **Bug 报告**: [GitHub Issues](https://github.com/2234839/DynaPM/issues)
- 💡 **功能建议**: [GitHub Discussions](https://github.com/2234839/DynaPM/discussions)

---

**感谢你的贡献！** 🎉
