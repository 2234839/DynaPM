/**
 * 测试基建：断言 + 一次性网关/后端进程管理（基于 fetch，无需 curl，避开 zsh 转义坑）
 */
import { spawn } from "node:child_process";

export let passed = 0;
export let failed = 0;
const failures: string[] = [];

/** 单条断言：失败不抛出（继续收集），打印 ✅/❌ */
export function assert(cond: unknown, msg: string): boolean {
  if (cond) {
    passed++;
    return true;
  }
  failed++;
  failures.push(msg);
  console.log(`  ❌ ${msg}`);
  return false;
}

export function assertEq(actual: unknown, expected: unknown, msg: string): boolean {
  return assert(
    actual === expected,
    `${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );
}

/** 汇总 + 以正确退出码结束进程 */
export function finish(name: string): never {
  console.log(`\n${name}: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

/** 等待端口可 TCP 连接（冷启动探针） */
export async function waitPort(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < <number>deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      r.body?.cancel();
      return true;
    } catch {
      await Bun.sleep(100);
    }
  }
  return false;
}

/** 后台子进程句柄（结束测试时统一回收） */
const children: ReturnType<typeof spawn>[] = [];

/** 当前网关进程 pid（startGateway 记录，stopGateway 用） */
let gatewayPid: number | undefined;

/** 拉起进程并登记（失败快速退出） */
export function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout!.on("data", () => {});
  p.stderr!.on("data", () => {});
  children.push(p);
  return p;
}

/** 杀掉全部子进程（测试收尾） */
export function killAll() {
  for (const p of children) {
    try {
      process.kill(-p.pid!, "SIGKILL");
    } catch {
      try { p.kill("SIGKILL"); } catch {}
    }
  }
}

process.on("exit", killAll);

/** 起测试后端并等就绪 */
export async function startBackend(port: number) {
  run("bun", [import.meta.dir + "/backend.ts", String(port)]);
  if (!(await waitPort(port, 10000))) throw new Error(`后端 ${port} 未就绪`);
}

/** 起网关并等就绪 */
export async function startGateway(configPath: string, port: number) {
  const p = run(import.meta.dir + "/../target/release/dynapm", [], { DYNAPM_CONFIG: configPath });
  gatewayPid = p.pid;
  if (!(await waitPort(port, 15000))) throw new Error(`网关 ${port} 未就绪`);
}

/** 停网关（SIGTERM 优雅退出），等待端口释放 */
export async function stopGateway(port: number) {
  if (gatewayPid) {
    try { process.kill(gatewayPid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) });
      r.body?.cancel();
      await Bun.sleep(150);
    } catch {
      return;
    }
  }
}
