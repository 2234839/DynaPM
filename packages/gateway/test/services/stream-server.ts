/**
 * 流式大响应测试服务器
 * /stream 返回 4MB body 分块写出，用于制造网关侧客户端背压（慢客户端场景）
 */

import * as http from 'node:http';

const port = process.argv[2] ? parseInt(process.argv[2]) : 3200;

const server = http.createServer((req, res) => {
  if (req.url === '/stream') {
    const total = 4 * 1024 * 1024;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(total),
    });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const writeMore = () => {
      while (sent < total) {
        sent += chunk.length;
        if (!res.write(sent + chunk.length > total ? chunk.subarray(0, total - (sent - chunk.length)) : chunk)) {
          res.once('drain', writeMore);
          return;
        }
      }
      res.end();
    };
    writeMore();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

server.listen(port, () => {
  console.log(`Stream test server listening on port ${port}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});
