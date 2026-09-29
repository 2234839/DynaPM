import { writeFileSync } from 'node:fs';
import packageJSON from '../package.json';

// 获取当前版本号
const currentVersion = packageJSON.version;

// 将版本号拆分为数组
const versionParts = currentVersion.split('.');

// 将最后一位版本号转换为数字并加一
const lastPart = parseInt(versionParts[versionParts.length - 1], 10);
versionParts[versionParts.length - 1] = (lastPart + 1).toString();

// 更新版本号
packageJSON.version = versionParts.join('.');

// 将更新后的 package.json 写回文件
writeFileSync('./package.json', JSON.stringify(packageJSON, null, 2));

console.log(`Version updated to: ${packageJSON.version}`);