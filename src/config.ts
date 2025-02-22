import { loadConfig } from 'c12';

async function readConfig() {
  const { config } = await loadConfig<{ a: 3 }>({
    name: 'dynapm',
  });
  console.log('[config]', config);
}

readConfig();
