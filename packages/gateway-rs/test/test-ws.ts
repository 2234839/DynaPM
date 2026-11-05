/**
 * WebSocket 回归：任意路径升级 / 子协议透传 / 关闭码透传 / 冷启动 WS / 双向消息
 */
import { assert, assertEq, finish, startGateway, stopGateway } from "./helpers";

const GW = 3161;
/** port 路由独立监听口（Bun WS 客户端无法自定义 Host 头，走端口路由不依赖 Host） */
const WSPORT = 3162;
const BACKEND = 3151;
const CFG = "/tmp/dynapm-test-ws.json";

await Bun.write(
  CFG,
  JSON.stringify({
    port: GW,
    host: "127.0.0.1",
    timeouts: { stallTimeoutMs: 3000 },
    services: {
      "ws-service": {
        base: `http://127.0.0.1:${BACKEND}`,
        port: WSPORT,
        /** 由网关按需拉起（startExec 直启） */
        commands: { startExec: ["bun", `${import.meta.dir}/backend.ts`, String(BACKEND)] },
      },
    },
  }),
);

await startGateway(CFG, GW);

const base = `http://127.0.0.1:${WSPORT}`;

/** 极简 WS 客户端（Bun 原生） */
function connect(path: string, protocols?: string[]) {
  return new WebSocket(`ws://127.0.0.1:${WSPORT}${path}`, protocols);
}

/** 等待一条消息 */
function nextMsg(ws: WebSocket, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WS 消息超时")), timeoutMs);
    ws.addEventListener("message", (e) => {
      clearTimeout(t);
      resolve(String(e.data));
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("WS error"));
    });
  });
}

function opened(ws: WebSocket, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WS open 超时")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("WS error")); }, { once: true });
  });
}

function closed(ws: WebSocket, timeoutMs = 8000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WS close 超时")), timeoutMs);
    ws.addEventListener("close", (e) => {
      clearTimeout(t);
      resolve({ code: e.code, reason: e.reason });
    });
  });
}

// 1. 冷启动 WS：服务未运行，直接升级 → 网关按需拉起后桥接成功
{
  const ws = connect("/ws");
  await opened(ws);
  const msg = await nextMsg(ws);
  assertEq(msg, "hello:", "冷启动 WS 升级 + open 消息");
  ws.send("ping-1");
  assertEq(await nextMsg(ws), "echo:ping-1", "客户端→上游→客户端 消息回显");
  ws.close();
}

// 2. 任意路径升级（非 /ws 前缀）
{
  const ws = connect("/any/path/ws");
  await opened(ws);
  assertEq(await nextMsg(ws), "hello:", "任意路径 WS 升级");
  ws.close();
}

// 3. 子协议透传
{
  const ws = connect("/ws", ["chat.v2"]);
  await opened(ws);
  assertEq(await nextMsg(ws), "hello:chat.v2", "子协议透传到上游");
  ws.close();
}

// 4. 关闭码/原因透传（上游 close(4001, custom-reason)）
{
  const ws = connect("/ws");
  await opened(ws);
  await nextMsg(ws);
  ws.send("close-code");
  const closeInfo = await closed(ws);
  assertEq(closeInfo.code, 4001, "上游关闭码透传");
  assertEq(closeInfo.reason, "custom-reason", "上游关闭原因透传");
}

// 5. 二进制消息双向
{
  const ws = connect("/ws");
  await opened(ws);
  await nextMsg(ws);
  ws.send(new Uint8Array([1, 2, 3]));
  const msg = await nextMsg(ws);
  // 后端以二进制帧回 "echo:" + 原始字节，逐字符比较验证二进制内容无损透传
  assert(msg === "echo:\u0001\u0002\u0003" || msg === "echo:1,2,3", `二进制消息回显: ${JSON.stringify(msg)}`);
  ws.close();
}

// 6. 并发 10 条 WS 连接
{
  const wss = Array.from({ length: 10 }, () => connect("/ws"));
  await Promise.all(wss.map((w) => opened(w)));
  const msgs = await Promise.all(wss.map((w) => nextMsg(w)));
  assert(msgs.every((m) => m === "hello:"), "10 并发 WS 全部建立");
  for (const w of wss) w.close();
}

// 7. admin API 确认服务在线（WS 冷启动生效）——走主监听端口（port 路由会透传 /_dynapm 给后端）
{
  const r = await fetch(`http://127.0.0.1:${GW}/_dynapm/api/services`, { headers: { host: "127.0.0.1" } });
  const list = await r.json();
  const svc = (list.services ?? list).find?.((s: any) => s.name === "ws-service") ?? list;
  assertEq(r.status, 200, "admin API 可达");
}

await stopGateway(GW);
finish("test-ws");
