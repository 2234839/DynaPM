/**
 * 万实例真实启停压测（churn test）：与 bench-10k 的 proxyOnly 不同，这里每个服务都带真实
 * startExec 命令，请求到达 → 网关真正 spawn 后端进程 → 健康检查就绪 → 转发；闲置后真正回收。
 *
 * 用法：
 *   bun test/bench-churn-10k.ts --services 10000 --users 100 --duration 120
 *   常驻观察: ... --serve true
 *
 * 架构：
 * - 1 万个服务，每个绑定独立端口，startExec = bun backend.ts <port>（真实进程）
 * - 「用户」流量：N 个协程模拟 N 个人，按 Zipf 分布（少数热门服务 + 大量长尾）随机访问，
 *   命中未启动的服务即触发按需启动（冷启动延迟计入统计）
 * - 「管理员」扰动：固定节奏随机对服务 stop/start，模拟运维侧随机启停
 * - 闲置回收：idleTimeout 后网关自动 kill 进程（观测 running 数量随时间震荡）
 *
 * 观测指标：请求成功率/延迟分位、冷启动次数与耗时、并发存活进程数、网关 RSS、admin API 耗时
 */
import { parseArgs } from "node:util";

/** 命令行参数 */
const {
  values: { services: servicesArg, users: usersArg, duration: durArg, port: portArg, backendPort: beArg, adminRps: adminRpsArg, serve: serveArg },
} = parseArgs({
  options: {
    services: { type: "string", default: "10000" },
    /** 模拟的「人数」：每人一个协程串行访问（人的节奏） */
    users: { type: "string", default: "100" },
    duration: { type: "string", default: "120" },
    port: { type: "string", default: "18080" },
    /** 后端端口段基址：svc i → BE+i（1 万实例占 20000-29999） */
    backendPort: { type: "string", default: "20000" },
    /** 管理员每秒随机 stop/start 次数 */
    adminRps: { type: "string", default: "2" },
    serve: { type: "string", default: "false" },
  },
});

/** 常驻模式：跑完压测不杀进程 */
const SERVE = serveArg === "true";

/** 实例数 */
const N_SERVICES = parseInt(servicesArg!);
/** 模拟用户数 */
const N_USERS = parseInt(usersArg!);
/** 压测时长（秒） */
const DURATION_S = parseInt(durArg!);
/** 网关端口 */
const GW_PORT = parseInt(portArg!);
/** 后端端口基址 */
const BE_BASE = parseInt(beArg!);
/** 管理员扰动频率（次/秒） */
const ADMIN_RPS = parseFloat(adminRpsArg!);

/** Zipf 偏斜指数：1.2 ≈ 真实网站「头部 1% 服务吃掉 ~80% 流量」 */
const ZIPF_ALPHA = 1.2;
/** 闲置回收时间（毫秒）：越短进程周转越快，机器压力越小 */
const IDLE_MS = 5000;
/** 启动健康检查超时（毫秒） */
const START_TIMEOUT_MS = 20000;

const adminHeaders = { Authorization: "Bearer churn-token" };
const WORK_DIR = `/tmp/dynapm-churn-${Date.now()}`;

console.log(`=== DynaPM 万实例真实启停压测 ===`);
console.log(`实例=${N_SERVICES} 用户=${N_USERS} 时长=${DURATION_S}s 管理扰动=${ADMIN_RPS}/s 闲置回收=${IDLE_MS}ms 网关=${GW_PORT}${SERVE ? " 【常驻】" : ""}`);
console.log(`工作目录=${WORK_DIR}\n`);

// ---------- 1. 生成配置：每实例真实 startExec + 独立端口 ----------
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync(`${WORK_DIR}/stats`, { recursive: true });

const backendTs = new URL("./backend.ts", import.meta.url).pathname;

/** 逐实例生成真实启停配置 */
const services: Record<string, unknown> = {};
for (let i = 0; i < N_SERVICES; i++) {
  services[`svc${i}.churn.local`] = {
    base: `http://127.0.0.1:${BE_BASE + i}`,
    host: `svc${i}.churn.local`,
    idleTimeout: IDLE_MS,
    startTimeout: START_TIMEOUT_MS,
    commands: { startExec: ["bun", backendTs, String(BE_BASE + i)] },
  };
}

const config = {
  port: GW_PORT,
  host: "127.0.0.1",
  adminApi: { authToken: "churn-token" },
  stats: { dir: `${WORK_DIR}/stats` },
  services,
};

const configPath = `${WORK_DIR}/dynapm.config.json`;
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`✅ 配置已生成：${configPath}`);

// ---------- 2. 启动网关（后端进程由网关按需 spawn，不预启动） ----------
import { spawn } from "node:child_process";

const gwBin = new URL("../target/release/dynapm", import.meta.url).pathname;
const gw = spawn(gwBin, [], {
  env: { ...process.env, DYNAPM_CONFIG: configPath, RUST_LOG: "warn" },
  stdio: ["ignore", "ignore", "pipe"],
});
gw.stderr!.on("data", (d: Buffer) => {
  const s = d.toString();
  // 启动失败会刷屏，只透传非高频行
  if (!s.includes("start failed") || Math.random() < 0.05) process.stderr.write(`[gw] ${s}`);
});

/** 等网关 admin API 就绪 */
async function waitGateway(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${GW_PORT}/_dynapm/api/info`, {
        headers: adminHeaders,
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return true;
    } catch {}
    await Bun.sleep(300);
  }
  return false;
}

if (!(await waitGateway())) {
  console.error("❌ 网关启动超时");
  process.exit(1);
}
console.log(`✅ 网关已就绪（${N_SERVICES} 实例待命，全部未启动）`);

/** 网关进程 RSS（KB） */
function gwRssKb(): number {
  const status = require("node:fs").readFileSync(`/proc/${gw.pid}/status`, "utf8");
  const m = /VmRSS:\s+(\d+)/.exec(status);
  return m ? parseInt(m[1]!) : 0;
}

/** 当前存活的后端进程数（backend.ts 子进程） */
function liveBackendCount(): number {
  const out = Bun.spawnSync(["pgrep", "-f", "backend\\.ts"]).stdout.toString();
  return out.split("\n").filter(Boolean).length;
}

// ---------- 3. Zipf 访问分布（真实用户：少数服务极热，长尾极冷） ----------
/** 预生成 Zipf 累积分布表，O(logN) 采样 */
const zipfTable = new Float64Array(N_SERVICES);
{
  let sum = 0;
  for (let i = 0; i < N_SERVICES; i++) {
    sum += 1 / Math.pow(i + 1, ZIPF_ALPHA);
    zipfTable[i] = sum;
  }
  for (let i = 0; i < N_SERVICES; i++) zipfTable[i] /= sum;
}

/** 按 Zipf 采样一个服务下标 */
function zipfIndex(): number {
  const r = Math.random();
  let lo = 0, hi = N_SERVICES - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (zipfTable[mid]! < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------- 4. 用户流量（真实启停） ----------
const latencies: number[] = [];
/** 冷启动首请求耗时（>300ms 视为经历了进程 spawn + 健康检查） */
const coldStarts: number[] = [];
let okCount = 0;
let errCount = 0;
const errors = new Map<string, number>();

/** 单个「用户」：串行随机访问，节奏接近真人（请求间偶尔停顿） */
async function userWorker(until: number): Promise<void> {
  while (Date.now() < until) {
    const i = zipfIndex();
    const host = `svc${i}.churn.local`;
    const t0 = performance.now();
    try {
      const r = await fetch(`http://127.0.0.1:${GW_PORT}/`, {
        headers: { Host: host },
        signal: AbortSignal.timeout(START_TIMEOUT_MS + 5000),
      });
      await r.text();
      const dt = performance.now() - t0;
      latencies.push(dt);
      if (dt > 300) coldStarts.push(dt);
      if (r.ok) okCount++;
      else {
        errCount++;
        errors.set(`${r.status}`, (errors.get(`${r.status}`) ?? 0) + 1);
      }
    } catch (e) {
      errCount++;
      const msg = e instanceof Error ? e.message.slice(0, 40) : "unknown";
      errors.set(msg, (errors.get(msg) ?? 0) + 1);
    }
    // 真人节奏：5% 概率停顿 1-3s
    if (Math.random() < 0.05) await Bun.sleep(1000 + Math.random() * 2000);
  }
}

// ---------- 5. 管理员扰动：随机 stop/start ----------
let adminOps = 0;
let adminErrs = 0;

/** 管理员 worker：每秒 ADMIN_RPS 次，随机挑实例 stop，2s 后 start 回来 */
async function adminChurn(until: number): Promise<void> {
  const interval = 1000 / ADMIN_RPS;
  while (Date.now() < until) {
    const i = (Math.random() * N_SERVICES) | 0;
    const name = `svc${i}.churn.local`;
    const enc = encodeURIComponent(name);
    try {
      await fetch(`http://127.0.0.1:${GW_PORT}/_dynapm/api/services/${enc}/stop`, {
        method: "POST",
        headers: adminHeaders,
        signal: AbortSignal.timeout(10000),
      });
      adminOps++;
      // 2 秒后拉回来（如果期间的流量已经把它拉起来了，start 是幂等的）
      await Bun.sleep(2000);
      if (Date.now() >= until) break;
      await fetch(`http://127.0.0.1:${GW_PORT}/_dynapm/api/services/${enc}/start`, {
        method: "POST",
        headers: adminHeaders,
        signal: AbortSignal.timeout(START_TIMEOUT_MS + 5000),
      });
      adminOps++;
    } catch {
      adminErrs++;
    }
    await Bun.sleep(interval);
  }
}

// ---------- 6. 观测采样：进程数 / 网关 RSS / admin API 延迟 ----------
interface Sample {
  /** 距压测开始的秒数 */
  t: number;
  backends: number;
  rssMb: number;
  adminMs: number;
}
const samples: Sample[] = [];

async function sampler(until: number, startedAt: number): Promise<void> {
  while (Date.now() < until) {
    const t0 = performance.now();
    let adminMs = 0;
    try {
      const r = await fetch(`http://127.0.0.1:${GW_PORT}/_dynapm/api/services?epoch=999999`, {
        headers: adminHeaders,
        signal: AbortSignal.timeout(30000),
      });
      await r.text();
      adminMs = performance.now() - t0;
    } catch {}
    samples.push({
      t: Math.round((Date.now() - startedAt) / 1000),
      backends: liveBackendCount(),
      rssMb: Math.round(gwRssKb() / 1024),
      adminMs: Math.round(adminMs),
    });
    await Bun.sleep(3000);
  }
}

// ---------- 7. 跑压测 ----------
console.log(`\n🚦 开始压测 ${DURATION_S}s（前 ~15s 为冷启动爬坡期，属预期）\n`);
const until = Date.now() + DURATION_S * 1000;
const startedAt = Date.now();

/** 每隔一段时间打印进程数水位 */
const waveTimer = setInterval(() => {
  console.log(`  ⏱ ${Math.round((DURATION_S * 1000 - (until - Date.now())) / 1000)}s  存活后端进程=${liveBackendCount()}  网关RSS=${Math.round(gwRssKb() / 1024)}MB  ok=${okCount} err=${errCount}`);
}, 10000);

await Promise.all([
  ...Array.from({ length: N_USERS }, () => userWorker(until)),
  adminChurn(until),
  sampler(until, startedAt),
]);
clearInterval(waveTimer);

// ---------- 8. 汇总 ----------
function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

const total = okCount + errCount;
const peakBackends = Math.max(...samples.map((s) => s.backends), 0);
const peakRss = Math.max(...samples.map((s) => s.rssMb), 0);

console.log(`\n========== 压测结果 ==========`);
console.log(`请求: ${total} 次（ok=${okCount} err=${errCount}，成功率=${total ? ((okCount / total) * 100).toFixed(2) : 0}%）`);
console.log(`延迟: p50=${pct(latencies, 50).toFixed(0)}ms p90=${pct(latencies, 90).toFixed(0)}ms p99=${pct(latencies, 99).toFixed(0)}ms`);
console.log(`冷启动: ${coldStarts.length} 次（>300ms 首请求），耗时 p50=${pct(coldStarts, 50).toFixed(0)}ms p99=${pct(coldStarts, 99).toFixed(0)}ms`);
console.log(`并发存活后端进程: 峰值=${peakBackends}（实例数 ${N_SERVICES} 的 ${((peakBackends / N_SERVICES) * 100).toFixed(1)}%）`);
console.log(`网关 RSS: 峰值=${peakRss}MB`);
console.log(`管理扰动: ${adminOps} 次 stop/start，失败=${adminErrs}`);
console.log(`admin services API: p50=${pct(samples.map((s) => s.adminMs), 50).toFixed(0)}ms p99=${pct(samples.map((s) => s.adminMs), 99).toFixed(0)}ms`);
if (errors.size) {
  console.log(`错误分布:`, [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
}

/** 进程数量随时间曲线（看回收是否稳定，无泄漏则曲线震荡不上涨） */
console.log(`\n存活进程数时间线（每采样 ≈3s）:`);
console.log(samples.map((s) => `${s.t}s:${s.backends}`).join("  "));

// ---------- 9. 清理 ----------
function cleanup(): void {
  if (SERVE) {
    console.log(`\n常驻模式：网关 pid=${gw.pid} 不退出（后端进程由闲置回收自动清理）`);
    console.log(`👉 管理面板: http://127.0.0.1:${GW_PORT}/_dynapm/panel （令牌: churn-token）`);
    gw.unref();
    return;
  }
  console.log(`\n清理：kill 网关 ${gw.pid} + 残留后端进程`);
  gw.kill("SIGKILL");
  Bun.spawnSync(["pkill", "-f", "backend\\.ts"]);
  console.log(`✅ 已清理`);
}
cleanup();
if (!SERVE) process.exit(errCount > total * 0.1 ? 1 : 0);
