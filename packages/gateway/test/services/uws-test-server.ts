/**
 * 超快速 HTTP 测试服务器 - 使用 uWebSockets.js
 * 性能极高的测试服务，确保瓶颈不在测试端
 */

import uWS from 'uWebSockets.js';

const port = parseInt(process.argv[2]) || 3001;

const app = uWS.App();

app.any('/*', (res, req) => {
  // 立即返回简单响应
  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', 'text/plain');
    res.end('Hello, World!');
  });
});

app.listen('127.0.0.1', port, (token) => {
  if (token) {
    console.log(`uWS test server listening on port ${port}`);
  } else {
    console.error(`Failed to listen on port ${port}`);
    process.exit(1);
  }
});
