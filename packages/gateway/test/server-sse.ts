/**
 * SSE 测试服务器
 * 提供 Server-Sent Events 端点用于测试
 */

import { App } from 'uWebSockets.js';

const app = App({});

app.get('/', (res) => {
  res.cork(() => {
    res.write('Hello from SSE Server');
    res.end();
  });
});

// SSE 端点
app.get('/events', (res, req) => {
  let intervalId: NodeJS.Timeout | null = null;
  let aborted = false;

  // 处理客户端断开连接
  res.onAborted(() => {
    aborted = true;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });

  // 使用 tryFinally 确保资源清理
  try {
    // 初始化：设置响应头和发送初始消息
    const initOk = res.cork(() => {
      if (aborted) return false;

      res.writeHeader('Content-Type', 'text/event-stream');
      res.writeHeader('Cache-Control', 'no-cache');
      res.writeHeader('Connection', 'keep-alive');
      res.writeHeader('Access-Control-Allow-Origin', '*');

      res.write('event: connected\ndata: {"message":"SSE connection established"}\n\n');

      return true;
    });

    if (!initOk || aborted) {
      return;
    }

    // 定期发送事件
    let count = 0;
    intervalId = setInterval(() => {
      // 首先检查是否已中止，如果是则清理并返回（不访问 res）
      if (aborted) {
        clearInterval(intervalId);
        intervalId = null;
        return;
      }

      count++;
      const data = {
        id: count,
        message: `Event ${count}`,
        timestamp: new Date().toISOString(),
      };

      try {
        // 发送事件（使用 cork）
        const writeOk = res.cork(() => {
          // 在 cork 内部再次检查（防止在检查后、cork 前客户端断开）
          if (aborted) return false;

          if (count >= 10) {
            res.write('event: end\ndata: {"message":"Stream ended"}\n\n');
            res.end();
            return false;  // 停止 interval
          }

          res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
          return true;
        });

        // 如果写入失败或达到结束条件，停止 interval
        if (!writeOk) {
          clearInterval(intervalId);
          intervalId = null;
        }
      } catch (err) {
        // 捕获 uWS 错误（客户端断开后访问 HttpResponse）
        clearInterval(intervalId);
        intervalId = null;
      }
    }, 500);
  } catch (err) {
    // 出错时清理资源
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }
});

app.listen('::', 3010, (token) => {
  if (token) {
    console.log('[sse-server] SSE 测试服务器已启动: http://127.0.0.1:3010');
  } else {
    console.log('[sse-server] SSE 测试服务器启动失败');
  }
});
