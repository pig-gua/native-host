'use strict';

/**
 * Chrome Native Messaging host.
 * 协议帧: [4字节小端uint32 长度][UTF-8 JSON 正文]
 * 注意: stdout 只准写协议帧, 日志一律写文件。
 *
 * 自更新约定: 启动时检查自身新版本, 更新成功后以退出码 3 退出,
 * 由 run_host.bat 的循环重新拉起 (Chrome 与 bat 的管道不断开)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('./updater');

const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
const EXIT_CODE_RESTART = 3;

// ---------- 日志 (写文件, 绝不碰 stdout) ----------
const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'my-native-host', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(
  path.join(LOG_DIR, `host-${new Date().toISOString().slice(0, 10)}.log`),
  { flags: 'a' }
);
function log(...args) {
  logStream.write(`[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`);
}
process.on('uncaughtException', (err) => { log('uncaughtException:', err.stack); process.exit(1); });
process.on('unhandledRejection', (err) => { log('unhandledRejection:', err && err.stack); });

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// ---------- 启动时: host 自更新 ----------
async function selfUpdate() {
  const cfg = readConfig();
  if (!cfg || !cfg.updateServer) return;
  const version = currentVersion();
  try {
    const info = await updater.checkApp(cfg.updateServer, 'host', version);
    if (!info.update) {
      log(`self-update: already latest (${version})`);
      return;
    }
    log(`self-update: ${version} -> ${info.version}, applying...`);
    await updater.applyPackage(cfg.updateServer, info, ROOT_DIR);
    log('self-update: applied, restarting with exit code', EXIT_CODE_RESTART);
    process.exit(EXIT_CODE_RESTART);
  } catch (err) {
    // 更新失败不阻塞正常使用
    log('self-update failed (ignored):', err.message);
  }
}

// ---------- 协议帧: 发送 ----------
function send(msg) {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

// ---------- 协议帧: 接收 (流式缓冲 + 粘包处理) ----------
let buffer = Buffer.alloc(0);
process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break;
      const json = buffer.subarray(4, 4 + len).toString('utf8');
      buffer = buffer.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(json);
      } catch (err) {
        log('JSON parse error:', err.message, json);
        continue;
      }
      dispatch(msg);
    }
  }
});

// Chrome 关闭管道 (扩展断开/浏览器退出) 时必须退出
process.stdin.on('end', () => {
  log('stdin EOF, exiting');
  process.exit(0);
});

// ---------- 消息路由 ----------
const handlers = {
  ping(params, reply) {
    reply({ pong: true, time: Date.now(), version: currentVersion() });
  },

  echo(params, reply) {
    reply({ echo: params });
  },

  getSystemInfo(params, reply) {
    reply({
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMB: Math.round(os.freemem() / 1024 / 1024),
      uptimeSec: Math.round(os.uptime()),
    });
  },

  startTicker(params, reply) {
    const intervalMs = (params && params.intervalMs) || 5000;
    if (ticker) clearInterval(ticker);
    let count = 0;
    ticker = setInterval(() => {
      count += 1;
      send({ event: 'tick', count, time: Date.now() });
    }, intervalMs);
    reply({ started: true, intervalMs });
  },

  stopTicker(params, reply) {
    if (ticker) clearInterval(ticker);
    ticker = null;
    reply({ stopped: true });
  },

  // 扩展上报自己的版本, 检查 host 与扩展两边是否有更新
  async checkUpdates(params, reply) {
    const cfg = readConfig();
    if (!cfg || !cfg.updateServer) return reply({ enabled: false });
    const result = { enabled: true };
    try {
      result.host = await updater.checkApp(cfg.updateServer, 'host', currentVersion());
    } catch (err) {
      result.host = { error: err.message };
    }
    if (params.extensionVersion) {
      try {
        result.extension = await updater.checkApp(cfg.updateServer, 'extension', params.extensionVersion);
        if (result.extension && result.extension.update) {
          send({ event: 'extensionUpdateAvailable', version: result.extension.version });
        }
      } catch (err) {
        result.extension = { error: err.message };
      }
    }
    reply(result);
  },

  // 下载新版扩展并覆盖到扩展目录 (zip 内不得包含 key.pem)
  async applyExtensionUpdate(params, reply) {
    const cfg = readConfig();
    if (!cfg || !cfg.updateServer || !cfg.extensionDir) {
      return reply({ updated: false, error: 'update not configured' });
    }
    const info = await updater.checkApp(cfg.updateServer, 'extension', '0.0.0');
    if (!info.update) return reply({ updated: false, error: 'no package available' });
    const res = await updater.applyPackage(cfg.updateServer, info, cfg.extensionDir);
    log('extension updated to', res.version);
    reply(res);
  },
};
let ticker = null;

function dispatch(msg) {
  log('<= recv:', JSON.stringify(msg));
  if (msg.method === 'heartbeat') return;

  const handler = handlers[msg.method];
  const reply = (result) => { send({ id: msg.id, result }); log('=> send:', JSON.stringify({ id: msg.id, result })); };
  const replyError = (message) => send({ id: msg.id, error: { message } });

  if (!handler) {
    replyError(`unknown method: ${msg.method}`);
    return;
  }
  Promise.resolve()
    .then(() => handler(msg.params || {}, reply))
    .catch((err) => replyError(err.message));
}

// ---------- 启动 ----------
log('host started, pid =', process.pid, 'version =', currentVersion());
selfUpdate();
