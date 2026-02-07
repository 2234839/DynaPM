const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from App 1! This is a test service.');
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`App 1 listening on port ${PORT}`);
});
