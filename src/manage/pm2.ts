import pm2, { type StartOptions } from 'pm2';
import type { DynaPM_Config } from './configDef';
import { runCheck } from './runCheck';

export const pm2Map = {
  '127.0.0.1': {
    // 需要和 ecosystem 中的 那么相同
    base: 'http://127.0.0.1:3001',
    latestTime: Date.now(),
    stopTime: 5_000,
    maxAwaitLaunchTime: 5_000,
    runCheck: 'getBase200' as /** 请求 base 路径获得 200 响应码 */ 'getBase200',
    runStatus: 'unknown' as 'launching' | 'running' | 'stop' | 'unknown',
    pm2Options: {
      name: 'test',
      script: './dist/test/test.mjs',
      interpreter: 'node',
      exec_mode: 'cluster',
      instances: 1,
    } satisfies StartOptions,
  } satisfies DynaPM_Config,
};
type pm2Item = (typeof pm2Map)[keyof typeof pm2Map];
setInterval(() => {
  Object.entries(pm2Map).forEach(([hostname, target]) => {
    if (target.runStatus === 'running' && Date.now() - target.latestTime > target.stopTime) {
      pm2.stop(target.pm2Options.name, (err, proc) => {
        if (err) {
          console.log('[stop失败]', err);
        } else {
          target.runStatus = 'stop';
          console.log(`停止 [${target.pm2Options.name}] `);
        }
      });
    }
  });
}, 3_000);
/** 用于等待连接 pm2  */
const pm2Connect = new Promise((r) => {
  pm2.connect(() => {
    r(1);
  });
});

export const pm2Manage = {
  async start(target: pm2Item) {
    const time1 = Date.now();
    await pm2Connect;
    let status = await getProcessStatus(target.pm2Options.name);
    async function skipLaunching() {
      if (status === 'launching') {
        // 等待程序启动完毕
        while (status === 'launching') {
          target.runStatus = 'launching';
          status = await getProcessStatus(target.pm2Options.name);
        }
      }
    }
    await skipLaunching();
    if (/** 应用尚未在线 */ status !== 'online') {
      await new Promise((resolve, reject) => {
        pm2.start(target.pm2Options, (err, proc) => {
          console.log(`开始启动 [${target.pm2Options.name}]`);
          if (err) {
            console.log('启动程序失败', err);
            reject(err);
          } else {
            status = 'launching';
            resolve(1);
          }
        });
      });
      await skipLaunching();
    }

    if (status !== 'online') {
      console.log('[status]', status);
      throw new Error('进程启动异常');
    } else {
      target.latestTime = Date.now();
      target.runStatus = 'running';
      /** 通过其他手段检测程序完全启动完毕 */
      await runCheck(target);
      const time2 = Date.now();
      console.log(`启动 [${target.pm2Options.name}] 耗时 ${time2 - time1} ms`);

      return true;
    }
  },
};

/** 获取指定名称的进程的状态 */
async function getProcessStatus(processID: string | number) {
  await pm2Connect;

  return new Promise<
    | 'online'
    | 'stopping'
    | 'stopped'
    | 'launching'
    | 'errored'
    | 'one-launch-status'
    | 'error'
    | undefined
  >((r) => {
    pm2.describe(processID, (err, process) => {
      if (err) {
        r('error');
      } else {
        r(process[0]?.pm2_env?.status);
      }
    });
  });
}
