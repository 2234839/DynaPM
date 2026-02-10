/**
 * 超快速测试服务 - 使用 uWebSockets.js
 * 确保后端不会成为性能瓶颈
 */

const uWS = require('uWebSockets.js');

const PORT = 3002;

const app = uWS.App();

app.any('/*', (res, req) => {
  // 立即返回简单响应，无任何处理
  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', 'text/plain');
    res.end('Hello from App 2!');
  });
});

app.listen('127.0.0.1', PORT, (token) => {
  if (token) {
    console.log(`[app2] uWS 服务已启动，监听端口 ${PORT}`);
  } else {
    console.error(`[app2] 服务启动失败，端口 ${PORT}`);
    process.exit(1);
  }
});
