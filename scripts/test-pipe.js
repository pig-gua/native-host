'use strict';

/**
 * 不依赖 Chrome 的本地冒烟测试:
 * 模拟 Chrome 侧, 按协议帧格式与 host 进程通信。
 * 用法: node scripts/test-pipe.js
 */

const { spawn } = require('child_process');
const path = require('path');

const host = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'host.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

function send(msg) {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  host.stdin.write(Buffer.concat([header, payload]));
}

let buffer = Buffer.alloc(0);
host.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0);
    if (buffer.length < 4 + len) break;
    const msg = JSON.parse(buffer.subarray(4, 4 + len).toString('utf8'));
    buffer = buffer.subarray(4 + len);
    console.log('host =>', msg);
  }
});

send({ id: 1, method: 'ping' });
send({ id: 2, method: 'echo', params: { hello: 'world' } });
send({ id: 3, method: 'getSystemInfo' });

setTimeout(() => {
  host.stdin.end(); // 模拟 Chrome 关闭管道, host 应自行退出
}, 1000);

host.on('exit', (code) => {
  console.log('host exited, code =', code);
  process.exit(code === 0 ? 0 : 1);
});
