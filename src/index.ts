import fastify from 'fastify';
const proxyPort = 83;
import reply from '@fastify/reply-from';
import { pm2Manage, pm2Map } from './manage/pm2';
pm2Manage;
const proxy = fastify();

proxy.register(reply, {});

proxy.all('*', {}, async (request, reply) => {
  const target = pm2Map[request.hostname as keyof typeof pm2Map] || null;
  if (!target) {
    return reply.status(404).send('Not Found');
  }
  target.latestTime = Date.now();
  if (target.runStatus !== 'running') {
    await pm2Manage.start(target);
  }

  return reply.from(target.base + request.url);
});

proxy.listen({ port: proxyPort, host: '127.0.0.1' }, (err) => {
  if (err) {
    console.log('[err]', err);
  } else {
    console.log('服务启动成功');

    console.log(`[proxy] listening on port ${proxyPort}`);
  }
});
