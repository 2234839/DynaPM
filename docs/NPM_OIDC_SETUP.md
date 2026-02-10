# npm OIDC 可信发布配置指南

## 什么是 OIDC 可信发布？

OIDC (OpenID Connect) 可信发布是 npm 的新功能，允许你通过 GitHub Actions 安全地发布包，而无需管理长期的 NPM_TOKEN。

## 优势

- ✅ **无需管理令牌**：不需要创建、存储或轮换 NPM_TOKEN
- ✅ **更安全**：使用短期 OIDC 令牌，减少泄露风险
- ✅ **自动集成**：GitHub Actions 直接与 npm 建立信任关系

## 配置步骤

### 1. 在 npm 上配置可信发布者

1. 登录 [npmjs.com](https://www.npmjs.com/)
2. 进入你的包页面：`https://www.npmjs.com/package/dynapm`
3. 点击 **"Publishing"** 标签
4. 添加 GitHub Actions 作为可信发布者：

   ```
   Organization: 2234839  (你的 GitHub 用户名)
   Repository: DynaPM
   Workflow name: release.yml
   Environment: (留空，使用默认)
   ```

5. 点击 **"Add"** 保存配置

### 2. 验证 GitHub Actions 配置

GitHub Actions workflow 已配置好：

- ✅ `permissions: id-token: write` - 允许生成 OIDC 令牌
- ✅ `npm publish --provenance` - 启用包溯源

### 3. 发布新版本

**方式一：使用 Git 标签（推荐）**

```bash
# 更新版本号
npm version patch  # 1.0.3 -> 1.0.4
npm version minor  # 1.0.3 -> 1.1.0
npm version major  # 1.0.3 -> 2.0.0

# 推送标签触发发布
git push origin main --tags
```

**方式二：手动创建标签**

```bash
# 创建并推送标签
git tag v1.0.4
git push origin v1.0.4
```

GitHub Actions 会自动：
1. 构建项目
2. 运行测试
3. 发布到 npm
4. 创建 GitHub Release

## 当前配置评估

### ✅ 打包状态：正常

```
文件大小: 153.5 kB (dist/src/index.js)
输出格式: CommonJS
类型声明: 已生成 (index.d.ts)
```

### ✅ package.json 配置：正确

```json
{
  "name": "dynapm",
  "version": "1.0.3",
  "main": "index.js",
  "bin": {
    "dynapm": "dist/src/index.js"
  },
  "files": [
    "dist/src/",
    "*.md"
  ]
}
```

### ⚠️ 注意事项

1. **npm 版本**：当前是 11.4.2，建议升级到 11.5.1+（可选）
   ```bash
   npm install -g npm@latest
   ```

2. **package.json scripts 更新**：
   - `publish2npm` 脚本可以删除（改用 GitHub Actions）
   - 或保留用于本地测试发布

3. **ws 可选依赖警告**：这是正常的，不影响功能

## 发布命令对比

| 方式 | 命令 | 需要令牌 | 推荐场景 |
|------|------|----------|----------|
| **旧方式** | `npm publish --registry=https://registry.npmjs.org` | ✅ NPM_TOKEN | 本地测试 |
| **新方式 (OIDC)** | `npm publish --provenance` | ❌ 自动获取 | GitHub Actions |

## 故障排查

### 问题：发布失败，提示权限错误

**解决**：
1. 确认 npm 包页面的 Publishing 配置正确
2. 确认 workflow 文件包含 `id-token: write`

### 问题：npm 版本过低

**解决**：在 workflow 中指定更新的 npm 版本
```yaml
- name: Publish to npm
  run: |
    npm install -g npm@latest
    npm publish --provenance
```

### 问题：构建失败

**解决**：检查以下内容
1. 所有文件是否在 `files` 字段中
2. `dist/src/index.js` 是否存在
3. 运行 `pnpm build` 是否成功

## 验证发布成功

1. 访问 `https://www.npmjs.com/package/dynapm`
2. 检查版本号是否更新
3. 安装测试：`npm install -g dynapm`

## 参考文档

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [GitHub OIDC Tokens](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [npm CLI 版本要求](https://github.com/npm/cli/blob/latest/workflows/support.yml)
