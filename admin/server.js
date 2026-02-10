import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 4002;
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * MIME 类型映射
 */
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 获取文件的 MIME 类型
 */
function getMimeType(filepath) {
  const ext = path.extname(filepath);
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 创建服务器
 */
const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  // 处理 API 代理请求
  if (req.url.startsWith('/_dynapm/api/')) {
    // 代理到网关的管理 API
    proxyApiRequest(req, res);
    return;
  }

  // 处理静态文件
  let filepath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);

  // 检查文件是否存在
  fs.access(filepath, fs.constants.F_OK, (err) => {
    if (err) {
      // 文件不存在，返回 404 或 index.html（用于 SPA 路由）
      if (!path.extname(req.url)) {
        // 没有扩展名，尝试返回 index.html
        filepath = path.join(PUBLIC_DIR, 'index.html');
        serveFile(filepath, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      }
      return;
    }

    // 检查是否是目录
    fs.stat(filepath, (err, stats) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
        return;
      }

      if (stats.isDirectory()) {
        filepath = path.join(filepath, 'index.html');
      }

      serveFile(filepath, res);
    });
  });
});

/**
 * 提供静态文件
 */
function serveFile(filepath, res) {
  fs.readFile(filepath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error');
      return;
    }

    const mimeType = getMimeType(filepath);
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
}

/**
 * 代理 API 请求到网关管理 API
 */
function proxyApiRequest(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port: 4000,  // 管理 API 端口
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: '127.0.0.1:4000',
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('代理请求失败:', err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Gateway' }));
  });

  req.pipe(proxyReq);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`DynaPM 管理界面已启动: http://127.0.0.1:${PORT}`);
});
