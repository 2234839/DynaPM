/**
 * loader 快速失败校验测试：commands.check 必须存在且为非空字符串
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTest, summarizeAndExit, assert, type TestResult } from './helpers.js';

/** 测试结果收集 */
const results: TestResult[] = [];

/**
 * 写一个临时配置文件并加载，返回加载结果或抛出的错误
 */
async function loadFromConfig(configText: string): Promise<{ error?: Error }> {
  const dir = await mkdtemp(join(tmpdir(), 'dynapm-loader-test-'));
  try {
    const file = join(dir, 'dynapm.config.json');
    await writeFile(file, configText);
    process.env.DYNAPM_CONFIG = file;
    const { loadDynaPMConfig } = await import(`../src/config/loader.js?t=${Date.now()}-${Math.random()}`);
    await loadDynaPMConfig();
    return {};
  } catch (err: unknown) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    delete process.env.DYNAPM_CONFIG;
    await rm(dir, { recursive: true, force: true });
  }
}

/** 合法服务的最小配置片段模板 */
function serviceWithCheck(check: string): string {
  return JSON.stringify({
    port: 39000,
    adminApi: { enabled: false },
    services: {
      demo: {
        base: 'http://127.0.0.1:39001',
        host: 'demo.test',
        commands: { start: 'echo start', stop: 'echo stop', check },
      },
    },
  });
}

await runTest('缺失 commands.check 时抛出错误', async () => {
  const config = JSON.stringify({
    port: 39010,
    adminApi: { enabled: false },
    services: {
      demo: {
        base: 'http://127.0.0.1:39011',
        host: 'demo.test',
        commands: { start: 'echo start', stop: 'echo stop' },
      },
    },
  });
  const { error } = await loadFromConfig(config);
  assert(!!error, `应当抛出错误，实际: ${JSON.stringify(error)}`);
  assert((error?.message ?? '').includes('commands.check'), `错误信息应含 commands.check: ${error?.message}`);
  assert((error?.message ?? '').includes('demo'), `错误信息应含服务名: ${error?.message}`);
}, results);

await runTest('commands.check 为空串时抛出错误', async () => {
  const { error } = await loadFromConfig(serviceWithCheck(''));
  assert(!!error, `应当抛出错误，实际: ${JSON.stringify(error)}`);
  assert((error?.message ?? '').includes('commands.check'), `错误信息应含 commands.check: ${error?.message}`);
}, results);

await runTest('commands.check 为非字符串时抛出错误', async () => {
  const config = JSON.stringify({
    port: 39015,
    adminApi: { enabled: false },
    services: {
      demo: {
        base: 'http://127.0.0.1:39016',
        host: 'demo.test',
        commands: { start: 'echo start', stop: 'echo stop', check: 123 },
      },
    },
  });
  const { error } = await loadFromConfig(config);
  assert(!!error, `应当抛出错误，实际: ${JSON.stringify(error)}`);
  assert((error?.message ?? '').includes('commands.check'), `错误信息应含 commands.check: ${error?.message}`);
}, results);

await runTest('合法配置正常通过', async () => {
  const { error } = await loadFromConfig(serviceWithCheck('echo ok'));
  assert(!error, `合法配置不应抛错: ${error?.message}`);
}, results);

await runTest('错误信息包含 service name', async () => {
  const config = JSON.stringify({
    port: 39020,
    adminApi: { enabled: false },
    services: {
      myApp: {
        base: 'http://127.0.0.1:39021',
        host: 'myapp.test',
        commands: { start: 'echo start', stop: 'echo stop', check: '   ' },
      },
    },
  });
  const { error } = await loadFromConfig(config);
  assert(!!error, '应当抛出错误');
  assert((error?.message ?? '').includes('myApp'), `错误信息应含 myApp: ${error?.message}`);
}, results);

summarizeAndExit(results);
