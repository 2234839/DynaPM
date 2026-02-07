const http = require('http');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello from App 3 with health check endpoint!');
  }
});

const PORT = 3003;
server.listen(PORT, () => {
  console.log(`App 3 listening on port ${PORT}`);
});
