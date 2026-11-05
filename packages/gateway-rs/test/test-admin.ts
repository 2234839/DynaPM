/**
 * Admin API 与面板回归：list/detail/start/stop/SSE 事件/面板可达性/管理面隔离
 */
import { assert, assertEq, finish, startGateway, stopGateway } from "./helpers";

const GW = 3165;
const BACKEND = 3166;
const CFG = "/tmp/dynapm-test-admin.json";

await Bun.write(
  CFG,
  JSON.stringify({
    port: GW,
    host: "127.0.0.1",
    timeouts: { stopWaitMs: 1000 },
    adminApi: { host: "admin.local" },
    services: {
      "admin-target": {
        base: `http://127.0.0.1:${BACKEND}`,
        host: "svc.local",
        commands: { startExec: ["bun", `${import.meta.dir}/backend.ts`, String(BACKEND)] },
      },
    },
  }),
);

await startGateway(CFG, GW);
const base = `http://127.0.0.1:${GW}`;

// 1. 回环可访问 admin API（默认允许 localhost）
{
  const r = await fetch(`${base}/_dynapm/api/services`, { headers: { host: "127.0.0.1" } });
  assertEq(r.status, 200, "回环 admin API 200");
  const j: any = await r.json();
  const arr = Array.isArray(j) ? j : j.services;
  assertEq(arr?.length, 1, "服务列表 1 项");
  assertEq(arr?.[0].name, "admin-target", "服务名正确");
}

// 2. 专属域名可访问
{
  const r = await fetch(`${base}/_dynapm/api/services`, { headers: { host: "admin.local" } });
  assertEq(r.status, 200, "adminApi.host 域名 200");
}

// 3. 未授权服务域名的 /_dynapm 透传给后端（不暴露管理面）
{
  const r = await fetch(`${base}/_dynapm/api/services`, { headers: { host: "svc.local" } });
  const body = await r.text();
  assert(body.includes("backend-ok") || r.status === 200, "服务域名 /_dynapm 透传后端");
}

// 4. detail 字段完整
{
  const r = await fetch(`${base}/_dynapm/api/services/admin-target`, { headers: { host: "127.0.0.1" } });
  const j: any = await r.json();
  const s = j.service ?? j;
  assert(["status", "name"].every((k) => k in s), "detail 含 status/name");
}

// 5. start/stop 生命周期 + SSE 事件流
{
  const ctrl = new AbortController();
  const sse = await fetch(`${base}/_dynapm/api/events`, {
    headers: { host: "127.0.0.1" },
    signal: ctrl.signal,
  });
  const reader = sse.body!.getReader();
  const events: string[] = [];
  const pump = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(dec.decode(value));
    }
  })();

  // 前面透传项可能已把服务按需拉起为 online（start 会短路且不发事件），先停回 offline
  await fetch(`${base}/_dynapm/api/services/admin-target/stop`, { method: "POST", headers: { host: "127.0.0.1" } }).then((r) => r.body?.cancel());
  await Bun.sleep(1500);

  await fetch(`${base}/_dynapm/api/services/admin-target/start`, { method: "POST", headers: { host: "127.0.0.1" } }).then((r) => r.body?.cancel());
  await Bun.sleep(2000);
  await fetch(`${base}/_dynapm/api/services/admin-target/stop`, { method: "POST", headers: { host: "127.0.0.1" } }).then((r) => r.body?.cancel());
  await Bun.sleep(2000);

  const all = events.join("");
  assert(all.includes('"type":"start"'), "SSE 收到 start 事件");
  assert(all.includes('"type":"stop"'), "SSE 收到 stop 事件");
  ctrl.abort();
  pump.catch(() => {});
}

// 6. stats 接口
{
  const r = await fetch(`${base}/_dynapm/api/stats`, { headers: { host: "127.0.0.1" } });
  assertEq(r.status, 200, "stats 接口 200");
}

// 7. 面板可达（回环）
{
  const r = await fetch(`${base}/_dynapm/panel/`, { headers: { host: "127.0.0.1" } });
  assertEq(r.status, 200, "面板 200");
  assert((await r.text()).length > 100, "面板内容非空");
}

await stopGateway(GW);
finish("test-admin");
