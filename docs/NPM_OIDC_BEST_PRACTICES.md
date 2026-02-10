# npm 包发布最佳实践：使用 GitHub Actions OIDC 自动化

本文档总结了使用 GitHub Actions 和 OIDC (OpenID Connect) 自动发布 npm 包的最佳实践，基于 DynaPM 项目的实际经验。

## 📋 目录

- [概述](#概述)
- [为什么选择 OIDC](#为什么选择-oidc)
- [完整配置流程](#完整配置流程)
- [关键配置详解](#关键配置详解)
- [常见问题排查](#常见问题排查)
- [最佳实践建议](#最佳实践建议)
- [CHANGELOG 集成](#changelog-集成)

---

## 概述

### 传统方式 vs OIDC

| 特性 | 传统方式 (NPM_TOKEN) | OIDC 可信发布 |
|------|---------------------|--------------|
| **令牌管理** | 需要手动创建和管理长期令牌 | 无需令牌，自动短期凭证 |
| **安全性** | 令牌泄露风险高 | 自动过期，GitHub 原生保护 |
| **2FA 要求** | 需要 2FA 或配置 granular token | 无需 2FA |
| **配置复杂度** | 需要在 GitHub Secrets 中配置 | 零配置，自动认证 |
| **溯源** | 无 | `--provenance` 自动签名 |

### OIDC 工作原理

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  GitHub Actions │ ─OIDC──>│   npm Registry   │<────────│  Trusted Pub    │
│   (CI/CD)       │  Token  │  (验证身份)      │  Config  │  Configuration  │
└─────────────────┘         └──────────────────┘         └─────────────────┘
```

1. **GitHub Actions** 生成 OIDC 令牌
2. **npm** 验证令牌是否匹配 Trusted Publisher 配置
3. **发布成功**，自动生成 provenance 签名

---

## 为什么选择 OIDC

### ✅ 优势

1. **更安全**
   - 无需存储长期有效的令牌
   - 自动生成的临时令牌，用完即失效
   - 符合零安全最佳实践

2. **更简单**
   - 无需在 GitHub Secrets 中配置敏感信息
   - 无需手动管理 token 过期
   - 一次配置，永久生效

3. **更专业**
   - 自动生成包溯源签名 (`--provenance`)
   - 提升包的可信度和安全性
   - 符合 npm 官方推荐实践

### ⚠️ 前置要求

- npm CLI >= 11.5.1
- GitHub 仓库
- npm 包的发布权限

---

## 完整配置流程

### 第一步：在 npm 配置 Trusted Publisher

1. 访问 https://www.npmjs.com/package/你的包名/settings
2. 找到 "Trusted Publishers" 部分
3. 点击 "Add a publisher"
4. 填写以下信息：
   - **GitHub organization or user**: `你的GitHub用户名`
   - **Repository name**: `仓库名`
   - **Workflow name**: `.github/workflows/release.yml`
   - **Environment name**: 留空（或指定环境名）

**示例配置**：
```
Organization: 2234839
Repository: DynaPM
Workflow: .github/workflows/release.yml
Environment: (留空)
```

### 第二步：创建 GitHub Actions Workflow

创建 `.github/workflows/release.yml`：

```yaml
name: Release to npm

on:
  push:
    tags:
      - 'v*.*.*'  # 触发条件：推送版本标签，如 v1.0.4

permissions:
  contents: write  # 创建 GitHub Release 需要
  # 关键配置：允许 GitHub Actions 生成 OIDC 令牌
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'  # Node.js 24 自带 npm 11.x

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install dependencies
        run: pnpm install

      - name: Build package
        run: pnpm build

      - name: Verify build output
        run: |
          echo "📦 检查打包输出..."
          ls -la dist/
          if [ ! -f dist/src/index.js ]; then
            echo "❌ 主入口文件不存在"
            exit 1
          fi
          echo "✅ 打包输出正常"

      - name: Publish to npm
        run: npm publish --provenance

      - name: Extract release notes from CHANGELOG
        run: |
          VERSION=${{ github.ref_name }}
          VERSION_NUMBER=${VERSION#v}

          # 使用 awk 提取 CHANGELOG 内容
          awk "
            /## \[$VERSION_NUMBER\]/ { in_section=1; next }
            in_section && /^## / { exit }
            in_section { print }
          " CHANGELOG.md > RELEASE_NOTES.md

          if [ ! -s RELEASE_NOTES.md ]; then
            echo "📦 Release $VERSION" > RELEASE_NOTES.md
          fi

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          body_path: RELEASE_NOTES.md
          draft: false
          prerelease: false
```

### 第三步：package.json 配置

确保 `package.json` 包含以下字段：

```json
{
  "name": "your-package-name",
  "version": "1.0.0",
  "description": "Your package description",
  "main": "dist/src/index.js",
  "bin": {
    "your-command": "dist/src/index.js"
  },
  "files": [
    "dist/src/",
    "*.md",
    "CHANGELOG.md"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/username/repo.git"
  }
}
```

### 第四步：发布新版本

```bash
# 1. 更新 CHANGELOG.md
# 在文件顶部添加新版本条目

# 2. 更新版本号
npm version patch  # 或 minor / major

# 3. 推送标签触发发布
git push origin main --tags
```

---

## 关键配置详解

### 1. permissions 配置

```yaml
permissions:
  contents: write   # ⚠️ 创建 GitHub Release 必需
  id-token: write   # ⚠️ OIDC 认证必需
```

**常见错误**：
- `contents: read` → 403 错误 "Resource not accessible by integration"
- 缺少 `id-token: write` → 无法生成 OIDC 令牌

### 2. Node.js 版本选择

```yaml
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '24'  # ⚠️ 必须使用 Node.js 24+
```

**为什么选择 Node.js 24？**

| Node.js 版本 | npm 版本 | 支持 OIDC |
|-------------|---------|----------|
| 22.x | 10.x | ❌ 不支持 |
| 24.x | 11.x+ | ✅ 支持 |

### 3. npm publish 命令

```bash
npm publish --provenance
```

- `--provenance`: 启用包溯源签名（npm 推荐的安全实践）
- 无需 `--registry` 参数（OIDC 自动处理）

### 4. CHANGELOG 提取

**推荐方案：使用专门的 action（最简单）**

```yaml
- name: Extract release notes from CHANGELOG
  id: changelog
  uses: mindsers/changelog-reader-action@v2
  with:
      path: ./CHANGELOG.md

- name: Create GitHub Release
  uses: softprops/action-gh-release@v2
  with:
    body: ${{ steps.changelog.outputs.changelog }}
```

**优势**：
- ✅ 开箱即用，无需编写脚本
- ✅ 自动识别 Keep a Changelog 格式
- ✅ 支持多种 CHANGELOG 格式

---

**备选方案 1：使用 GitHub 原生自动生成**

```yaml
- name: Create GitHub Release
  uses: softprops/action-gh-release@v2
  with:
    generate_release_notes: true  # GitHub 自动从 commits 生成
```

**优势**：
- ✅ 零配置
- ✅ 自动从 PR 和 commits 生成
- ⚠️ 不依赖 CHANGELOG.md

---

**备选方案 2：手动脚本（完全控制）**

```bash
# 使用 awk 提取特定版本内容
awk "
  /## \[$VERSION_NUMBER\]/ { in_section=1; next }
  in_section && /^## / { exit }
  in_section { print }
" CHANGELOG.md > RELEASE_NOTES.md
```

**优势**：
- ✅ 完全控制提取逻辑
- ✅ 适应自定义 CHANGELOG 格式
- ⚠️ 需要维护脚本

### 5. 使用 softprops/action-gh-release

```yaml
- name: Create GitHub Release
  uses: softprops/action-gh-release@v2
  with:
    body_path: RELEASE_NOTES.md  # 从文件读取
```

**优势**：
- ✅ 替代已废弃的 `actions/create-release@v1`
- ✅ 支持 `body_path` 参数，避免 YAML 转义问题
- ✅ 自动处理特殊字符和多行内容

---

## 常见问题排查

### ❌ 问题 1: npm 版本过低

**错误信息**：
```
npm error 404 Not Found
npm notice Access token expired or revoked
```

**解决方案**：
```yaml
# ❌ 错误：Node.js 22 自带 npm 10.x
node-version: '22'

# ✅ 正确：使用 Node.js 24
node-version: '24'
```

### ❌ 问题 2: 403 Resource not accessible

**错误信息**：
```
Resource not accessible by integration
Status: 403
```

**解决方案**：
```yaml
# ❌ 错误：只读权限
permissions:
  contents: read
  id-token: write

# ✅ 正确：写入权限
permissions:
  contents: write
  id-token: write
```

### ❌ 问题 3: 包已存在

**错误信息**：
```
npm error You cannot publish over the previously published versions: 1.0.5
```

**解决方案**：
```bash
# 发布新版本，不要重复推送相同标签
npm version patch
git push origin main --tags
```

### ❌ 问题 4: Trusted Publisher 配置不匹配

**错误信息**：
```
npm error 404 Not Found - PUT https://registry.npmjs.org/your-package
```

**排查清单**：
1. ✅ GitHub 用户名/组织名正确
2. ✅ 仓库名正确
3. ✅ Workflow 路径正确（区分大小写）
4. ✅ 环境名称匹配（如果指定了）

### ❌ 问题 5: CHANGELOG 提取失败

**现象**：GitHub Release 没有内容或内容不完整

**解决方案**：

**方案 1：使用专门的 action（推荐）**

```yaml
- name: Extract release notes from CHANGELOG
  id: changelog
  uses: mindsers/changelog-reader-action@v2
  with:
      path: ./CHANGELOG.md
```

**方案 2：使用 GitHub 原生自动生成**

```yaml
- name: Create GitHub Release
  uses: softprops/action-gh-release@v2
  with:
    generate_release_notes: true
```

**方案 3：检查 CHANGELOG 格式**

确保 CHANGELOG.md 遵循 Keep a Changelog 格式：

```markdown
## [1.0.7] - 2025-02-10

### ✨ 新增
- 新功能

---
```

**常见错误**：
- ❌ 版本号格式错误：`## 1.0.7` （缺少方括号）
- ❌ 缺少日期：`## [1.0.7]`
- ❌ 缺少分隔符：版本之间没有 `---`

---

## 最佳实践建议

### 1. 版本号管理

使用语义化版本（Semantic Versioning）：

```bash
# Patch: Bug 修复 (1.0.0 → 1.0.1)
npm version patch

# Minor: 新功能，向后兼容 (1.0.0 → 1.1.0)
npm version minor

# Major: 破坏性变更 (1.0.0 → 2.0.0)
npm version major
```

### 2. CHANGELOG 格式

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 格式：

```markdown
## [1.0.7] - 2025-02-10

### ✨ 新增
- 新功能描述

### 🔧 修复
- Bug 修复描述

### 🎯 改进
- 功能改进描述

### 📚 文档
- 文档更新

### ⚠️ 破坏性变更
- 不兼容变更说明
```

### 3. 构建验证

在发布前验证构建输出：

```yaml
- name: Verify build output
  run: |
    ls -la dist/
    if [ ! -f dist/src/index.js ]; then
      echo "❌ 主入口文件不存在"
      exit 1
    fi
    echo "✅ 打包输出正常"
```

### 4. package.json files 字段

明确指定要发布的文件：

```json
{
  "files": [
    "dist/src/",
    "*.md",
    "CHANGELOG.md"
  ]
}
```

**优势**：
- ✅ 减小包体积
- ✅ 避免发布不必要的文件
- ✅ 提高安装速度

### 5. 本地测试

发布前在本地测试：

```bash
# 1. 构建项目
pnpm build

# 2. 打包测试
npm pack

# 3. 本地安装测试
npm install -g ./your-package-1.0.7.tgz

# 4. 运行测试
your-package --version
```

### 6. 使用环境变量（可选）

对于需要不同环境的发布流程：

```yaml
- name: Publish to npm
  if: github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v')
  run: npm publish --provenance
  env:
    NODE_ENV: production
```

---

## CHANGELOG 集成

### 为什么需要 CHANGELOG？

1. **自动化 Release 说明**：GitHub Actions 自动提取
2. **版本历史追踪**：清晰记录每个版本的变更
3. **用户体验**：用户快速了解新功能和修复

### CHANGELOG 格式要求

为了与 CI 脚本配合，CHANGELOG 必须遵循以下格式：

```markdown
## [版本号] - 日期

### 变更类型
- 变更内容

---

## [下一个版本号] - 日期
...
```

**关键点**：
- 版本号使用 `[版本号]` 格式
- 变更类型推荐：`✨ 新增`、`🔧 修复`、`🎯 改进`、`📚 文档`
- 版本之间使用 `---` 分隔

### 提取脚本解析

```bash
awk "
  /## \[$VERSION_NUMBER\]/ { in_section=1; next }
  in_section && /^## / { exit }
  in_section { print }
" CHANGELOG.md > RELEASE_NOTES.md
```

**工作原理**：
1. 找到对应的版本标题行，设置标记并跳过
2. 继续打印内容直到遇到下一个版本标题
3. 退出并保存到临时文件

---

## 总结

### ✅ 成功发布清单

- [ ] npm Trusted Publisher 已配置
- [ ] GitHub Actions workflow 已创建
- [ ] `permissions` 配置正确（`contents: write`, `id-token: write`）
- [ ] 使用 Node.js 24+（获得 npm 11.x）
- [ ] `package.json` 配置正确（`main`, `bin`, `files`）
- [ ] CHANGELOG.md 已更新
- [ ] 版本号已更新（`npm version patch/minor/major`）
- [ ] 标签已推送（`git push origin main --tags`）

### 🎯 一键发布命令

```bash
# 完整发布流程
# 1. 更新 CHANGELOG
vim CHANGELOG.md

# 2. 提交变更
git add CHANGELOG.md
git commit -m "chore: 添加 v1.x.x 版本更新日志"

# 3. 更新版本号并推送
npm version patch && git push origin main --tags
```

### 📚 相关资源

- [npm Trusted Publishing 官方文档](https://docs.npmjs.com/trusted-publishers)
- [GitHub Actions OIDC 文档](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [Keep a Changelog 规范](https://keepachangelog.com/zh-CN/1.0.0/)
- [语义化版本规范](https://semver.org/lang/zh-CN/)
- [softprops/action-gh-release](https://github.com/softprops/action-gh-release)

---

**基于 DynaPM 项目实践 - 2025-02-10**
