/**
 * 回归套件串行执行器：bun test/run-all.ts
 * 每个套件独立网关 + 独立端口段（3160-3176），串行跑避免端口串扰
 */
import { spawnSync } from "node:child_process";

const suites = [
  "test-core.ts",
  "test-coldstart.ts",
  "test-ws.ts",
  "test-limits.ts",
  "test-admin.ts",
];

let failed = 0;
for (const s of suites) {
  console.log(`\n========== ${s} ==========`);
  const r = spawnSync("bun", [import.meta.dir + "/" + s], { stdio: "inherit" });
  if (r.status !== 0) {
    failed++;
    console.log(`❌ ${s} 失败（exit ${r.status}）`);
  } else {
    console.log(`✅ ${s} 通过`);
  }
}

console.log(`\n========== 汇总: ${suites.length - failed}/${suites.length} 套件通过 ==========`);
process.exit(failed > 0 ? 1 : 0);
