'use strict';

const { execFileSync } = require('child_process');

const HOST_NAME = 'com.myapp.native_host';

if (process.platform === 'win32') {
  try {
    execFileSync('reg', ['delete',
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/f']);
    console.log('已删除注册表键');
  } catch {
    console.log('注册表键不存在, 跳过');
  }
} else {
  const fs = require('fs');
  const path = require('path');
  const file = process.platform === 'darwin'
    ? path.join(process.env.HOME, `Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json`)
    : path.join(process.env.HOME, `.config/google-chrome/NativeMessagingHosts/${HOST_NAME}.json`);
  fs.rmSync(file, { force: true });
  console.log('已删除清单文件');
}
