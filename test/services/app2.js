const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Hello from App 2!', timestamp: Date.now() }));
});

const PORT = 3002;
server.listen(PORT, () => {
  console.log(`[app2] 服务已启动，监听端口 ${PORT}`);
});
