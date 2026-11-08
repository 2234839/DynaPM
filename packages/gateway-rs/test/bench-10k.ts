/**
 * 万级服务压测：生成 N 个服务的配置 → 启动网关 → 随机访问客户端 → 管理面板负载量化
 *
 * 用法：
 *   bun test/bench-10k.ts --services 10000 --concurrency 50 --duration 60
 *
 * 架构：
 * - 后端服务：一个 Bun 进程监听一个端口，按 Host 头区分「服务」（零进程开销，瓶颈聚焦网关本身）
 * - 客户端：多协程随机挑选服务域名发请求，经网关转发
 * - 管理面：并发拉 /api/services 与 /api/stats，量化响应体大小与耗时
 *
 * 注意：10k 服务全部 proxyOnly（不真正拉起进程），排除进程管理噪声，只测网关转发 + 管理 API
 */
import { parseArgs } from "node:util";

/** 命令行参数 */
const {
  values: { services: servicesArg, concurrency: concArg, duration: durArg, port: portArg, backendPort: backendPortArg, serve: serveArg },
} = parseArgs({
  options: {
    services: { type: "string", default: "10000" },
    concurrency: { type: "string", default: "50" },
    duration: { type: "string", default: "60" },
    port: { type: "string", default: "18080" },
    backendPort: { type: "string", default: "18081" },
    /** 压测结束后保持网关/后端运行，供浏览器打开面板观察（进程不被 kill，脚本退出） */
    serve: { type: "string", default: "false" },
  },
});

/** 常驻模式：跑完压测不杀进程 */
const SERVE = serveArg === "true";

/** 压测服务数 */
const N_SERVICES = parseInt(servicesArg!);
/** 客户端并发协程数 */
const CONCURRENCY = parseInt(concArg!);
/** 压测时长（秒） */
const DURATION_S = parseInt(durArg!);
/** 网关主端口 */
const GW_PORT = parseInt(portArg!);
/** 后端单进程端口 */
const BE_PORT = parseInt(backendPortArg!);
/** admin API 请求头（不设 adminApi.host 时回环直接放行，无需 Host 伪装） */
const adminHeaders = { Authorization: "Bearer bench-token" };

/** 配置与统计文件目录（独立临时目录，不污染真实部署） */
const WORK_DIR = `/tmp/dynapm-bench-${Date.now()}`;

console.log(`=== DynaPM 万级服务压测 ===`);
console.log(`服务数=${N_SERVICES} 并发=${CONCURRENCY} 时长=${DURATION_S}s 网关=${GW_PORT} 后端=${BE_PORT}${SERVE ? " 【常驻模式：跑完可在浏览器看面板】" : ""}`);
console.log(`工作目录=${WORK_DIR}\n`);

// ---------- 1. 生成测试配置 ----------
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync(`${WORK_DIR}/stats`, { recursive: true });

/** 逐服务生成 proxyOnly 路由：svc<i>.bench.local → 同一个后端进程 */
const services: Record<string, unknown> = {};
for (let i = 0; i < N_SERVICES; i++) {
  services[`svc${i}.bench.local`] = {
    base: `http://127.0.0.1:${BE_PORT}`,
    host: `svc${i}.bench.local`,
    proxyOnly: true,
  };
}

/** 网关配置：主端口 + 统计持久化；不设 adminApi.host（本机回环天然放行 /_dynapm，面板可直接访问） */
const config = {
  port: GW_PORT,
  host: "127.0.0.1",
  adminApi: { authToken: "bench-token" },
  stats: { dir: `${WORK_DIR}/stats` },
  services,
};

const configPath = `${WORK_DIR}/dynapm.config.json`;
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`✅ 配置已生成：${configPath}（${(JSON.stringify(config).length / 1024 / 1024).toFixed(1)} MB）`);

// ---------- 2. 启动后端服务（单进程按 Host 回显） ----------
const backend = Bun.serve({
  port: BE_PORT,
  fetch: async (req) => {
    const host = new URL(req.url).hostname;
    // 模拟真实后端的一点工作 + 响应体
    await Bun.sleep(2);
    return new Response(`ok from ${host}`, { headers: { "content-type": "text/plain" } });
  },
});
console.log(`✅ 后端服务：127.0.0.1:${BE_PORT}`);

// ---------- 3. 启动网关 ----------
import { spawn } from "node:child_process";

const gwBin = new URL("../target/release/dynapm", import.meta.url).pathname;
const gw = spawn(gwBin, [], {
  env: { ...process.env, DYNAPM_CONFIG: configPath, RUST_LOG: "warn" },
  stdio: ["ignore", "ignore", "pipe"],
});
gw.stderr!.on("data", (d: Buffer) => process.stderr.write(`[gw] ${d}`));

/** 等网关 admin API 就绪 */
async function waitGateway(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${GW_PORT}/_dynapm/api/services`, {
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
console.log(`✅ 网关已就绪（加载 ${N_SERVICES} 服务配置）`);

/** 网关进程内存（RSS KB） */
function gwRssKb(): number {
  const status = require("node:fs").readFileSync(`/proc/${gw.pid}/status`, "utf8");
  const m = /VmRSS:\s+(\d+)/.exec(status);
  return m ? parseInt(m[1]!) : 0;
}

// ---------- 4. 随机访问客户端 ----------
const serviceNames = Array.from({ length: N_SERVICES }, (_, i) => `svc${i}.bench.local`);

/** 随机服务 Host 头 */
function randomHost(): string {
  return serviceNames[(Math.random() * N_SERVICES) | 0]!;
}

const latencies: number[] = [];
let okCount = 0;
let errCount = 0;
const errors = new Map<string, number>();

async function worker(until: number): Promise<void> {
  while (Date.now() < until) {
    const host = randomHost();
    const t0 = performance.now();
    try {
      const r = await fetch(`http://127.0.0.1:${GW_PORT}/`, {
        headers: { Host: host },
        signal: AbortSignal.timeout(10000),
      });
      await r.text();
      const dt = performance.now() - t0;
      latencies.push(dt);
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
  }
}

// ---------- 5. 管理面板负载模拟（与真实面板同节奏） ----------
/** 管理面板一次轮询的体积与耗时 */
interface AdminPollStat {
  path: string;
  bytes: number;
  ms: number;
}
const adminPolls: AdminPollStat[] = [];

async function adminPoller(until: number): Promise<void> {
  while (Date.now() < until) {
    for (const path of ["/_dynapm/api/services", "/_dynapm/api/stats"]) {
      const t0 = performance.now();
      try {
        const r = await fetch(`http://127.0.0.1:${GW_PORT}${path}`, {
          headers: adminHeaders,
          signal: AbortSignal.timeout(60000),
        });
        const body = await r.text();
        adminPolls.push({ path, bytes: body.length, ms: performance.now() - t0 });
      } catch (e) {
        adminPolls.push({ path, bytes: 0, ms: performance.now() - t0 });
      }
    }
    // 模拟面板节奏：5s services + 30s stats（这里统一 5s 间隔做最坏估计）
    await Bun.sleep(5000);
  }
}

// ---------- 6. 跑压测 ----------
console.log(`\n▶ 压测开始（${DURATION_S}s）...\n`);
const rssBefore = gwRssKb();
const until = Date.now() + DURATION_S * 1000;
const workers = Array.from({ length: CONCURRENCY }, () => worker(until));
const pollers = [adminPoller(until)];

/** 进度打印协程 */
async function progress(): Promise<void> {
  let elapsed = 0;
  while (elapsed < DURATION_S) {
    await Bun.sleep(10000);
    elapsed += 10;
    const rss = gwRssKb();
    const done = adminPolls.length;
    const lastSvc = adminPolls.filter((p) => p.path.includes("services")).at(-1);
    const lastStats = adminPolls.filter((p) => p.path.includes("stats")).at(-1);
    console.log(
      `[${elapsed}s] reqs=${okCount + errCount} ok=${okCount} err=${errCount} gwRSS=${(rss / 1024).toFixed(0)}MB | services响应=${lastSvc ? `${(lastSvc.bytes / 1024 / 1024).toFixed(1)}MB/${lastSvc.ms.toFixed(0)}ms` : "..."} stats响应=${lastStats ? `${(lastStats.bytes / 1024 / 1024).toFixed(1)}MB/${lastStats.ms.toFixed(0)}ms` : "..."} admin轮询累计=${done}`,
    );
  }
}
await Promise.race([Promise.all([progress()]), Promise.all([...workers, ...pollers])]);

// ---------- 7. 汇总 ----------
console.log(`\n=== 压测结果 ===`);
const sorted = latencies.sort((a, b) => a - b);
const pct = (p: number) => (sorted.length ? sorted[Math.floor(sorted.length * p)]!.toFixed(1) : "-");
const totalReqs = okCount + errCount;
console.log(`总请求: ${totalReqs} (${(totalReqs / DURATION_S).toFixed(0)} req/s)  成功=${okCount} 失败=${errCount}`);
console.log(`延迟 p50=${pct(0.5)}ms  p90=${pct(0.9)}ms  p99=${pct(0.99)}ms`);
if (errors.size) {
  console.log(`错误分布:`, [...errors.entries()].map(([k, v]) => `${k}×${v}`).join(" "));
}

const svcPolls = adminPolls.filter((p) => p.path.includes("services"));
const statsPolls = adminPolls.filter((p) => p.path.includes("stats"));
const avg = (arr: number[]) => (arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(0) : "-");
console.log(`\n--- 管理面板负载（${N_SERVICES} 服务）---`);
console.log(`/api/services: ${svcPolls.length} 次  平均体积=${(svcPolls.reduce((a, p) => a + p.bytes, 0) / Math.max(svcPolls.length, 1) / 1024 / 1024).toFixed(1)}MB  平均耗时=${avg(svcPolls.map((p) => p.ms))}ms  最大耗时=${Math.max(...svcPolls.map((p) => p.ms), 0).toFixed(0)}ms`);
console.log(`/api/stats:    ${statsPolls.length} 次  平均体积=${(statsPolls.reduce((a, p) => a + p.bytes, 0) / Math.max(statsPolls.length, 1) / 1024 / 1024).toFixed(1)}MB  平均耗时=${avg(statsPolls.map((p) => p.ms))}ms  最大耗时=${Math.max(...statsPolls.map((p) => p.ms), 0).toFixed(0)}ms`);
console.log(`网关 RSS: 压测前=${(rssBefore / 1024).toFixed(0)}MB  压测后=${(gwRssKb() / 1024).toFixed(0)}MB`);

const lastStatsPoll = statsPolls.at(-1);
if (lastStatsPoll && lastStatsPoll.ms > 5000) {
  console.log(`\n⚠️  /api/stats 单次耗时 ${lastStatsPoll.ms.toFixed(0)}ms —— 面板 30s 轮询节奏下不可持续，需要窗口查询/增量协议`);
}

// ---------- 8. 清理（常驻模式保留进程） ----------
if (SERVE) {
  console.log(`\n🌐 常驻模式：压测进程保持运行`);
  console.log(`   👉 管理面板: http://127.0.0.1:${GW_PORT}/_dynapm/panel  （令牌: bench-token）`);
  console.log(`   结束清理: kill ${gw.pid} ${backend.pid ?? ""}`);
  process.exit(0);
}
backend.stop(true);
gw.kill("SIGKILL");
console.log(`\n清理完成。工作目录保留在 ${WORK_DIR}（可复查配置与统计文件大小）`);
process.exit(0);
