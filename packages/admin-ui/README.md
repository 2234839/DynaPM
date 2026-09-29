# @modelrep/admin-ui

ModelRep（原 DynaPM）管理前端：Vite + Vue3 + TypeScript。

## 功能

- 服务列表（`GET /_dynapm/api/services`，标识字段用 `base`）
- 服务启动 / 停止（`POST /_dynapm/api/services/:name/start|stop`）
- 服务详情展开（`GET /_dynapm/api/services/:name`）
- 5s 自动轮询 + 手动刷新

## 命令

```bash
pnpm install        # 安装依赖（也可用 bun install）
pnpm dev            # 开发服务器 http://localhost:5173（/_dynapm、/_modelrep 代理到 127.0.0.1:4000）
pnpm build          # 类型检查 + 构建产物到 dist/
pnpm preview        # 预览构建产物
```

## 配置

- admin API baseURL 可通过 `VITE_ADMIN_API_BASE` 环境变量配置，默认同源（dev 走 vite 代理）
- dev 代理目标修改 `vite.config.ts` 中的 `server.proxy`

## 构建产物

`dist/` 为标准静态资源，后续可由 gateway 直接 serve（本阶段尚未接入）。
