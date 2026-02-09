const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from App 1! This is a test service.');
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`[app1] 服务已启动，监听端口 ${PORT}`);
});
