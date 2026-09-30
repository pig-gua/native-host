'use strict';

/**
 * 注册 Native Messaging Host:
 * 1. 生成 run_host.bat (固定 node 与 host.js 的绝对路径, 退出码3 = 更新后自动重启)
 * 2. 生成清单 com.myapp.native_host.json
 * 3. 写入注册表 HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>
 * 用法: node scripts/register.js <chrome-extension-id>
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST_NAME = 'com.myapp.native_host';
const extensionId = process.argv[2];

if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  console.error('用法: node scripts/register.js <32位小写a-p的扩展ID>');
  process.exit(1);
}

const rootDir = path.join(__dirname, '..');
const batPath = path.join(rootDir, 'run_host.bat');
const manifestPath = path.join(rootDir, `${HOST_NAME}.json`);

const bat = [
  '@echo off',
  ':run',
  `"${process.execPath}" "${path.join(rootDir, 'src', 'host.js')}"`,
  'if %ERRORLEVEL%==3 goto run',
  'exit /B %ERRORLEVEL%',
  '',
].join('\r\n');
fs.writeFileSync(batPath, bat);

const manifest = {
  name: HOST_NAME,
  description: 'My native messaging host',
  path: batPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

if (process.platform === 'win32') {
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
  console.log('已写入注册表:', key);
} else {
  const dest = process.platform === 'darwin'
    ? path.join(process.env.HOME, 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
    : path.join(process.env.HOME, '.config/google-chrome/NativeMessagingHosts');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(manifestPath, path.join(dest, `${HOST_NAME}.json`));
  console.log('已复制清单到:', dest);
}

console.log('注册完成');
console.log('  host 名称:', HOST_NAME);
console.log('  清单路径:', manifestPath);
console.log('  启动脚本:', batPath);
