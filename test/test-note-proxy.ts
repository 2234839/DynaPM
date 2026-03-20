/**
 * DynaPM 代理思源笔记测试
 *
 * 测试通过 DynaPM 网关纯代理模式访问 https://note.shenzilong.cn
 *
 * 运行方式：
 *   npx dynapm --config dynapm.config.note-test.ts &
 *   npx tsx test/test-note-proxy.ts
 */

import * as http from 'node:http';

/** 颜色输出 */
const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg: string, color = C.reset) {
  console.log(`${color}${msg}${C.reset}`);
}

const PROXY_PORT = 3093;
const TARGET = 'note.shenzilong.cn';

interface TestCase {
  name: string;
  path: string;
  method: string;
  headers?: Record<string, string>;
  expectedStatus?: number;
  checkBody?: (body: string) => boolean;
}

const testCases: TestCase[] = [
  {
    name: '根路径 GET',
    path: '/',
    method: 'GET',
    expectedStatus: 401,
  },
  {
    name: '/assets 路径',
    path: '/assets/',
    method: 'GET',
  },
  {
    name: '/api 路径',
    path: '/api/',
    method: 'GET',
  },
  {
    name: '带查询参数',
    path: '/?query=test&lang=zh',
    method: 'GET',
  },
];

async function makeRequest(tc: TestCase): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; duration: number }> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();

    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: PROXY_PORT,
      path: tc.path,
      method: tc.method,
      headers: {
        'Host': TARGET,
        ...(tc.headers ?? {}),
      },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const duration = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
          duration,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error('请求超时 10s'));
    });
    req.end();
  });
}

async function runTests() {
  log('\n╔══════════════════════════════════════════════╗', C.blue);
  log('║  DynaPM 代理思源笔记测试                    ║', C.blue);
  log('║  代理端口: 3093 → https://note.shenzilong.cn ║', C.blue);
  log('╚══════════════════════════════════════════════╝', C.blue);

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    log(`\n── ${tc.name}: ${tc.method} ${tc.path} ──`, C.cyan);

    try {
      const { status, headers, body, duration } = await makeRequest(tc);
      log(`  状态码: ${status}  耗时: ${duration.toFixed(0)}ms  响应大小: ${body.length} bytes`);

      /** 打印关键响应头 */
      const headerKeys = ['content-type', 'server', 'x-powered-by', 'location'];
      for (const key of headerKeys) {
        if (headers[key]) {
          log(`  响应头 ${key}: ${headers[key]}`, C.yellow);
        }
      }

      if (body.length > 0 && body.length < 500) {
        log(`  响应体: ${body.substring(0, 200)}`, C.yellow);
      } else if (body.length >= 500) {
        log(`  响应体(前200): ${body.substring(0, 200)}...`, C.yellow);
      }

      let ok = true;
      if (tc.expectedStatus && status !== tc.expectedStatus) {
        log(`  期望状态码 ${tc.expectedStatus}，实际 ${status}`, C.red);
        ok = false;
      }
      if (tc.checkBody && !tc.checkBody(body)) {
        log('  响应体校验失败', C.red);
        ok = false;
      }

      if (ok) {
        log('  PASS', C.green);
        passed++;
      } else {
        log('  FAIL', C.red);
        failed++;
      }
    } catch (err) {
      log(`  ERROR: ${(err as Error).message}`, C.red);
      failed++;
    }
  }

  log('\n══════════════════════════════════════════════', C.blue);
  log(`结果: ${passed} passed, ${failed} failed`, failed > 0 ? C.red : C.green);
  log('══════════════════════════════════════════════\n', C.blue);
}

runTests().catch(console.error);
