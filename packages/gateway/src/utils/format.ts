/**
 * 格式化时间（毫秒转换为易读格式）
 * @param ms - 毫秒数
 * @returns 格式化后的时间字符串
 */
export function formatTime(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}
