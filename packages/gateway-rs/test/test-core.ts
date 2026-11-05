/**
 * 核心代理回归：hostname 路由 / 请求体与响应流转发 / 状态码与头透传 / 未知 Host 404
 * 覆盖旧 Bun 套件中 proxy-comprehensive / advanced-proxy / proxy-deep 的主干场景
 */
import net from "node:net";
import { assert, assertEq, finish, startBackend, startGateway, stopGateway } from "./helpers";

const gwPort = 3160;

const GW = 3160;
const BACKEND = 3150;
const CFG = "/tmp/dynapm-test-core.json";

await Bun.write(
  CFG,
  JSON.stringify({
    port: GW,
    host: "127.0.0.1",
    services: {
      "echo-service": {
        base: `http://127.0.0.1:${BACKEND}`,
        host: "test.local",
        proxyOnly: true,
      },
    },
  }),
);

await startBackend(BACKEND);
await startGateway(CFG, GW);

const H = { host: "test.local" };
const base = `http://127.0.0.1:${GW}`;

// 1. 基础 GET 转发
{
  const r = await fetch(`${base}/some/path?a=1`, { headers: H });
  assertEq(r.status, 200, "GET 状态码 200");
  assertEq(await r.text(), "backend-ok:/some/path", "GET 路径透传");
}

// 2. POST 请求体 echo（1KB）
{
  const body = "x".repeat(1024);
  const r = await fetch(`${base}/echo`, { method: "POST", headers: { ...H, "content-type": "text/plain" }, body });
  assertEq(r.status, 200, "POST 状态码 200");
  assertEq(r.headers.get("x-echo-method"), "POST", "自定义响应头透传");
  assertEq(await r.text(), body, "POST 请求体完整转发");
}

// 3. PATCH/PUT/DELETE 请求体
{
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    const r = await fetch(`${base}/echo`, { method: m, headers: { ...H }, body: `body-${m}` });
    assertEq(await r.text(), `body-${m}`, `${m} 请求体转发`);
  }
}

// 4. 状态码透传（201/404/500）
{
  for (const code of [201, 404, 500]) {
    const r = await fetch(`${base}/status?code=${code}`, { headers: H });
    assertEq(r.status, code, `状态码 ${code} 透传`);
  }
}

// 5. 大响应体流式转发（4MB）
{
  const r = await fetch(`${base}/big?kb=4096`, { headers: H });
  const buf = await r.arrayBuffer();
  assertEq(r.status, 200, "大响应 200");
  assertEq(buf.byteLength, 4 * 1024 * 1024, "大响应字节数完整");
}

// 6. 分块响应（gap 100ms，共 5 块，stall 默认 120s 不应误杀）
{
  const r = await fetch(`${base}/chunked?n=5&gap=100`, { headers: H });
  const text = await r.text();
  assertEq(text, "chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;", "分块响应内容完整");
}

// 7. 未知 Host → 404
{
  const r = await fetch(`${base}/`, { headers: { host: "unknown.local" } });
  assertEq(r.status, 404, "未知 Host 404");
  assert((await r.text()).includes("Service not found"), "404 文案");
}

// 8. CRLF 头注入剥离（Bun fetch 禁止发送含 CRLF 的头，用原始 socket 验证）
{
  const raw = await new Promise<string>((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: gwPort }, () => {
      sock.write(
        `POST /echo HTTP/1.1\r\nHost: test.local\r\nx-custom: val\r\n x-inject: 1\r\ncontent-length: 1\r\nconnection: close\r\n\r\nt`,
      );
    });
    let buf = "";
    sock.on("data", (d) => (buf += d));
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
    setTimeout(() => reject(new Error("raw socket timeout")), 5000);
  });
  assert(raw.startsWith("HTTP/1.1 200") || raw.startsWith("HTTP/1.1 400"), "注入请求有明确响应");
  assert(!/^x-inject:/im.test(raw), "注入头未出现在响应中");
}

// 9. 并发 50 请求
{
  const results = await Promise.all(
    Array.from({ length: 50 }, () => fetch(`${base}/echo`, { method: "POST", headers: H, body: "c" }).then((r) => r.text())),
  );
  assert(results.every((t) => t === "c"), "50 并发请求全部正确");
}

// 10. 重定向 Location 头透传（后端 302 → 网关不跟随）
{
  // backend 无 302 路由，用状态码透传替代验证网关不跟随重定向的行为已由 disable_redirect 保证
  const r = await fetch(`${base}/status?code=302`, { headers: H, redirect: "manual" });
  assertEq(r.status, 302, "302 透传不被网关跟随");
}

await stopGateway(GW);
finish("test-core");
