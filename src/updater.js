'use strict';

/**
 * 自动更新模块:
 * - checkApp: 向服务端查询某 app 是否有新版本
 * - applyPackage: 下载 zip -> 校验 sha256 -> 解压覆盖到目标目录
 * 失败一律抛异常, 由调用方兜底 (更新失败不能影响正常功能)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(new URL(res.headers.location, url).href).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).href, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function extractZip(zipFile, destDir) {
  // Windows 10+ / macOS / Linux 均自带 bsdtar, 可解 zip
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xf', zipFile, '-C', destDir]);
}

async function checkApp(serverBase, app, currentVersion) {
  const url = `${serverBase}/api/updates/check?app=${encodeURIComponent(app)}&version=${encodeURIComponent(currentVersion)}`;
  return fetchJson(url);
}

async function applyPackage(serverBase, info, targetDir) {
  const tmp = path.join(os.tmpdir(), `myapp-update-${info.version}-${Date.now()}.zip`);
  try {
    await download(new URL(info.url, serverBase).href, tmp);
    const actual = sha256File(tmp);
    if (info.sha256 && actual !== info.sha256.toLowerCase()) {
      throw new Error(`sha256 mismatch: expect ${info.sha256}, got ${actual}`);
    }
    extractZip(tmp, targetDir);
    return { updated: true, version: info.version };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { checkApp, applyPackage };

