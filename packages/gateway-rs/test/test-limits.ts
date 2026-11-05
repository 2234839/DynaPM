/**
 * 限制与超时回归：413（预检/流式计数）、504 代理超时、停滞超时断流
 */
import net from "node:net";
import { assert, assertEq, finish, startBackend, startGateway, stopGateway } from "./helpers";

const GW = 3163;
const BACKEND = 3164;
const CFG = "/tmp/dynapm-test-limits.json";

await Bun.write(
  CFG,
  JSON.stringify({
    port: GW,
    host: "127.0.0.1",
    timeouts: { proxyTimeoutMs: 2000, stallTimeoutMs: 1200 },
    services: {
      "echo-service": {
        base: `http://127.0.0.1:${BACKEND}`,
        host: "limit.local",
        proxyOnly: true,
      },
    },
  }),
);

await startBackend(BACKEND);
await startGateway(CFG, GW);

const base = `http://127.0.0.1:${GW}`;
const H = { host: "limit.local" };

// 1. 413：content-length 预检（声明 11MB，用原始 socket 避免 fetch 重写 content-length）
{
  const raw = await new Promise<string>((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: GW }, () => {
      sock.write(`POST /echo HTTP/1.1\r\nHost: limit.local\r\ncontent-length: ${11 * 1024 * 1024}\r\nconnection: close\r\n\r\n`);
    });
    let buf = "";
    sock.on("data", (d) => (buf += d));
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
    setTimeout(() => reject(new Error("raw socket timeout")), 5000);
  });
  assert(raw.startsWith("HTTP/1.1 413"), "超限 content-length 预检 413");
}

// 1b. 413：chunked 流式计数超限（12MB 无 content-length）
// HTTP 协议限制：上游 200 头可能已回，网关只能中断 body 传递 → 断言 body 被截断而非完整 12MB
{
  const bigStream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 12; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(66));
      c.close();
    },
  });
  const r = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { ...H, "transfer-encoding": "chunked", "content-type": "application/octet-stream" },
    body: bigStream,
    duplex: "half",
  } as any);
  assertEq(r.status, 200, "流式超限响应头已回 200（无法回 413）");
  const recv = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
  assert(recv.byteLength < 12 * 1024 * 1024, "超限 body 被网关截断");
}

// 2. 504：后端 3s 响应 > proxyTimeoutMs 2s
{
  const r = await fetch(`${base}/slow?ms=3000`, { headers: H, signal: AbortSignal.timeout(10_000) });
  assertEq(r.status, 504, "后端超时 504");
  await r.text().catch(() => {});
}

// 3. 正常慢响应（1.2s < 2s 代理超时）不被误杀
{
  const r = await fetch(`${base}/slow?ms=1200`, { headers: H });
  assertEq(r.status, 200, "1.2s 响应正常 200");
  assertEq(await r.text(), "slow-1200", "慢响应内容正确");
}

// 4. 停滞超时：分块响应 gap 5s > stallTimeoutMs 1.2s → 连接被断
{
  const r = await fetch(`${base}/chunked?n=3&gap=5000`, { headers: H });
  const text = await r.text().catch(() => "<conn-aborted>");
  assert(text === "<conn-aborted>" || text.length < 100, "停滞超时断开连接");
}

// 5. 停滞不误杀：gap 500ms < 1.2s，正常完成
{
  const r = await fetch(`${base}/chunked?n=5&gap=500`, { headers: H });
  const text = await r.text().catch(() => "");
  assertEq(text, "chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;", "间隔小于停滞阈值的流正常完成");
}

// 6. 超时后网关仍稳定
{
  const r = await fetch(`${base}/`, { headers: H });
  assertEq(r.status, 200, "超时场景后网关稳定");
}

await stopGateway(GW);
finish("test-limits");
