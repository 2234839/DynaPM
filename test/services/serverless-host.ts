/**
 * DynaPM Serverless Host - 演示程序
 *
 * 一个轻量级 TypeScript Serverless 运行时：
 * - 通过 Web 界面编写和上传 TS 函数
 * - 请求自动路由到对应的 TS 函数执行
 * - 支持 HTTP 请求/响应
 * - 可被 DynaPM 管理运行
 *
 * 路由规则：
 * - GET  /              -> Web 管理界面
 * - GET  /_fn/list       -> 列出所有函数
 * - POST /_fn/upload     -> 上传/更新函数
 * - DELETE /_fn/:name    -> 删除函数
 * - *    /:functionName  -> 执行对应的函数
 */

import * as http from 'node:http';
import { URL } from 'node:url';
import { writeFile, unlink, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const PORT = parseInt(process.argv[2] || '4000');
const FN_DIR = join(process.cwd(), '.serverless-fn');

/** 确保函数目录存在 */
await mkdir(FN_DIR, { recursive: true });

/** 函数运行时缓存 */
const fnCache = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse, body: string, path: string) => Promise<void>>();

/** 加载 TS 函数（利用 Node 24 --experimental-strip-types 直接加载 TS） */
async function loadFunction(name: string): Promise<void> {
  const tsPath = join(FN_DIR, `${name}.ts`);

  if (!existsSync(tsPath)) {
    throw new Error(`函数 ${name} 不存在`);
  }

  /** 清除缓存 */
  fnCache.delete(name);

  const mod = await import(`file://${tsPath}?t=${Date.now()}`);
  if (!mod.default || typeof mod.default !== 'function') {
    throw new Error(`函数 ${name} 必须导出默认函数`);
  }

  fnCache.set(name, mod.default);
}

/** 执行函数 */
async function executeFunction(name: string, req: http.IncomingMessage, res: http.ServerResponse, body: string, path: string): Promise<void> {
  if (!fnCache.has(name)) {
    await loadFunction(name);
  }

  const fn = fnCache.get(name)!;
  await fn(req, res, body, path);
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

/** Web 管理界面 HTML */
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DynaPM Serverless Host</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: #0d1117; color: #c9d1d9; min-height: 100vh; }
    .container { max-width: 960px; margin: 0 auto; padding: 20px; }
    h1 { color: #58a6ff; margin-bottom: 4px; font-size: 24px; }
    .subtitle { color: #8b949e; margin-bottom: 20px; }
    .panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .panel h2 { color: #58a6ff; font-size: 16px; margin-bottom: 12px; }
    label { color: #8b949e; font-size: 13px; display: block; margin-bottom: 4px; }
    input[type="text"] { width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-family: monospace; font-size: 14px; margin-bottom: 12px; }
    textarea { width: 100%; height: 300px; padding: 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-family: 'Fira Code', monospace; font-size: 13px; resize: vertical; tab-size: 2; }
    .btn { padding: 8px 20px; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; cursor: pointer; font-size: 14px; margin-right: 8px; }
    .btn-primary { background: #238636; border-color: #238636; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { background: #da3633; border-color: #da3633; }
    .btn-danger:hover { background: #f85149; }
    .fn-list { list-style: none; }
    .fn-list li { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid #21262d; }
    .fn-list li:last-child { border-bottom: none; }
    .fn-name { color: #58a6ff; font-family: monospace; }
    .fn-path { color: #8b949e; font-size: 12px; }
    .fn-actions { display: flex; gap: 8px; }
    .fn-actions button { padding: 4px 10px; font-size: 12px; }
    .result { margin-top: 12px; padding: 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; font-family: monospace; font-size: 13px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; display: none; }
    .result.success { border-color: #238636; color: #3fb950; }
    .result.error { border-color: #da3633; color: #f85149; }
    .template { color: #8b949e; font-size: 12px; margin-top: 8px; cursor: pointer; }
    .template:hover { color: #58a6ff; }
  </style>
</head>
<body>
  <div class="container">
    <h1>DynaPM Serverless Host</h1>
    <p class="subtitle">轻量级 TypeScript Serverless 运行时 - 编写函数，即时执行</p>

    <div class="panel">
      <h2>编写函数</h2>
      <label>函数名称（仅字母数字和连字符）</label>
      <input type="text" id="fnName" placeholder="hello" />
      <label>函数代码（导出 default 处理函数）</label>
      <textarea id="fnCode" spellcheck="false">// 函数签名: (req, res, body, path) => Promise<void>
// req: http.IncomingMessage
// res: http.ServerResponse
// body: string (请求体)
// path: string (请求路径，含查询参数)
export default async function(req, res, body, path) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Hello from Serverless!', path, method: req.method }));
}</textarea>
      <div style="display: flex; align-items: center; gap: 12px; margin-top: 8px;">
        <button class="btn btn-primary" onclick="uploadFn()">保存并部署</button>
        <button class="btn" onclick="testFn()">测试执行</button>
        <span class="template" onclick="loadTemplate('hello')">[ hello 模板 ]</span>
        <span class="template" onclick="loadTemplate('echo')">[ echo 模板 ]</span>
        <span class="template" onclick="loadTemplate('time')">[ time 模板 ]</span>
      </div>
      <div id="result" class="result"></div>
    </div>

    <div class="panel">
      <h2>已部署函数</h2>
      <ul id="fnList" class="fn-list"></ul>
    </div>

    <div class="panel">
      <h2>使用方式</h2>
      <p style="color: #8b949e; font-size: 13px; line-height: 1.6;">
        1. 编写函数代码并保存<br>
        2. 访问 <code style="color: #58a6ff;">http://host:port/hello</code> 执行函数<br>
        3. 支持 GET/POST/PUT/DELETE 等所有 HTTP 方法<br>
        4. 函数通过 DynaPM 按需启动，闲置自动停止
      </p>
    </div>
  </div>

  <script>
    const API = '';
    const templates = {
      hello: \`export default async function(req, res, body, path) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Hello from Serverless!', path, method: req.method }));
}\`,
      echo: \`export default async function(req, res, body, path) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ method: req.method, path, headers: Object.fromEntries(Object.entries(req.headers).slice(0, 10)), body }));
}\`,
      time: \`export default async function(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ timestamp: Date.now(), iso: new Date().toISOString() }));
}\`,
    };

    function showResult(text, type) {
      const el = document.getElementById('result');
      el.textContent = text;
      el.className = 'result ' + type;
      el.style.display = 'block';
    }

    async function uploadFn() {
      const name = document.getElementById('fnName').value.trim();
      const code = document.getElementById('fnCode').value;
      if (!name) { showResult('请输入函数名称', 'error'); return; }
      if (!code) { showResult('请输入函数代码', 'error'); return; }

      try {
        const r = await fetch(API + '/_fn/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code }) });
        const data = await r.json();
        showResult(data.success ? '函数已部署: /' + name : '部署失败: ' + data.error, data.success ? 'success' : 'error');
        if (data.success) loadFnList();
      } catch (e) { showResult('请求失败: ' + e.message, 'error'); }
    }

    async function testFn() {
      const name = document.getElementById('fnName').value.trim();
      if (!name) { showResult('请输入函数名称', 'error'); return; }
      try {
        const r = await fetch(API + '/' + name);
        const text = await r.text();
        showResult('Status: ' + r.status + '\\n' + text, r.status === 200 ? 'success' : 'error');
      } catch (e) { showResult('请求失败: ' + e.message, 'error'); }
    }

    async function deleteFn(name) {
      if (!confirm('确定删除函数 ' + name + '?')) return;
      try {
        const r = await fetch(API + '/_fn/' + name, { method: 'DELETE' });
        const data = await r.json();
        showResult(data.success ? '函数已删除' : '删除失败', data.success ? 'success' : 'error');
        loadFnList();
      } catch (e) { showResult('请求失败: ' + e.message, 'error'); }
    }

    function loadTemplate(name) {
      document.getElementById('fnName').value = name;
      document.getElementById('fnCode').value = templates[name] || '';
    }

    async function loadFnList() {
      try {
        const r = await fetch(API + '/_fn/list');
        const data = await r.json();
        const list = document.getElementById('fnList');
        list.innerHTML = data.functions.length === 0 ? '<li style="color: #8b949e;">暂无函数</li>' : data.functions.map(fn => '<li><span><span class="fn-name">' + fn.name + '</span> <span class="fn-path">' + fn.path + '</span></span><span class="fn-actions"><button class="btn" onclick="testFnByName(\\'' + fn.name + '\\')">测试</button><button class="btn btn-danger" onclick="deleteFn(\\'' + fn.name + '\\')">删除</button></span></li>').join('');
      } catch (e) { console.error(e); }
    }

    function testFnByName(name) {
      document.getElementById('fnName').value = name;
      testFn();
    }

    loadFnList();
  </script>
</body>
</html>`;

/** 读取请求体 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
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

  /** 管理界面 */
  if (path === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }

  /** 列出函数 */
  if (path === '/_fn/list' && req.method === 'GET') {
    const functions = await listFunctions();
    sendJson(res, { functions });
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

      /** 清除缓存以便重新加载 */
      fnCache.delete(name);

      /** 保存源文件 */
      const tsPath = join(FN_DIR, `${name}.ts`);
      await writeFile(tsPath, code);
      await loadFunction(name);

      sendJson(res, { success: true, message: `函数 /${name} 已部署` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, { success: false, error: message }, 500);
    }
    return;
  }

  /** 删除函数 */
  if (path.startsWith('/_fn/') && req.method === 'DELETE') {
    const name = path.slice(5);
    if (!name) {
      sendJson(res, { success: false, error: '缺少函数名称' }, 400);
      return;
    }

    try {
      fnCache.delete(name);
      await unlink(join(FN_DIR, `${name}.ts`)).catch(() => {});
      await unlink(join(FN_DIR, `${name}.js`)).catch(() => {});
      sendJson(res, { success: true, message: `函数 ${name} 已删除` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, { success: false, error: message }, 500);
    }
    return;
  }

  /** 执行函数 */
  try {
    const name = path.slice(1);
    const body = await readBody(req);

    if (!fnCache.has(name)) {
      await loadFunction(name);
    }

    await executeFunction(name, req, res, body, path);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, () => {
  console.log(`[serverless-host] Serverless Host 已启动: http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
