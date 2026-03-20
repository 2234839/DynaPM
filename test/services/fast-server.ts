/**
 * 超快速 HTTP 测试服务器
 * 使用 Node.js 原生 http 模块，无额外开销
 * 用于压测网关性能，确保瓶颈不在测试服务
 */

import * as http from 'node:http';

const port = process.argv[2] ? parseInt(process.argv[2]) : 3001;

const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Content-Length': '13',
  });
  res.end('Hello, World!');
});

server.listen(port, () => {
  console.log(`Fast test server listening on port ${port}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});
