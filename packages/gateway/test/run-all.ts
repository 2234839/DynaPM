/**
 * 全量测试入口：串行运行全部 8 个测试套件（端口共享，不能并行）
 */
import { spawnSync } from 'node:child_process';

/** 套件清单（顺序即执行顺序，端口敏感的排前面） */
const suites = [
  'test/test-loader-validation.ts',
  'test/test-correctness-fixes.ts',
  'test/test-timeout-paths.ts',
  'test/test-ws-siyuan.ts',
  'test/test-passthrough.ts',
  'test/test-upgrade-sniffer.ts',
  'test/test-agent-cleanup-bun.ts',
  'test/test-slow-client-bun.ts',
  'test/test-keepwarm.ts',
];

let failed = 0;
for (const suite of suites) {
  console.log(`\n########## ${suite} ##########`);
  const r = spawnSync('bun', ['run', suite], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error(`❌ ${suite} 失败 (exit ${r.status})`);
  }
}
console.log(`\n========== 汇总: ${suites.length - failed}/${suites.length} 套件通过 ==========`);
process.exit(failed > 0 ? 1 : 0);
