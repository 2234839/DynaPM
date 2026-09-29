/**
 * Echo 测试服务器（Bun 版）
 * 支持验证请求头、请求体、HTTP 方法回显；对拍契约与 Node 版 echo-server 一致：
 * - /echo 返回请求 body（query echo=ok 时返回 'ok'）
 * - 记录最近一次请求头供 /headers 查询
 */
import type BunTypes from 'bun-types';

const PORT = parseInt(process.argv[2] || '3099');

/** 最近一次请求头（供测试探查） */
let lastHeaders: Record<string, string> = {};

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    lastHeaders = Object.fromEntries(req.headers.entries());
    const body = req.method === 'POST' || req.method === 'PUT' ? await req.text() : '';
    if (url.pathname === '/headers') {
      return new Response(JSON.stringify(lastHeaders), { headers: { 'content-type': 'application/json' } });
    }
    if (url.searchParams.has('echo')) {
      return new Response(url.searchParams.get('echo') || 'ok');
    }
    return new Response(body || 'echo');
  },
  websocket: undefined,
});
console.log(`bun echo-server listening on ${server.port}`);
