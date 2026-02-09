const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:3000/', {
  headers: { 'Host': 'ws.test' },
});

let connected = false;
let receivedEcho = false;

ws.on('open', () => {
  console.log('✓ WebSocket 连接已建立');
  connected = true;
  
  // 发送测试消息
  ws.send(JSON.stringify({ type: 'test', data: 'hello' }));
  console.log('✓ 已发送测试消息');
});

ws.on('message', (data) => {
  try {
    const dataStr = data.toString();
    console.log('✓ 收到原始数据:', dataStr);
    
    const msg = JSON.parse(dataStr);
    console.log('✓ 收到消息:', msg);
    
    if (msg.type === 'connected') {
      console.log('✓ 收到连接确认');
    } else if (msg.type === 'echo') {
      console.log('✓ 收到 echo 响应');
      receivedEcho = true;
      ws.close();
    }
  } catch (err) {
    console.error('✗ 解析消息失败:', err.message);
    console.error('  原始数据:', data.toString());
    console.error('  数据长度:', data.length);
  }
});

ws.on('close', () => {
  console.log('✓ WebSocket 连接已关闭');
  setTimeout(() => {
    if (connected && receivedEcho) {
      console.log('✓ WebSocket 测试通过');
      process.exit(0);
    } else if (connected) {
      console.log('⚠ WebSocket 连接成功但未收到 echo 响应');
      process.exit(1);
    } else {
      console.log('✗ WebSocket 测试失败');
      process.exit(1);
    }
  }, 100);
});

ws.on('error', (err) => {
  console.error('✗ WebSocket 错误:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('✗ WebSocket 测试超时');
  ws.close();
  process.exit(1);
}, 10000);
