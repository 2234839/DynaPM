import pm2, { type StartOptions } from 'pm2';

export const pm2Map = {
  '127.0.0.1': {
    // 需要和 ecosystem 中的 那么相同
    base: 'http://127.0.0.1:3001',
    latestTime: Date.now(),
    stopTime: 5_000,
    runStatus: 'unknown' as 'running' | 'unknown' | 'stop',
    options: {
      name: 'test',
      script: './dist/test/test.mjs',
      interpreter: 'node',
      exec_mode: 'cluster',
      instances: 1,
    } satisfies StartOptions,
  },
};
type pm2Item = (typeof pm2Map)[keyof typeof pm2Map];
setInterval(() => {
  Object.entries(pm2Map).forEach(([hostname, target]) => {
    if (target.runStatus === 'running' && Date.now() - target.latestTime > target.stopTime) {
      pm2.stop(target.options.name, (err, proc) => {
        if (err) {
          console.log('[stop失败]', err);
        } else {
          target.runStatus = 'stop';
          console.log(`停止 [${target.options.name}] 的运行`);
        }
      });
    }
  });
}, 10_000);
const pm2Connect = new Promise((r) => {
  pm2.connect(() => {
    r(1);
  });
});

export const pm2Manage = {
  async start(target: pm2Item) {
    await new Promise((resolve, reject) => {
      pm2.describe(target.options.name, (err, process) => {
        console.log('[process]', { ...process[0], pm2_env: undefined });
        if (err || /** 内存为零表示处于 stop 状态 */ !process[0]?.monit?.memory) {
          pm2.start(target.options, (err, proc) => {
            if (err) {
              console.log('启动程序失败', err);
            } else {
              // TODO 改为更好的检测方式，而不是死等
              setTimeout(() => {
                resolve(1);
                target.latestTime = Date.now();
                target.runStatus = 'running';
              }, 3000);
            }
          });
        } else {
          target.latestTime = Date.now();

          resolve(1);
        }
      });
    });
  },
};
