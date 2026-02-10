/**
 * 超快速 HTTP 测试服务器
 * 使用 Node.js 原生 http 模块，无额外开销
 * 用于压测网关性能，确保瓶颈不在测试服务
 */

import http from 'node:http';

const port = process.argv[2] ? parseInt(process.argv[2]) : 3001;

const server = http.createServer((req, res) => {
  // 立即返回简单响应，无任何处理
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Content-Length': '13',
  });
  res.end('Hello, World!');
});

server.listen(port, () => {
  console.log(`Fast test server listening on port ${port}`);
});

// 优雅退出
process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});
