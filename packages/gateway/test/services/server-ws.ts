/**
 * WebSocket 测试服务器（Bun 版，替代 Node 版 uWS server-ws）
 * 契约：连接建立即发送 {type:'connected'} 消息
 */
const PORT = parseInt(process.argv[2] || '3111');

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined;
    return new Response('ws-test-server');
  },
  websocket: {
    open(ws) {
      console.log('[WS] WebSocket 连接已建立');
      ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket 连接成功' }));
    },
    message(ws, message) {
      ws.send(typeof message === 'string' ? message : message.toString());
    },
  },
});
console.log(`bun ws-test-server listening on ${server.port}`);
