/**
 * 构建 npm 分发用 JS bundle：dist/dynapm.mjs
 * 全量打包（不 --external），所有运行时依赖打进单文件；
 * bun build 无内置 shebang 选项，构建后检查产物首行并前置 `#!/usr/bin/env bun`。
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

const OUT = 'dist/dynapm.mjs';
const SHEBANG = '#!/usr/bin/env bun';

const proc = Bun.spawnSync({
  cmd: [
    'bun',
    'build',
    '--target=bun',
    '--format=esm',
    'src/index.ts',
    '--external',
    'giget',
    '--outfile',
    OUT,
  ],
  stdout: 'inherit',
  stderr: 'inherit',
});
if (proc.exitCode !== 0) {
  console.error(`bun build 失败 exit=${proc.exitCode}`);
  process.exit(proc.exitCode);
}

/** 产物头部注入 shebang（bun build 无内置 shebang 选项） */
let content = readFileSync(OUT, 'utf8');
if (!content.startsWith('#!')) {
  content = `${SHEBANG}\n${content}`;
  writeFileSync(OUT, content);
}
chmodSync(OUT, 0o755);
console.log(`✅ bundle 构建完成: ${OUT} (${(content.length / 1024 / 1024).toFixed(2)}MB, shebang 已注入)`);
