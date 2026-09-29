import type * as net from 'node:net';

/**
 * 建立双向 TCP 直通管道
 * 客户端 socket 与后端 socket 互相 pipe（Node pipe 自带背压处理），
 * 任一侧错误或关闭即销毁另一侧，并触发一次 onDestroyed 回调用于清理计数。
 *
 * @param client - 客户端侧 socket（网关接受到的连接）
 * @param backend - 后端侧 socket（net.connect 到目标服务）
 * @param onDestroyed - 管道销毁时的清理回调（保证只触发一次，用于递减 activeConnections）
 */
export function pipeTcpSockets(
  client: net.Socket,
  backend: net.Socket,
  onDestroyed: () => void,
): void {
  let tornDown = false;

  /** 显式开启 TCP_NODELAY：消除对 Node 默认行为的隐式依赖，直通小包不被 Nagle 缓冲 */
  client.setNoDelay(true);
  backend.setNoDelay(true);

  /** 销毁双侧 socket 并触发一次清理回调 */
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    client.destroy();
    backend.destroy();
    onDestroyed();
  };

  client.on('error', teardown);
  backend.on('error', teardown);
  client.on('close', teardown);
  backend.on('close', teardown);

  client.pipe(backend);
  backend.pipe(client);
}
