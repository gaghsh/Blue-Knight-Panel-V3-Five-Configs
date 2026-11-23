const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const extract = require('extract-zip');

const app = express();

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const XRAY_PORT = 10000;
const CONFIG_COUNT = 5;
const WS_PATH = '/vless-ws-tls';

const DATA_DIR = path.join(process.cwd(), 'bk-data');
const BIN_DIR = path.join(DATA_DIR, 'bin');
const UUID_FILE = path.join(DATA_DIR, 'uuids.json');
const XRAY_CONFIG = path.join(DATA_DIR, 'xray.json');
const XRAY_ZIP = path.join(DATA_DIR, 'xray.zip');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

app.set('trust proxy', 1);

let xrayProcess = null;

// ---------------- UUID ----------------

function validUUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function loadUUIDs() {
  try {
    if (fs.existsSync(UUID_FILE)) {
      const saved = JSON.parse(fs.readFileSync(UUID_FILE, 'utf8'));

      if (
        Array.isArray(saved) &&
        saved.length === CONFIG_COUNT &&
        saved.every(validUUID) &&
        new Set(saved).size === CONFIG_COUNT
      ) {
        return saved;
      }
    }
  } catch (error) {
    console.log('UUID file could not be loaded');
  }

  const provided = (process.env.UUIDS || process.env.UUID || '')
    .split(',')
    .map(value => value.trim())
    .filter(validUUID);

  const uuids = [...new Set(provided)].slice(0, CONFIG_COUNT);

  while (uuids.length < CONFIG_COUNT) {
    const id = crypto.randomUUID();
    if (!uuids.includes(id)) uuids.push(id);
  }

  fs.writeFileSync(UUID_FILE, JSON.stringify(uuids, null, 2));

  return uuids;
}

const uuids = loadUUIDs();

// ---------------- Download Xray ----------------

function downloadFile(url, destination, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) {
      return reject(new Error('Too many download redirects'));
    }

    https.get(url, response => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        return resolve(
          downloadFile(response.headers.location, destination, redirects - 1)
        );
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(
          new Error(`Xray download failed: HTTP ${response.statusCode}`)
        );
      }

      const output = fs.createWriteStream(destination);

      response.pipe(output);

      output.on('finish', () => {
        output.close(resolve);
      });

      output.on('error', reject);
    }).on('error', reject);
  });
}

function getXrayAsset() {
  if (process.platform !== 'linux') {
    throw new Error('This version requires a Linux Botkeep container');
  }

  if (process.arch === 'x64') {
    return 'Xray-linux-64.zip';
  }

  if (process.arch === 'arm64') {
    return 'Xray-linux-arm64-v8a.zip';
  }

  throw new Error(`Unsupported architecture: ${process.arch}`);
}

async function installXray() {
  const binary = path.join(BIN_DIR, 'xray');

  if (fs.existsSync(binary)) {
    return binary;
  }

  const asset = getXrayAsset();

  const url =
    `https://github.com/XTLS/Xray-core/releases/latest/download/${asset}`;

  console.log('Downloading Xray...');

  await downloadFile(url, XRAY_ZIP);

  console.log('Extracting Xray...');

  await extract(XRAY_ZIP, { dir: BIN_DIR });

  if (!fs.existsSync(binary)) {
    throw new Error('Xray binary was not found after extraction');
  }

  fs.chmodSync(binary, 0o755);

  try {
    fs.unlinkSync(XRAY_ZIP);
  } catch (_) {}

  console.log('Xray installed successfully');

  return binary;
}

// ---------------- Xray Configuration ----------------

function generateXrayConfig() {
  const config = {
    log: {
      loglevel: 'warning'
    },

    inbounds: [
      {
        listen: '127.0.0.1',
        port: XRAY_PORT,
        protocol: 'vless',

        settings: {
          clients: uuids.map(uuid => ({
            id: uuid,
            level: 0
          })),
          decryption: 'none'
        },

        streamSettings: {
          network: 'ws',
          security: 'none',

          wsSettings: {
            path: WS_PATH
          }
        }
      }
    ],

    outbounds: [
      {
        protocol: 'freedom',
        tag: 'direct'
      }
    ]
  };

  fs.writeFileSync(
    XRAY_CONFIG,
    JSON.stringify(config, null, 2)
  );
}

// ---------------- Start Xray ----------------

async function startXray() {
  const binary = await installXray();

  generateXrayConfig();

  console.log('Starting Xray...');

  xrayProcess = spawn(
    binary,
    ['run', '-c', XRAY_CONFIG],
    {
      cwd: DATA_DIR,
      stdio: ['ignore', 'inherit', 'inherit']
    }
  );

  xrayProcess.on('error', error => {
    console.error('Xray process error:', error);
  });

  xrayProcess.on('exit', (code, signal) => {
    console.error('Xray exited:', code, signal);
    xrayProcess = null;
  });

  await new Promise(resolve => setTimeout(resolve, 1200));

  if (!xrayProcess || xrayProcess.exitCode !== null) {
    throw new Error('Xray failed to start. Check the logs.');
  }

  console.log('Xray is running');
}

// ---------------- Host and Links ----------------

function getHost(req) {
  const configured = process.env.DOMAIN || process.env.PUBLIC_HOST;

  if (configured) {
    return configured
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .replace(/:\d+$/, '');
  }

  const forwarded = req.headers['x-forwarded-host'];

  const host = (forwarded || req.headers.host || 'localhost')
    .toString()
    .split(',')[0]
    .trim();

  return host.replace(/:\d+$/, '');
}

function buildLinks(req) {
  const host = getHost(req);

  const isHttps =
    process.env.FORCE_HTTPS === 'true' ||
    (process.env.FORCE_HTTPS !== 'false' &&
      (req.secure || req.headers['x-forwarded-proto'] === 'https'));

  const port =
    process.env.FORCE_PORT ||
    (isHttps ? '443' : String(PORT));

  return uuids.map((uuid, index) => {
    const name = `VLESS-WS-TLS-${index + 1}`;

    const params = new URLSearchParams({
      encryption: 'none',
      security: 'tls',
      type: 'ws',
      sni: host,
      host,
      path: WS_PATH
    });

    return {
      name,
      uuid,
      path: WS_PATH,
      link:
        `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(name)}`
    };
  });
}

// ---------------- WebSocket Proxy ----------------

const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${XRAY_PORT}`,
  ws: true,
  changeOrigin: false
});

proxy.on('error', (error, req, socket) => {
  console.error('WebSocket proxy error:', error.message);

  if (socket && !socket.destroyed) {
    socket.destroy();
  }
});

// ---------------- Panel ----------------

app.get('/', (req, res) => {
  const links = buildLinks(req);

  res.type('html').send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VLESS Panel</title>
<style>
body {
  font-family: Arial, sans-serif;
  max-width: 850px;
  margin: 35px auto;
  padding: 15px;
  background: #111;
  color: #eee;
}
a { color: #8cf; }
.card {
  border: 1px solid #333;
  border-radius: 10px;
  padding: 14px;
  margin: 12px 0;
}
code {
  display: block;
  background: #222;
  padding: 12px;
  overflow-wrap: anywhere;
}
</style>
</head>
<body>
<h1>VLESS WS TLS Panel</h1>
<p>Active configurations: 5</p>
<p>
<a href="/subscription">Subscription</a> |
<a href="/api/configs">JSON</a> |
<a href="/health">Health</a>
</p>

${links.map(item => `
<div class="card">
<h3>${item.name}</h3>
<code>${item.link}</code>
</div>
`).join('')}

</body>
</html>`);
});

app.get('/api/configs', (req, res) => {
  res.json({
    count: CONFIG_COUNT,
    configs: buildLinks(req)
  });
});

app.get('/subscription', (req, res) => {
  const text = buildLinks(req)
    .map(item => item.link)
    .join('\n');

  res.type('text/plain').send(
    Buffer.from(text).toString('base64')
  );
});

app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    xray: Boolean(xrayProcess && xrayProcess.exitCode === null),
    configs: CONFIG_COUNT
  });
});

// ---------------- Server ----------------

async function main() {
  await startXray();

  const server = http.createServer(app);

  server.on('upgrade', (req, socket, head) => {
    let pathname;

    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      socket.destroy();
      return;
    }

    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    if (!xrayProcess || xrayProcess.exitCode !== null) {
      socket.destroy();
      return;
    }

    proxy.ws(req, socket, head);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('VLESS panel started');
    console.log(`Port: ${PORT}`);
    console.log(`UUIDs: ${CONFIG_COUNT}`);
    console.log(`WebSocket path: ${WS_PATH}`);
  });
}

function shutdown() {
  console.log('Shutting down...');

  if (xrayProcess) {
    xrayProcess.kill('SIGTERM');
  }

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(error => {
  console.error('Startup failed:', error);
  process.exit(1);
});
