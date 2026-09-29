/**
 * 超快速测试服务 - 使用 uWebSockets.js
 * 确保后端不会成为性能瓶颈
 */

import uWS from 'uWebSockets.js';

const PORT = 3001;

const app = uWS.App();

app.any('/*', (res) => {
  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', 'text/plain');
    res.end('Hello from App 1!');
  });
});

app.listen('127.0.0.1', PORT, (token) => {
  if (token) {
    console.log(`[app1] uWS 服务已启动，监听端口 ${PORT}`);
  } else {
    console.error(`[app1] 服务启动失败，端口 ${PORT}`);
    process.exit(1);
  }
});
