/**
 * Bun 1.4.0 已知问题：bun build --compile --external <pkg> 的单文件二进制在
 * 运行时解析 external 包（及其传递依赖）时，若包根目录不存在 index.js/index.mjs
 * 则整体解析失败，即使 package.json 的 exports 指向有效文件。
 * c12 及其依赖树（pathe/defu/destr/exsolve/confbox 等）均为 exports-only 包，
 * 直接编译会报 "Cannot find package 'xxx'"。
 * 此脚本遍历 gateway 直接依赖（含 c12 传递依赖）中缺根入口的包，各补一个
 * 转发 shim index.mjs 绕过该 bug。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 从 package.json 提取 ESM 入口相对路径（无则默认 index.mjs） */
function esmEntry(pkgDir: string): string | null {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (typeof pkg.exports === 'string') return pkg.exports;
  const dot = pkg.exports?.['.'];
  if (typeof dot === 'string') return dot;
  /** exports 条件对象：取 import.default（嵌套一层或两层） */
  const imp = dot?.import;
  if (typeof imp === 'string') return imp;
  if (typeof imp?.default === 'string') return imp.default;
  if (typeof pkg.module === 'string') return pkg.module;
  if (typeof pkg.main === 'string' && pkg.main.endsWith('.mjs')) return pkg.main;
  return null;
}

/** 递归收集依赖名（dependencies 全量，pnpm 下 gateway/node_modules 已平铺） */
function collectDeps(pkgDir: string, seen = new Set<string>()): Set<string> {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (seen.has(name)) continue;
    seen.add(name);
    const depDir = join(pkgDir, 'node_modules', name);
    if (existsSync(depDir)) collectDeps(depDir, seen);
  }
  return seen;
}

const root = process.cwd();
const c12Dir = join(root, 'node_modules', 'c12');
const names = ['c12', ...collectDeps(c12Dir)];
let patched = 0;
for (const name of names) {
  const dir = join(root, 'node_modules', name);
  if (!existsSync(dir)) continue;
  if (existsSync(join(dir, 'index.mjs')) || existsSync(join(dir, 'index.js'))) continue;
  const entry = esmEntry(dir);
  if (!entry) continue;
  writeFileSync(join(dir, 'index.mjs'), `export * from './${entry.replace(/^\.\//, '')}';\n`);
  patched++;
  console.log(`[patch-c12] ${name} -> ${entry}`);
}
console.log(`[patch-c12] 完成，共补 ${patched} 个根入口 shim`);
