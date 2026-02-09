/**
 * WebSocket 测试服务器
 * 使用 uWS 原生 WebSocket 支持
 */

import { App } from 'uWebSockets.js';

const app = App({});

// WebSocket 处理器
app.ws('/*', {
  /**
   * WebSocket 升级处理
   */
  upgrade: (res, req, context) => {
    console.log('[WS] 收到 WebSocket 升级请求');

    res.upgrade(
      {
        // 用户数据
      },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    );
  },

  /**
   * WebSocket 连接已建立
   */
  open: (ws) => {
    console.log('[WS] WebSocket 连接已建立');

    // 发送连接确认消息
    ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket 连接成功' }), true, false);
  },

  /**
   * 收到消息
   */
  message: (ws, message, isBinary) => {
    try {
      const data = Buffer.from(message).toString('utf8');
      console.log('[WS] 收到消息:', data);

      const msg = JSON.parse(data);

      if (msg.type === 'ping') {
        // 响应 ping
        ws.send(JSON.stringify({ type: 'pong' }), true, false);
      } else if (msg.type === 'test') {
        // 回显测试消息
        ws.send(JSON.stringify({ type: 'echo', data: msg.data || 'hello' }), true, false);
      } else {
        // 回显所有其他消息
        ws.send(JSON.stringify({ type: 'echo', original: msg }), true, false);
      }
    } catch (err) {
      console.error('[WS] 解析消息失败:', err);
      // 回显原始消息
      ws.send(message, isBinary, false);
    }
  },

  /**
   * 连接关闭
   */
  close: (ws, code, message) => {
    console.log('[WS] WebSocket 连接关闭:', code, message.toString());
  },
});

// HTTP 请求处理器（用于健康检查）
app.any('/*', (res, req) => {
  res.writeStatus('200 OK');
  res.end('WebSocket Server - Use WebSocket protocol');
});

app.listen('127.0.0.1', 3011, (token) => {
  if (token) {
    console.log('[ws-server] WebSocket 测试服务器已启动: ws://127.0.0.1:3011');
  } else {
    console.log('[ws-server] WebSocket 测试服务器启动失败');
  }
});
