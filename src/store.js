import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Multi-account token store: one JSON file on disk (mode 0600) because this is
 * a single-user local tool.
 *
 * Shape:
 * {
 *   "version": 2,
 *   "activeAccountId": "<uuid>",
 *   "accounts": [{
 *     "id": "<uuid>", "channelId": "UC...", "channelTitle": "...",
 *     "thumbnail": "...", "access_token": "...", "refresh_token": "...",
 *     "token_type": "Bearer", "scope": "...", "expiry_date": 123,
 *     "createdAt": "ISO", "updatedAt": "ISO"
 *   }]
 * }
 *
 * The file is intentionally copy-pasteable between machines: import accepts
 * this whole object, a single entry from `accounts`, or a legacy flat token.
 */

const VERSION = 2;

function emptyStore() {
  return { version: VERSION, activeAccountId: null, accounts: [] };
}

/** Deterministic id so a legacy or hand-pasted entry keeps the same identity. */
function stableId({ channelId, refresh_token, access_token }) {
  const seed = channelId || refresh_token || access_token;
  if (!seed) return crypto.randomUUID();
  const hash = crypto.createHash('sha1').update(String(seed)).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Coerce any accepted token shape into a stored account entry. */
function normaliseAccount(raw = {}) {
  const accessToken = raw.access_token ?? raw.accessToken ?? null;
  const refreshToken = raw.refresh_token ?? raw.refreshToken ?? null;
  const expiresAt = raw.expiry_date ?? null;
  return {
    id: raw.id || stableId(raw),
    channelId: raw.channelId ?? raw.channel_id ?? null,
    channelTitle: raw.channelTitle ?? raw.channel_title ?? raw.label ?? null,
    thumbnail: raw.thumbnail ?? null,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: raw.token_type ?? raw.tokenType ?? 'Bearer',
    scope: raw.scope ?? null,
    expiry_date:
      typeof expiresAt === 'number'
        ? expiresAt
        : expiresAt
          ? new Date(expiresAt).getTime()
          : null,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Accept legacy flat token files, single accounts, or full stores. */
function normaliseStore(parsed) {
  if (!parsed || typeof parsed !== 'object') return emptyStore();

  if (Array.isArray(parsed.accounts)) {
    const accounts = parsed.accounts
      .map((a) => normaliseAccount(a))
      .filter((a) => a.access_token || a.refresh_token);
    return {
      version: VERSION,
      activeAccountId:
        accounts.find((a) => a.id === parsed.activeAccountId)?.id ?? accounts[0]?.id ?? null,
      accounts,
    };
  }

  // Legacy single-account file: { access_token, refresh_token, ... }
  if (parsed.access_token || parsed.refresh_token) {
    const account = normaliseAccount(parsed);
    return { version: VERSION, activeAccountId: account.id, accounts: [account] };
  }

  return emptyStore();
}

export function readStore() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(config.tokenFile, 'utf8'));
  } catch {
    return emptyStore();
  }

  const store = normaliseStore(parsed);
  // Legacy v1 files (flat token) and entries without an id are rewritten once so
  // account ids stay stable across restarts.
  const legacy = !Array.isArray(parsed?.accounts) || parsed.accounts.some((a) => !a?.id);
  if (legacy && store.accounts.length > 0) {
    try {
      writeStore(store);
    } catch {
      /* read-only file system: keep serving the in-memory view */
    }
  }
  return store;
}

export function writeStore(store) {
  fs.mkdirSync(path.dirname(config.tokenFile), { recursive: true });
  const tmp = `${config.tokenFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, config.tokenFile);
  fs.chmodSync(config.tokenFile, 0o600);
  return store;
}

export function listAccounts() {
  return readStore().accounts;
}

export function getAccount(accountId) {
  const store = readStore();
  if (!accountId) return store.accounts.find((a) => a.id === store.activeAccountId) || store.accounts[0] || null;
  return store.accounts.find((a) => a.id === accountId) || null;
}

export function getActiveAccount() {
  const store = readStore();
  return store.accounts.find((a) => a.id === store.activeAccountId) || store.accounts[0] || null;
}

export function setActiveAccount(accountId) {
  const store = readStore();
  if (!store.accounts.some((a) => a.id === accountId)) {
    throw new Error(`Unknown account: ${accountId}`);
  }
  store.activeAccountId = accountId;
  return writeStore(store);
}

/**
 * Insert or update an account. Accounts are merged by YouTube channel id when
 * known (so reconnecting the same channel updates it instead of duplicating),
 * otherwise by the given id / newly generated uuid.
 */
export function upsertAccount(raw, { activate = false } = {}) {
  const store = readStore();
  const incoming = normaliseAccount(raw);

  // ids are derived deterministically from the channel/token, so an import of
  // the same token must update the existing row instead of adding a twin.
  const existing =
    (incoming.channelId && store.accounts.find((a) => a.channelId === incoming.channelId)) ||
    store.accounts.find((a) => a.id === incoming.id) ||
    (raw.id && store.accounts.find((a) => a.id === raw.id)) ||
    null;

  let account;
  if (existing) {
    account = {
      ...existing,
      ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== null && v !== undefined)),
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const index = store.accounts.indexOf(existing);
    store.accounts[index] = account;
  } else {
    account = incoming;
    store.accounts = store.accounts.filter((a) => a.id !== account.id);
    store.accounts.push(account);
  }

  if (activate || !store.activeAccountId) store.activeAccountId = account.id;
  writeStore(store);
  return account;
}

/** Fill in channel identity after a successful API call. */
export function describeAccount(accountId, { channelId, channelTitle, thumbnail }) {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account) return null;
  if (channelId) account.channelId = channelId;
  if (channelTitle) account.channelTitle = channelTitle;
  if (thumbnail) account.thumbnail = thumbnail;
  account.updatedAt = new Date().toISOString();

  // Two entries for the same channel (e.g. imported twice without a channel id)
  // must collapse into the one we just verified.
  if (channelId) {
    store.accounts = store.accounts.filter((a) => a.id === accountId || a.channelId !== channelId);
    if (store.activeAccountId && !store.accounts.some((a) => a.id === store.activeAccountId)) {
      store.activeAccountId = accountId;
    }
  }

  writeStore(store);
  return store.accounts.find((a) => a.id === accountId);
}

export function removeAccount(accountId) {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account) return null;
  store.accounts = store.accounts.filter((a) => a.id !== accountId);
  if (store.activeAccountId === accountId) {
    store.activeAccountId = store.accounts[0]?.id ?? null;
  }
  writeStore(store);
  return account;
}

export function clearStore() {
  try {
    fs.unlinkSync(config.tokenFile);
  } catch {
    /* already gone */
  }
}

/** Public, copy-friendly view of one account. */
export function publicTokenView(account) {
  if (!account) return null;
  return {
    accessToken: account.access_token || null,
    refreshToken: account.refresh_token || null,
    tokenType: account.token_type || 'Bearer',
    scope: account.scope || '',
    expiresAt: account.expiry_date ? new Date(account.expiry_date).toISOString() : null,
    expiresInSeconds: account.expiry_date
      ? Math.max(0, Math.round((account.expiry_date - Date.now()) / 1000))
      : null,
  };
}

/** Export one account as a paste-ready token object (same shape as the file). */
export function exportAccount(account) {
  if (!account) return null;
  return {
    channelId: account.channelId,
    channelTitle: account.channelTitle,
    thumbnail: account.thumbnail,
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    token_type: account.token_type || 'Bearer',
    scope: account.scope || null,
    expiry_date: account.expiry_date,
    createdAt: account.createdAt,
  };
}

/** The whole store, for moving every account to another machine at once. */
export function exportAll() {
  const store = readStore();
  return {
    version: VERSION,
    activeAccountId: store.activeAccountId,
    accounts: store.accounts.map(exportAccount),
  };
}
