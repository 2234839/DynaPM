import { App } from 'uWebSockets.js';

const app = App({});
app.get('/', (res) => {
  res.write('Hello World');
  res.end();
});
app.listen('::', 3001, (listenSocket) => {
  console.log('Listening on port 3001', listenSocket);
});
