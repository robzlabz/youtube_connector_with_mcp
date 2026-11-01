import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, missingConfig } from './src/config.js';
import * as google from './src/google.js';
import * as store from './src/store.js';
import * as accounts from './src/accounts.js';
import { clientFor } from './src/youtube.js';
import { mcpRoutes, mcpEndpointUrl } from './src/mcp.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));

fs.mkdirSync(config.uploadDir, { recursive: true });

// OAuth state lives in src/google.js so the web UI and the MCP tools share it.
const { issueState, consumeState } = google;

// --- uploads (browser -> local disk -> YouTube) ----------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 12) || '.mp4';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

function removeQuietly(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

// --- routes ----------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// --- MCP (Streamable HTTP) --------------------------------------------------
// One URL for AI clients: POST JSON-RPC to /mcp. Stateless, so no session id.
const mcp = mcpRoutes();

app.use('/mcp', (req, res, next) => {
  // DNS-rebinding guard: only allow non-browser clients or a localhost Origin.
  const origin = req.get('origin');
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return res.status(403).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Forbidden origin.' },
    });
  }
  next();
});

app.post('/mcp', mcp.post);
app.get('/mcp', mcp.get);
app.delete('/mcp', mcp.delete);

app.get('/api/config', (_req, res) => {
  res.json({
    configured: google.isConfigured(),
    missing: missingConfig(),
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
  });
});

// --- OAuth ------------------------------------------------------------------

app.get('/auth/url', (_req, res) => {
  try {
    res.json({ url: google.authUrl(issueState()) });
  } catch (err) {
    res.status(err.status || 500).json({ error: { message: err.message, code: err.code } });
  }
});

app.get('/auth/start', (_req, res) => {
  try {
    res.redirect(google.authUrl(issueState()));
  } catch (err) {
    res.status(err.status || 500).type('html').send(errorPage(err.message));
  }
});

app.get(['/oauth2callback', '/callback'], async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.redirect(`/?error=${encodeURIComponent(String(errorDescription || error))}`);
  }
  if (!consumeState(state)) {
    return res.status(400).type('html').send(
      errorPage('Invalid or expired OAuth state. Start again from the home page.'),
    );
  }
  if (!code) {
    return res.status(400).type('html').send(errorPage('Google did not return a code.'));
  }

  try {
    // Each successful consent adds (or refreshes) one account in the store.
    const tokens = await google.exchangeCode(String(code));
    await accounts.importTokens(tokens, { activate: true });
    res.redirect('/?connected=1');
  } catch (err) {
    res
      .status(err.status || 400)
      .type('html')
      .send(errorPage(`${err.code || 'auth_error'}: ${err.message}`));
  }
});

// --- accounts ---------------------------------------------------------------

/** Which account a request targets: ?account=, X-YouTube-Account, or active. */
function targetAccount(req) {
  const reference =
    req.query.account || req.get('x-youtube-account') || (req.body && req.body.account) || null;
  return accounts.requireAccount(reference);
}

app.get('/api/accounts', (_req, res) => {
  const active = store.getActiveAccount();
  res.json({
    accounts: accounts.accountList(),
    activeAccountId: active?.id ?? null,
  });
});

app.post('/api/accounts/import', async (req, res) => {
  const { token, payload, activate = true } = req.body || {};
  const input = token ?? payload;
  if (!input) {
    return res.status(400).json({ error: { message: 'Provide "token" (JSON string, object, or raw token).' } });
  }
  const result = await accounts.importTokens(input, { activate: activate !== false });
  res.status(201).json(result);
});

app.post('/api/accounts/:id/activate', (req, res) => {
  const account = accounts.requireAccount(req.params.id);
  store.setActiveAccount(account.id);
  res.json({ activeAccountId: account.id, accounts: accounts.accountList() });
});

app.delete('/api/accounts/:id', async (req, res) => {
  const account = accounts.requireAccount(req.params.id);
  const result = await google.disconnectAccount(account.id);
  res.json({ ...result, accounts: accounts.accountList() });
});

app.get('/api/accounts/:id/export', (req, res) => {
  const account = accounts.requireAccount(req.params.id);
  res.json(accounts.exportOne(account.id));
});

app.get('/api/export', (_req, res) => {
  res.json(accounts.exportEverything());
});

// --- status / token ---------------------------------------------------------

app.get('/api/status', async (req, res) => {
  const active = accounts.resolveAccount(req.query.account || null);
  const payload = {
    configured: google.isConfigured(),
    missing: missingConfig(),
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    connected: Boolean(active),
    accounts: accounts.accountList(),
    activeAccountId: active?.id ?? null,
    token: null,
    channel: null,
    authError: null,
  };

  if (active) {
    payload.token = {
      ...store.publicTokenView(active),
      accountId: active.id,
      channelTitle: active.channelTitle,
    };
    try {
      payload.channel = await clientFor(active.id).getMyChannel();
      payload.token = {
        ...store.publicTokenView(store.getAccount(active.id)),
        accountId: active.id,
        channelTitle: store.getAccount(active.id)?.channelTitle,
      };
    } catch (err) {
      payload.authError = { code: err.code || 'error', message: err.message };
    }
  }
  res.json(payload);
});

app.get('/api/token', async (req, res) => {
  const account = targetAccount(req);
  const accessToken = await google.getAccessToken({ accountId: account.id, force: true });
  res.json({
    ...store.publicTokenView(store.getAccount(account.id)),
    accessToken,
    accountId: account.id,
    channelTitle: account.channelTitle,
  });
});

app.post('/api/token/refresh', async (req, res) => {
  const account = targetAccount(req);
  await google.refreshAccount(account.id, { force: true });
  res.json({ ...store.publicTokenView(store.getAccount(account.id)), accountId: account.id });
});

app.post('/api/disconnect', async (req, res) => {
  const account = targetAccount(req);
  const result = await google.disconnectAccount(account.id);
  res.json({ ...result, accounts: accounts.accountList() });
});

// --- videos -----------------------------------------------------------------

app.get('/api/videos', async (req, res) => {
  const account = targetAccount(req);
  res.json(
    await clientFor(account.id).listVideos({
      maxResults: req.query.maxResults,
      pageToken: req.query.pageToken,
    }),
  );
});

app.get('/api/videos/:id', async (req, res) => {
  const account = targetAccount(req);
  res.json(await clientFor(account.id).getVideo(req.params.id));
});

app.patch('/api/videos/:id', async (req, res) => {
  const account = targetAccount(req);
  const changes = {};
  for (const key of ['title', 'description', 'tags', 'categoryId', 'privacyStatus']) {
    if (req.body[key] !== undefined) changes[key] = req.body[key];
  }
  if (typeof changes.tags === 'string') {
    changes.tags = changes.tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  res.json(await clientFor(account.id).updateVideo(req.params.id, changes));
});

app.delete('/api/videos/:id', async (req, res) => {
  const account = targetAccount(req);
  res.json(await clientFor(account.id).deleteVideo(req.params.id));
});

// --- playlists --------------------------------------------------------------

app.get('/api/playlists', async (req, res) => {
  const account = targetAccount(req);
  res.json({ items: await clientFor(account.id).listPlaylists() });
});

app.post('/api/playlists', async (req, res) => {
  const account = targetAccount(req);
  const { title, description = '', privacyStatus = 'private' } = req.body || {};
  if (!title) return res.status(400).json({ error: { message: 'title is required' } });
  res.status(201).json(await clientFor(account.id).createPlaylist({ title, description, privacyStatus }));
});

app.post('/api/playlists/:id/items', async (req, res) => {
  const account = targetAccount(req);
  const { videoId } = req.body || {};
  if (!videoId) return res.status(400).json({ error: { message: 'videoId is required' } });
  res.status(201).json(await clientFor(account.id).addVideoToPlaylist(req.params.id, videoId));
});

// --- upload -----------------------------------------------------------------

app.post('/api/upload', upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: { message: 'No video file uploaded (field name: video)' } });
  }
  try {
    const account = targetAccount(req);
    const body = req.body || {};
    const tags = typeof body.tags === 'string'
      ? body.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : Array.isArray(body.tags) ? body.tags : [];

    const video = await clientFor(account.id).uploadVideo({
      filePath: file.path,
      size: file.size,
      mimeType: file.mimetype || 'video/*',
      title: body.title || path.parse(file.originalname || 'Untitled').name,
      description: body.description || '',
      tags,
      privacyStatus: body.privacyStatus || 'private',
      categoryId: body.categoryId || '22',
      madeForKids: body.madeForKids === 'true' || body.madeForKids === true,
      publishAt: body.publishAt || null,
      playlistId: body.playlistId || null,
    });
    res.status(201).json(video);
  } finally {
    removeQuietly(file.path);
  }
});

// --- errors ----------------------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      error: {
        message:
          err.code === 'LIMIT_FILE_SIZE'
            ? `File is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB (MAX_UPLOAD_MB).`
            : err.message,
        code: err.code,
      },
    });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: { message: err.message || 'Internal error', code: err.code || null, reason: err.reason || null },
  });
});

function errorPage(message) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>YouTube connector</title>
<body style="font:15px/1.5 -apple-system,system-ui,sans-serif;padding:40px;max-width:640px;margin:auto">
<h1 style="font-size:18px">Connection failed</h1>
<p style="color:#b91c1c">${safe}</p>
<p><a href="/">Back to the app</a></p></body>`;
}

const server = app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  console.log(`YouTube connector running at ${url}`);
  console.log(`MCP (Streamable HTTP): ${mcpEndpointUrl}`);
  console.log(`Redirect URI (must match Google Cloud Console): ${config.redirectUri}`);
  if (!google.isConfigured()) {
    console.warn(`Missing ${missingConfig().join(', ')} — copy .env.example to .env and fill it in.`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
