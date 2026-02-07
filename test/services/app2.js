const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Hello from App 2!', timestamp: Date.now() }));
});

const PORT = 3002;
server.listen(PORT, () => {
  console.log(`App 2 listening on port ${PORT}`);
});
