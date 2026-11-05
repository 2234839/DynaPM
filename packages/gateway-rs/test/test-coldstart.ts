/**
 * 按需启动状态机回归：冷启动 / 并发单飞 / 启动失败 503 / paused / 闲置回收 / keepWarm
 */
import { assert, assertEq, finish, startGateway, stopGateway } from "./helpers";

const GW = 3166;
const BACKEND = 3152;
const BAD = 3153; // 永远起不来的端口
const CFG = "/tmp/dynapm-test-cold.json";

await Bun.write(
  CFG,
  JSON.stringify({
    port: GW,
    host: "127.0.0.1",
    timeouts: { stopWaitMs: 1500 },
    services: {
      "cold-service": {
        base: `http://127.0.0.1:${BACKEND}`,
        host: "cold.local",
        idleTimeout: 2500,
        commands: { startExec: ["bun", `${import.meta.dir}/backend.ts`, String(BACKEND)] },
      },
      "warm-service": {
        base: `http://127.0.0.1:${BACKEND + 10}`,
        host: "warm.local",
        keepWarm: true,
        idleTimeout: 2000,
        warmIdleTimeout: 60_000,
        commands: { startExec: ["bun", `${import.meta.dir}/backend.ts`, String(BACKEND + 10)] },
      },
      "bad-service": {
        base: `http://127.0.0.1:${BAD}`,
        host: "bad.local",
        startTimeout: 3000,
        /** 起一个监听别的端口的进程：健康检查（目标端口）永远不通 → 启动失败 */
        commands: { startExec: ["bun", `${import.meta.dir}/backend.ts`, String(BACKEND + 20)] },
      },
    },
  }),
);

await startGateway(CFG, GW);
const base = `http://127.0.0.1:${GW}`;
const admin = `${base}/_dynapm/api/services`;

/** admin 查询服务状态 */
async function status(name: string): Promise<string> {
  const r = await fetch(`${admin}/${name}`, { headers: { host: "127.0.0.1" } });
  const j = await r.json();
  return (j.service ?? j).status ?? j.status;
}

// 1. 冷启动：首个请求触发启动并成功
{
  const t0 = Date.now();
  const r = await fetch(`${base}/`, { headers: { host: "cold.local" } });
  assertEq(r.status, 200, "冷启动后 200");
  assert(Date.now() - t0 > 100, "首个请求经历冷启动等待");
  assertEq(await status("cold-service"), "online", "冷启动后状态 online");
}

// 2. 热路径：第二请求直接 200
{
  const t0 = Date.now();
  const r = await fetch(`${base}/`, { headers: { host: "cold.local" } });
  assertEq(r.status, 200, "热路径 200");
  assert(Date.now() - t0 < 100, "热路径无冷启动延迟");
}

// 3. 并发 20 冷启动单飞：全部 200（无 502/503）
{
  await fetch(`${admin}/cold-service/stop`, { method: "POST", headers: { host: "127.0.0.1" } }).then((r) => r.body?.cancel());
  await Bun.sleep(300);
  const rs = await Promise.all(
    Array.from({ length: 20 }, () => fetch(`${base}/`, { headers: { host: "cold.local" } })),
  );
  assert(rs.every((r) => r.status === 200), "20 并发冷启动全部 200");
  for (const r of rs) r.body?.cancel();
}

// 4. 闲置回收：idleTimeout 2.5s 后停止（stop 流程异步，轮询等待至多 15s）
{
  let st = "online";
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(500);
    st = await status("cold-service");
    if (st === "offline") break;
  }
  assertEq(st, "offline", "闲置超时后 offline");
}

// 5. 回收后再请求自动复活
{
  const r = await fetch(`${base}/`, { headers: { host: "cold.local" } });
  assertEq(r.status, 200, "闲置回收后自动复活");
}

// 6. keepWarm：超过普通 idleTimeout 但低于 warmIdleTimeout 仍在线
{
  const r = await fetch(`${base}/`, { headers: { host: "warm.local" } });
  assertEq(r.status, 200, "keepWarm 服务冷启动成功");
  await Bun.sleep(5000);
  assertEq(await status("warm-service"), "online", "keepWarm 超普通阈值仍在线");
}

// 7. 启动失败：startTimeout 后 503
{
  const r = await fetch(`${base}/`, { headers: { host: "bad.local" }, signal: AbortSignal.timeout(15000) });
  assertEq(r.status, 503, "启动失败返回 503");
}

// 8. stop 后状态 offline + 再拉起
{
  const r = await fetch(`${admin}/cold-service/stop`, { method: "POST", headers: { host: "127.0.0.1" } });
  await r.body?.cancel();
  await Bun.sleep(300);
  assertEq(await status("cold-service"), "offline", "admin stop 后 offline");
  const r2 = await fetch(`${base}/`, { headers: { host: "cold.local" } });
  assertEq(r2.status, 200, "stop 后请求自动再拉起");
}

// 9. paused（disable）：拒绝代理 503
{
  const r = await fetch(`${admin}/cold-service/disable`, { method: "POST", headers: { host: "127.0.0.1" } });
  await r.body?.cancel();
  const r2 = await fetch(`${base}/`, { headers: { host: "cold.local" } });
  assertEq(r2.status, 503, "paused 服务 503");
  await r2.body?.cancel();
  const r3 = await fetch(`${admin}/cold-service/enable`, { method: "POST", headers: { host: "127.0.0.1" } });
  await r3.body?.cancel();
  const r4 = await fetch(`${base}/`, { headers: { host: "cold.local" } });
  assertEq(r4.status, 200, "enable 后恢复代理");
  await r4.body?.cancel();
}

// 10. admin start（主动预热）
{
  await fetch(`${admin}/cold-service/stop`, { method: "POST", headers: { host: "127.0.0.1" } }).then((r) => r.body?.cancel());
  await Bun.sleep(300);
  const r = await fetch(`${admin}/cold-service/start`, { method: "POST", headers: { host: "127.0.0.1" } });
  assertEq(r.status, 200, "admin start 200");
  await r.body?.cancel();
  assertEq(await status("cold-service"), "online", "admin start 后 online");
}

await stopGateway(GW);
finish("test-coldstart");
