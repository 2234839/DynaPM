import type { DynaPM_Config } from './configDef';

export function getBase200(base: string): Promise<boolean> {
  return fetch(base)
    .then((res) => res.status === 200)
    .catch(() => {
      return false;
    });
}

export async function runCheck(config: DynaPM_Config) {
  const time1 = Date.now();
  if (config.runCheck === 'getBase200') {
    while (1) {
      if (Date.now() - time1 > config.maxAwaitLaunchTime) {
        throw new Error(
          `等待启动的时间超过了配置的 maxAwaitLaunchTime :${config.maxAwaitLaunchTime}`,
        );
      }
      if (await getBase200(config.base)) {
        return true;
      } else {
        continue;
      }
    }
  } else {
    config.runCheck satisfies never;

    throw new Error(`尚未支持的 config check : ${config.runCheck}`);
  }
}
