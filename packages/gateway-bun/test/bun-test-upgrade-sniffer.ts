/**
 * HttpUpgradeSniffer 解析器单元测试
 * 覆盖：完整头/分片/非 upgrade/无 Host/裸 LF/头后 body 字节/超限
 * 运行：bun run test/bun-test-upgrade-sniffer.ts（Bun 版对拍：sniffer 模块与 Node 版逐字节相同，测试逻辑原样复用）
 */

import { HttpUpgradeSniffer, type SniffResult } from '../src/core/upgrade-sniffer.js';
import assert from 'node:assert';

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m' };
function log(msg: string, color = C.reset) { console.log(`${color}${msg}${C.reset}`); }

const results: { name: string; passed: boolean; message?: string }[] = [];

async function runTest(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true });
    log(`  ✓ ${name}`, C.green);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, message });
    log(`  ✗ ${name}: ${message}`, C.red);
  }
}

/** 拼接头字节与剩余字节，验证转发流完整性 */
function fullStream(s: HttpUpgradeSniffer, chunks: Buffer[]): Buffer {
  const emitted: Buffer[] = [];
  for (const c of chunks) {
    const rest = s.feed(c);
    if (s.parsed && rest.length > 0) emitted.push(rest);
  }
  /** 已读但未吐出的部分 = 各 chunk 减去 rest */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return Buffer.concat(emitted);
}

async function main() {
  console.log(`${C.cyan}${'='.repeat(60)}\nHttpUpgradeSniffer 单元测试\n${'='.repeat(60)}${C.reset}`);

  await runTest('1. 完整 WS upgrade 头一次到达', () => {
    const s = new HttpUpgradeSniffer();
    const head = 'GET /ws HTTP/1.1\r\nHost: example.com:1234\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\n\r\n';
    const rest = s.feed(Buffer.from(head));
    assert.ok(s.parsed);
    assert.strictEqual(s.result!.isUpgrade, true);
    assert.strictEqual(s.result!.host, 'example.com:1234');
    assert.strictEqual(rest.length, 0);
    assert.ok(s.result!.headerBytes.toString().endsWith('\r\n\r\n'));
    assert.strictEqual(s.result!.headerBytes.toString(), head);
  });

  await runTest('2. 头分片到达（逐字节喂入）', () => {
    const s = new HttpUpgradeSniffer();
    const head = Buffer.from('GET / HTTP/1.1\r\nHost: h:1\r\nUpgrade: WebSocket\r\n\r\n');
    let parsed = false;
    for (const byte of head) {
      const rest = s.feed(Buffer.from([byte]));
      if (s.parsed) {
        parsed = true;
        assert.strictEqual(rest.length, 0);
      }
    }
    assert.ok(parsed);
    assert.strictEqual(s.result!.isUpgrade, true);
    assert.strictEqual(s.result!.host, 'h:1');
    /** 原始头字节必须逐字节完整 */
    assert.strictEqual(s.result!.headerBytes.toString(), head.toString());
  });

  await runTest('3. 头分片 + 头后 body 字节在同一 chunk', () => {
    const s = new HttpUpgradeSniffer();
    const head = 'POST /x HTTP/1.1\r\nHost: a.b\r\nContent-Length: 5\r\n\r\n';
    const body = 'hello';
    const rest = s.feed(Buffer.from(head + body));
    assert.ok(s.parsed);
    assert.strictEqual(s.result!.isUpgrade, false);
    assert.strictEqual(rest.toString(), body, 'body 字节必须原样返回');
    assert.strictEqual(s.result!.headerBytes.toString(), head);
  });

  await runTest('4. 非 upgrade 普通 HTTP 请求', () => {
    const s = new HttpUpgradeSniffer();
    s.feed(Buffer.from('GET /api HTTP/1.1\r\nHost: x.com\r\nAccept: */*\r\n\r\n'));
    assert.strictEqual(s.result!.isUpgrade, false);
    assert.strictEqual(s.result!.host, 'x.com');
  });

  await runTest('5. 无 Host 头', () => {
    const s = new HttpUpgradeSniffer();
    s.feed(Buffer.from('GET / HTTP/1.0\r\n\r\n'));
    assert.ok(s.parsed);
    assert.strictEqual(s.result!.isUpgrade, false);
    assert.strictEqual(s.result!.host, null);
  });

  await runTest('6. 裸 LF 头结束符（容错）', () => {
    const s = new HttpUpgradeSniffer();
    const rest = s.feed(Buffer.from('GET / HTTP/1.1\nHost: lf-host\nUpgrade: websocket\n\nBODY'));
    assert.ok(s.parsed);
    assert.strictEqual(s.result!.isUpgrade, true);
    assert.strictEqual(s.result!.host, 'lf-host');
    assert.strictEqual(rest.toString(), 'BODY');
  });

  await runTest('7. Upgrade 头大小写不敏感', () => {
    const s = new HttpUpgradeSniffer();
    s.feed(Buffer.from('GET / HTTP/1.1\r\nUPGRADE: WebSocket\r\n\r\n'));
    assert.strictEqual(s.result!.isUpgrade, true);
  });

  await runTest('8. 头字节流零丢失（分片 + body 拼回）', () => {
    const s = new HttpUpgradeSniffer();
    const head = 'GET /ws HTTP/1.1\r\nHost: h:2\r\nUpgrade: websocket\r\n\r\n';
    const chunks = [
      Buffer.from(head.substring(0, 7)),
      Buffer.from(head.substring(7, 20)),
      Buffer.from(head.substring(20)),
      Buffer.from('WS-FRAME-DATA'),
    ];
    const emitted: Buffer[] = [];
    for (const c of chunks) {
      const rest = s.feed(c);
      if (rest.length > 0) emitted.push(rest);
    }
    const emittedBytes = Buffer.concat(emitted).toString();
    assert.strictEqual(emittedBytes, 'WS-FRAME-DATA', '头后字节必须原样吐出');
    /** 头字节完整性 */
    assert.strictEqual(s.result!.headerBytes.toString(), head);
  });

  await runTest('9. 超过缓冲上限（64KB 无头结束符）判定为非 upgrade', () => {
    const s = new HttpUpgradeSniffer();
    s.feed(Buffer.alloc(65 * 1024, 0x61));
    assert.ok(s.parsed);
    assert.strictEqual(s.result!.isUpgrade, false);
    assert.strictEqual(s.result!.host, null);
  });

  await runTest('10. GET 请求行缺失 Host 但有 upgrade（host=null 不误判崩溃）', () => {
    const s = new HttpUpgradeSniffer();
    s.feed(Buffer.from('GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n\r\n'));
    assert.strictEqual(s.result!.isUpgrade, true);
    assert.strictEqual(s.result!.host, null);
  });

  let passed = 0;
  for (const r of results) {
    if (r.passed) passed++;
    log(`${r.passed ? '✓' : '✗'} ${r.name}${r.message ? ` — ${r.message}` : ''}`, r.passed ? C.green : C.red);
  }
  log(`\n结果: ${passed}/${results.length} passed`, passed === results.length ? C.green : C.red);
  process.exit(passed === results.length ? 0 : 1);
}

main();
