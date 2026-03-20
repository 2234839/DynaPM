/**
 * 网关代理延迟精确测量
 * 在网关内嵌计时点，通过响应头返回各阶段耗时
 */
import http from 'node:http';

/** 创建一个极简后端，测量直连延迟基线 */
const backend = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Backend': 'ok' });
  res.end('Hello');
});

backend.listen(9993, async () => {
  console.log(`\n=== 网关代理延迟精确测量 ===\n`);

  // 1. 直连基线
  const directSamples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const start = process.hrtime.bigint();
    await new Promise<void>((resolve) => {
      http.request({ hostname: '127.0.0.1', port: 9993, path: '/', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).end();
    });
    directSamples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  directSamples.sort((a, b) => a - b);

  // 2. 通过网关代理（使用 hostname 路由）
  const gatewaySamples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const start = process.hrtime.bigint();
    await new Promise<void>((resolve) => {
      http.request({
        hostname: '127.0.0.1', port: 3090, path: '/echo', method: 'GET',
        headers: { Host: 'echo-host.test' },
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).end();
    });
    gatewaySamples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  gatewaySamples.sort((a, b) => a - b);

  // 3. 通过网关代理（使用端口路由 proxyOnly）
  const portSamples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const start = process.hrtime.bigint();
    await new Promise<void>((resolve) => {
      http.request({ hostname: '127.0.0.1', port: 3092, path: '/echo', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).end();
    });
    portSamples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  portSamples.sort((a, b) => a - b);

  const p = (arr: number[], pct: number) => arr[Math.floor(arr.length * pct / 100)];

  console.log(`样本数: 200 请求/场景\n`);
  console.log(`直连后端 (:9993):`);
  console.log(`  P50: ${p(directSamples, 50).toFixed(3)}ms  P90: ${p(directSamples, 90).toFixed(3)}ms  P99: ${p(directSamples, 99).toFixed(3)}ms`);
  console.log(`\n网关 hostname 路由 (:3090 -> :3099):`);
  console.log(`  P50: ${p(gatewaySamples, 50).toFixed(3)}ms  P90: ${p(gatewaySamples, 90).toFixed(3)}ms  P99: ${p(gatewaySamples, 99).toFixed(3)}ms`);
  console.log(`\n网关端口路由 proxyOnly (:3092 -> :3099):`);
  console.log(`  P50: ${p(portSamples, 50).toFixed(3)}ms  P90: ${p(portSamples, 90).toFixed(3)}ms  P99: ${p(portSamples, 99).toFixed(3)}ms`);
  console.log(`\n网关纯开销 (hostname):`);
  console.log(`  P50: ${(p(gatewaySamples, 50) - p(directSamples, 50)).toFixed(3)}ms`);
  console.log(`  P90: ${(p(gatewaySamples, 90) - p(directSamples, 90)).toFixed(3)}ms`);
  console.log(`\n网关纯开销 (端口路由):`);
  console.log(`  P50: ${(p(portSamples, 50) - p(directSamples, 50)).toFixed(3)}ms`);
  console.log(`  P90: ${(p(portSamples, 90) - p(directSamples, 90)).toFixed(3)}ms`);

  backend.close();
});
