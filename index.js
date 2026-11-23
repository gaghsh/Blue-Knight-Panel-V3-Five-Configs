const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const CONFIG_COUNT = 5;
const dataDir = path.join(process.cwd(), 'bk-data');
const uuidFile = path.join(dataDir, 'uuids.json');

fs.mkdirSync(dataDir, { recursive: true });

function loadUUIDs() {
  if (fs.existsSync(uuidFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(uuidFile, 'utf8'));
      if (Array.isArray(saved) && saved.length === CONFIG_COUNT && new Set(saved).size === CONFIG_COUNT) {
        return saved;
      }
    } catch (_) {}
  }

  const fromEnvironment = (process.env.UUIDS || process.env.UUID || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  const uuids = [];
  for (const value of fromEnvironment) {
    if (!uuids.includes(value)) uuids.push(value);
  }
  while (uuids.length < CONFIG_COUNT) {
    const uuid = crypto.randomUUID();
    if (!uuids.includes(uuid)) uuids.push(uuid);
  }

  fs.writeFileSync(uuidFile, JSON.stringify(uuids.slice(0, CONFIG_COUNT), null, 2));
  return uuids.slice(0, CONFIG_COUNT);
}

const uuids = loadUUIDs();

function hostFromRequest(req) {
  const configured = process.env.DOMAIN || process.env.PUBLIC_HOST;
  if (configured) return configured.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const forwarded = (req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwarded || req.headers.host || 'localhost';
  return host.replace(/:\d+$/, '');
}

function buildLinks(req) {
  const host = hostFromRequest(req);
  const port = process.env.FORCE_PORT || (req.secure || process.env.FORCE_HTTPS === 'true' ? '443' : String(PORT));
  const pathPrefix = '/vless-ws-tls';

  return uuids.map((uuid, index) => {
    const name = `VLESS-WS-TLS-${index + 1}`;
    const wsPath = `${pathPrefix}/${index + 1}`;
    const params = new URLSearchParams({
      encryption: 'none',
      security: 'tls',
      type: 'ws',
      sni: host,
      host,
      path: wsPath,
    });
    return {
      name,
      uuid,
      path: wsPath,
      link: `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(name)}`,
    };
  });
}

app.get('/', (req, res) => {
  const links = buildLinks(req);
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>VLESS WS TLS - 5 configs</title>
<style>body{font-family:system-ui;max-width:900px;margin:40px auto;padding:20px;background:#111;color:#eee}code{display:block;padding:12px;background:#222;overflow-wrap:anywhere;margin:8px 0}.card{border:1px solid #333;border-radius:10px;padding:14px;margin:12px 0}</style>
</head><body><h1>5 VLESS WS TLS configs</h1>
<p><a style="color:#8cf" href="/subscription">Subscription</a> · <a style="color:#8cf" href="/api/configs">JSON</a> · <a style="color:#8cf" href="/xray.json">Xray inbound</a></p>
${links.map(item => `<div class="card"><h3>${item.name}</h3><code>${item.link}</code></div>`).join('')}
</body></html>`);
});

app.get('/api/configs', (req, res) => {
  res.json({ count: 5, configs: buildLinks(req) });
});

app.get('/subscription', (req, res) => {
  const text = buildLinks(req).map(item => item.link).join('\n');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(Buffer.from(text).toString('base64'));
});

app.get('/xray.json', (req, res) => {
  const configs = buildLinks(req);
  const inbound = {
    port: process.env.XRAY_PORT || 443,
    protocol: 'vless',
    settings: {
      clients: configs.map(({ uuid }) => ({ id: uuid, level: 0 })),
      decryption: 'none',
    },
    streamSettings: {
      network: 'ws',
      security: 'tls',
      tlsSettings: {
        certificates: [{
          certificateFile: process.env.TLS_CERT || '/path/to/certificate.pem',
          keyFile: process.env.TLS_KEY || '/path/to/private-key.pem',
        }],
      },
      wsSettings: {
        path: '/vless-ws-tls',
      },
    },
  };
  res.json({ log: { loglevel: 'warning' }, inbounds: [inbound] });
});

app.listen(PORT, () => {
  console.log(`Five-config VLESS panel listening on port ${PORT}`);
  console.log(`UUID file: ${uuidFile}`);
});
