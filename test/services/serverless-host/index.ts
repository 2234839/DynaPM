/**
 * DynaPM Serverless Host - 演示程序
 *
 * 轻量级 TypeScript Serverless 运行时：
 * - 通过 Web 界面编写和上传 TS 函数
 * - 请求自动路由到对应的 TS 函数执行
 * - 每次请求在独立 Worker 线程中执行，执行完毕自动回收内存
 * - 可被 DynaPM 管理运行
 *
 * 路由规则：
 * - GET  /              -> Web 管理界面（静态文件）
 * - GET  /_fn/list       -> 列出所有函数
 * - GET  /_fn/:name      -> 读取函数源码
 * - POST /_fn/upload     -> 上传/更新函数
 * - DELETE /_fn/:name    -> 删除函数
 * - *    /:functionName  -> 执行对应的函数
 *
 * 函数签名：export default async (ctx) => { return { status, headers, body } }
 * ctx: { method, url, path, query, headers, body }
 */

import * as http from 'node:http';
import { URL } from 'node:url';
import { writeFile, unlink, readdir, mkdir, readFile } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const PORT = parseInt(process.argv[2] || '4000');
const FN_DIR = join(process.cwd(), '.serverless-fn');
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const WORKER_TIMEOUT = 10_000;
const MAX_UPLOAD_SIZE = 64 * 1024;

/** 确保函数目录存在 */
await mkdir(FN_DIR, { recursive: true });

/** Worker 内联代码：加载 TS 函数并执行，返回响应数据 */
const WORKER_CODE = `
import { workerData, parentPort } from 'node:worker_threads';

async function run() {
  const { fnPath, method, url, path, query, headers, body } = workerData;

  try {
    const mod = await import('file://' + fnPath + '?t=' + Date.now());
    if (!mod.default || typeof mod.default !== 'function') {
      parentPort.postMessage({ error: '函数必须导出 default 函数' });
      return;
    }

    const result = await mod.default({ method, url, path, query, headers, body });

    if (!result || typeof result !== 'object') {
      parentPort.postMessage({ error: '函数必须返回 { status, headers, body }' });
      return;
    }

    parentPort.postMessage({
      status: result.status || 200,
      headers: result.headers || {},
      body: result.body || '',
    });
  } catch (err) {
    parentPort.postMessage({ error: err.message || String(err) });
  }
}

run();
`;

/** 函数响应类型 */
interface FnResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 在 Worker 中执行函数，执行完自动 terminate 释放内存 */
function executeInWorker(fnPath: string, ctx: {
  method: string;
  url: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}): Promise<FnResponse> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { fnPath, ...ctx },
    });

    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ status: 504, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '函数执行超时' }) });
    }, WORKER_TIMEOUT);

    worker.on('message', (msg: { status?: number; headers?: Record<string, string>; body?: string; error?: string }) => {
      clearTimeout(timer);
      worker.terminate();
      if (msg.error) {
        resolve({ status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg.error }) });
      } else {
        resolve({ status: msg.status, headers: msg.headers || {}, body: msg.body || '' });
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) });
    });
  });
}

/** 获取所有函数列表 */
async function listFunctions(): Promise<{ name: string; path: string }[]> {
  const files = await readdir(FN_DIR);
  const tsFiles = files.filter(f => f.endsWith('.ts'));

  const fns: { name: string; path: string }[] = [];
  for (const file of tsFiles) {
    const name = file.replace('.ts', '');
    fns.push({ name, path: `/${name}` });
  }

  return fns;
}

/** MIME 类型映射 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 读取请求体（限制大小） */
function readBody(req: http.IncomingMessage, maxSize = MAX_UPLOAD_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxSize) {
        req.destroy();
        reject(new Error(`Request body too large (max ${maxSize} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/** 发送 JSON 响应 */
function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  /** 静态文件服务 */
  if (req.method === 'GET' && (path === '/' || path.startsWith('/public'))) {
    const filePath = path === '/'
      ? join(PUBLIC_DIR, 'index.html')
      : join(PUBLIC_DIR, path.slice('/public/'.length));

    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    createReadStream(filePath).pipe(res);
    return;
  }

  /** 静态资源（直接路径，如 /style.css, /app.js） */
  if (req.method === 'GET' && (path.endsWith('.css') || path.endsWith('.js') || path.endsWith('.svg') || path.endsWith('.ico') || path.endsWith('.png'))) {
    const filePath = join(PUBLIC_DIR, path.slice(1));
    if (existsSync(filePath)) {
      const ext = extname(filePath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      });
      createReadStream(filePath).pipe(res);
      return;
    }
  }

  /** 列出函数 */
  if (path === '/_fn/list' && req.method === 'GET') {
    const functions = await listFunctions();
    sendJson(res, { functions });
    return;
  }

  /** 读取函数源码 */
  if (path.startsWith('/_fn/') && req.method === 'GET' && path !== '/_fn/list') {
    const name = decodeURIComponent(path.slice(5));
    if (!name) {
      sendJson(res, { error: '缺少函数名称' }, 400);
      return;
    }

    const fnPath = join(FN_DIR, `${name}.ts`);
    if (!existsSync(fnPath)) {
      sendJson(res, { error: '函数不存在' }, 404);
      return;
    }

    const code = await readFile(fnPath, 'utf-8');
    sendJson(res, { name, code });
    return;
  }

  /** 上传函数 */
  if (path === '/_fn/upload' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name, code } = JSON.parse(body);

      if (!name || !code) {
        sendJson(res, { success: false, error: '缺少 name 或 code' }, 400);
        return;
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        sendJson(res, { success: false, error: '函数名称只能包含字母、数字、连字符和下划线' }, 400);
        return;
      }

      /** 保存源文件 */
      const tsPath = join(FN_DIR, `${name}.ts`);
      await writeFile(tsPath, code);

      sendJson(res, { success: true, message: `函数 /${name} 已部署` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, { success: false, error: message }, 500);
    }
    return;
  }

  /** 删除函数 */
  if (path.startsWith('/_fn/') && req.method === 'DELETE') {
    const name = decodeURIComponent(path.slice(5));
    if (!name) {
      sendJson(res, { success: false, error: '缺少函数名称' }, 400);
      return;
    }

    try {
      await unlink(join(FN_DIR, `${name}.ts`)).catch(() => {});
      await unlink(join(FN_DIR, `${name}.js`)).catch(() => {});
      sendJson(res, { success: true, message: `函数 ${name} 已删除` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, { success: false, error: message }, 500);
    }
    return;
  }

  /** 执行函数（在 Worker 线程中） */
  try {
    /** 路径格式: /functionName 或 /functionName/sub/path */
    const segments = path.slice(1).split('/');
    const name = segments[0];
    const fnPath = join(FN_DIR, `${name}.ts`);

    if (!existsSync(fnPath)) {
      sendJson(res, { error: `函数 ${name} 不存在` }, 404);
      return;
    }

    const body = await readBody(req);
    const startMs = Date.now();
    const result = await executeInWorker(fnPath, {
      method: req.method || 'GET',
      url: req.url || '/',
      path,
      query: url.search,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
    });

    const elapsed = Date.now() - startMs;
    console.log(`[serverless] ${req.method} ${path} -> ${name} ${result.status} ${elapsed}ms`);

    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serverless-host] Serverless Host 已启动: http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
