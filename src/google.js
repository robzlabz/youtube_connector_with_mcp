import crypto from 'node:crypto';
import { config, missingConfig } from './config.js';
import {
  getAccount,
  getActiveAccount,
  readStore,
  writeStore,
  clearStore,
  removeAccount,
} from './store.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export class AuthError extends Error {
  constructor(message, { code = 'auth_error', status = 401 } = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export function isConfigured() {
  return missingConfig().length === 0;
}

// One-time OAuth state values: CSRF protection for the callback. Shared by the
// web UI and the MCP tools so either can start a consent flow.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

export function issueState() {
  const state = crypto.randomUUID();
  pendingStates.set(state, Date.now());
  for (const [key, at] of pendingStates) {
    if (Date.now() - at > STATE_TTL_MS) pendingStates.delete(key);
  }
  return state;
}

export function consumeState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const at = pendingStates.get(state);
  pendingStates.delete(state);
  return Date.now() - at <= STATE_TTL_MS;
}

/** URL the user is sent to so they can grant access. */
export function authUrl(state) {
  if (!isConfigured()) {
    throw new AuthError(
      `Missing ${missingConfig().join(', ')} in .env — copy .env.example to .env and fill it in.`,
      { code: 'not_configured', status: 500 },
    );
  }
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scopes.join(' '));
  // offline + consent => Google returns a refresh_token, which is what makes
  // the stored token usable after the 1 hour access token expires.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  // Deliberately NOT sending include_granted_scopes: it merges scopes the user
  // already granted, which makes Google reject the flow when a prior grant
  // (e.g. drive.file) cannot be combined with youtube.
  url.searchParams.set('state', state);
  return url.toString();
}

/** Issue a fresh state and return the matching consent URL. */
export function authUrlForNewState() {
  return authUrl(issueState());
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...params,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data.error || 'token_request_failed';
    const description = data.error_description || res.statusText;
    throw new AuthError(`${code}: ${description}`, {
      code,
      status: code === 'invalid_grant' ? 401 : 400,
    });
  }
  return data;
}

export function normaliseTokens(payload, previous = {}) {
  const now = Date.now();
  const expiresIn = Number(payload.expires_in || 0);
  return {
    access_token: payload.access_token,
    // Google only returns refresh_token on the first consent (or when
    // prompt=consent forces it); keep the previous one otherwise.
    refresh_token: payload.refresh_token || previous.refresh_token || null,
    token_type: payload.token_type || previous.token_type || 'Bearer',
    scope: payload.scope || previous.scope || config.scopes.join(' '),
    expiry_date: expiresIn ? now + expiresIn * 1000 : null,
  };
}

/** Exchange the ?code= from the callback for tokens. Does not store them. */
export async function exchangeCode(code) {
  const payload = await tokenRequest({
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  });
  return normaliseTokens(payload);
}

function persistTokens(accountId, tokens) {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account) throw new AuthError(`Unknown account: ${accountId}`, { code: 'unknown_account' });
  Object.assign(account, tokens, { updatedAt: new Date().toISOString() });
  writeStore(store);
  return account;
}

export async function refreshAccount(accountId, { force = false } = {}) {
  const account = getAccount(accountId);
  if (!account) throw new AuthError('No account stored.', { code: 'no_account' });
  if (!account.refresh_token) {
    throw new AuthError(
      `Account "${account.channelTitle || account.id}" has no refresh token — reconnect or re-import its token.`,
      { code: 'no_refresh_token' },
    );
  }
  const payload = await tokenRequest({
    refresh_token: account.refresh_token,
    grant_type: 'refresh_token',
  });
  return persistTokens(accountId, normaliseTokens(payload, account));
}

/**
 * A currently valid access token for one account (active account by default),
 * refreshed automatically when it is about to expire.
 */
export async function getAccessToken({ accountId, force = false } = {}) {
  const account = accountId ? getAccount(accountId) : getActiveAccount();
  if (!account) {
    throw new AuthError('Not connected to YouTube yet — click "Connect to YouTube".', {
      code: 'not_connected',
    });
  }
  const expiringSoon = !account.expiry_date || account.expiry_date - Date.now() < 120_000;
  if (force || (expiringSoon && account.refresh_token)) {
    const fresh = await refreshAccount(account.id);
    return fresh.access_token;
  }
  return account.access_token;
}

/** Revoke one account at Google and delete it from the store. */
export async function disconnectAccount(accountId) {
  const account = accountId ? getAccount(accountId) : getActiveAccount();
  if (!account) return { removed: false, revoked: false };
  const token = account.refresh_token || account.access_token;
  removeAccount(account.id);
  if (!token) return { removed: true, revoked: false };
  const res = await fetch(REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => null);
  return { removed: true, revoked: Boolean(res && res.ok) };
}

/** Drop every account locally (no revocation). */
export function forgetAllAccounts() {
  clearStore();
}
