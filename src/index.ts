import fastify from 'fastify';
// 定义不同域名对应的代理
const proxyConfig = {
  '127.0.0.1:82': 'http://localhost:3001',
  'example2.com': 'http://username2:password2@proxy2.example.com:1080',
  default: 'http://defaultuser:defaultpass@default.proxy.com:1080', // 默认代理
};

const proxyPort = 83;
const targetHost = '127.0.0.1';
const targetPort = 3001;
const targetBase = `http://${targetHost}:${targetPort}`;
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
    console.log(`[proxy] listening on port ${proxyPort}`);
  }
});
