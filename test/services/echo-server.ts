/**
 * Echo 测试服务器 - 完整功能的后端服务
 * 支持验证请求头、请求体、各种 HTTP 方法、延迟响应、流式响应
 */

import uWS from 'uWebSockets.js';

const PORT = parseInt(process.argv[2] || '3099');

const app = uWS.App({});

/** 处理 HTTP 请求 */
app.any('/*', (res, req) => {
  const url = req.getUrl();
  const method = req.getMethod();
  const query = req.getQuery();

  /** 收集请求头 */
  const headers: Record<string, string> = {};
  req.forEach((key: string, value: string) => {
    headers[key] = value;
  });

  /** 收集请求体 */
  let body = '';
  res.onData((ab: ArrayBuffer, isLast: boolean) => {
    body += Buffer.from(ab).toString();
    if (isLast) {
      handleRequest(res, method, url, query, headers, body);
    }
  });

  res.onAborted(() => {
    // 客户端断开，忽略
  });
});

function handleRequest(res: uWS.HttpResponse, method: string, url: string, query: string, headers: Record<string, string>, body: string) {
  /** 解析查询参数 */
  const params: Record<string, string> = {};
  if (query) {
    for (const pair of query.split('&')) {
      const [key, value] = pair.split('=');
      if (key) {
        params[decodeURIComponent(key)] = decodeURIComponent(value || '');
      }
    }
  }

  /** 根据路径路由 */
  if (url === '/echo') {
    handleEcho(res, method, headers, body, params);
  } else if (url === '/delay') {
    handleDelay(res, params);
  } else if (url === '/stream') {
    handleStream(res, params);
  } else if (url === '/status') {
    handleStatus(res, params);
  } else if (url === '/headers') {
    handleHeaders(res, headers);
  } else if (url === '/chunked') {
    handleChunked(res, params);
  } else if (url === '/big-body') {
    handleBigBody(res, method, body);
  } else {
    handleDefault(res, method, url);
  }
}

/** Echo 端点：返回请求的详细信息 */
function handleEcho(res: uWS.HttpResponse, method: string, headers: Record<string, string>, body: string, params: Record<string, string>) {
  const responseBody = JSON.stringify({
    method,
    url: '/echo',
    headers,
    body,
    params,
    bodyLength: body.length,
  });

  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', 'application/json');
    res.writeHeader('X-Echo-Method', method);
    res.writeHeader('X-Echo-Body-Length', String(body.length));
    res.end(responseBody);
  });
}

/** 延迟响应端点 */
function handleDelay(res: uWS.HttpResponse, params: Record<string, string>) {
  const delay = parseInt(params.delay || '100');

  setTimeout(() => {
    res.cork(() => {
      res.writeStatus('200 OK');
      res.writeHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ delayed: true, delay }));
    });
  }, delay);
}

/** 流式响应端点：分块发送数据 */
function handleStream(res: uWS.HttpResponse, params: Record<string, string>) {
  const chunks = parseInt(params.chunks || '5');
  const interval = parseInt(params.interval || '100');
  const chunkSize = parseInt(params.chunkSize || '100');
  let sent = 0;
  let aborted = false;

  res.onAborted(() => {
    aborted = true;
  });

  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', 'text/plain');
    res.writeHeader('X-Stream-Total', String(chunks));
  });

  let ended = false;
  const timer = setInterval(() => {
    if (aborted || ended) {
      clearInterval(timer);
      return;
    }

    sent++;
    const data = `chunk-${sent}:${'x'.repeat(chunkSize)}\n`;

    res.cork(() => {
      if (aborted || ended) return;
      res.write(data);
      if (sent >= chunks) {
        ended = true;
        res.end();
      }
    });

    if (ended) {
      clearInterval(timer);
    }
  }, interval);
}

/** 自定义状态码端点 */
function handleStatus(res: uWS.HttpResponse, params: Record<string, string>) {
  const code = parseInt(params.code || '200');
  const messages: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error',
    502: 'Bad Gateway', 503: 'Service Unavailable',
  };
  const message = messages[code] || 'Unknown';

  res.cork(() => {
    res.writeStatus(`${code} ${message}`);
    res.writeHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: code, message }));
  });
}

/** 请求头回显端点 */
function handleHeaders(res: uWS.HttpResponse, headers: Record<string, string>) {
  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ headers }));
  });
}

/** 分块传输端点 */
function handleChunked(res: uWS.HttpResponse, params: Record<string, string>) {
  const count = parseInt(params.count || '3');
  const size = parseInt(params.size || '100');

  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', 'application/octet-stream');
    res.writeHeader('X-Chunk-Count', String(count));
    res.writeHeader('X-Chunk-Size', String(size));
  });

  let sent = 0;
  let ended = false;
  const sendChunk = () => {
    if (ended) return;

    if (sent >= count) {
      ended = true;
      res.cork(() => {
        res.end();
      });
      return;
    }

    sent++;
    const chunk = Buffer.alloc(size, sent % 256);
    res.cork(() => {
      if (ended) return;
      res.write(chunk);
    });

    if (!ended) {
      setTimeout(sendChunk, 0);
    }
  };

  sendChunk();
}

/** 大请求体处理端点 */
function handleBigBody(res: uWS.HttpResponse, method: string, body: string) {
  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      method,
      bodyLength: body.length,
      firstBytes: body.substring(0, 100),
      lastBytes: body.substring(body.length - 100),
    }));
  });
}

/** 默认响应 */
function handleDefault(res: uWS.HttpResponse, method: string, url: string) {
  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', 'text/plain');
    res.end(`Default response from echo server: ${method} ${url}`);
  });
}

app.listen('127.0.0.1', PORT, (token) => {
  if (token) {
    console.log(`[echo-server] Echo 测试服务器已启动: http://127.0.0.1:${PORT}`);
  } else {
    console.error(`[echo-server] 服务启动失败，端口 ${PORT}`);
    process.exit(1);
  }
});
