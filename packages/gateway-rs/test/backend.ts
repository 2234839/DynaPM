/**
 * 测试后端：echo 服务（HTTP + WebSocket + 慢响应 + 分块 + 大响应）
 * 用法: bun backend.ts <port>
 */
const port = parseInt(process.argv[2] || "3150");

Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" || url.pathname === "/any/path/ws") {
      if (server.upgrade(req, { data: { proto: req.headers.get("sec-websocket-protocol") } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/big") {
      const kb = parseInt(url.searchParams.get("kb") || "1");
      return new Response(new Uint8Array(kb * 1024).fill(65), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (url.pathname === "/slow") {
      const ms = parseInt(url.searchParams.get("ms") || "100");
      return new Promise((resolve) => setTimeout(() => resolve(new Response(`slow-${ms}`)), ms));
    }
    /** 慢分块响应：每 200ms 一块，共 n 块（用于停滞超时与流式验证） */
    if (url.pathname === "/chunked") {
      const n = parseInt(url.searchParams.get("n") || "5");
      const gap = parseInt(url.searchParams.get("gap") || "200");
      const stream = new ReadableStream({
        async start(c) {
          for (let i = 0; i < n; i++) {
            c.enqueue(new TextEncoder().encode(`chunk-${i};`));
            await Bun.sleep(gap);
          }
          c.close();
        },
      });
      return new Response(stream);
    }
    if (url.pathname === "/status") {
      return new Response(`status-${url.searchParams.get("code") || "200"}`, {
        status: parseInt(url.searchParams.get("code") || "200"),
      });
    }
    if (url.pathname === "/echo") {
      // 请求体直通 echo（流式，不缓冲）
      return new Response(req.body, {
        headers: {
          "content-type": req.headers.get("content-type") || "application/octet-stream",
          "x-echo-method": req.method,
          "x-echo-saw-body": "1",
        },
      });
    }
    return new Response(`backend-ok:${url.pathname}`);
  },
  websocket: {
    open(ws) {
      ws.send(`hello:${ws.data?.proto ?? ""}`);
    },
    message(ws, msg) {
      ws.send(`echo:${msg instanceof ArrayBuffer ? new TextDecoder().decode(msg) : msg}`);
      if (String(msg) === "close-code") ws.close(4001, "custom-reason");
    },
    close() {},
  },
});

console.log(`backend listening on ${port}`);
