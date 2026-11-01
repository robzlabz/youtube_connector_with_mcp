import {
  upsertAccount,
  listAccounts,
  getAccount,
  getActiveAccount,
  removeAccount,
  setActiveAccount,
  exportAccount,
  exportAll,
} from './store.js';
import { getAccessToken } from './google.js';
import { clientFor } from './youtube.js';

/**
 * Resolve a user/agent supplied account reference. Accepts an account id, a
 * YouTube channel id (UC...), the active-account marker, or a channel title
 * (exact first, then substring). Returns the stored account or null.
 */
export function resolveAccount(reference) {
  if (!reference || reference === 'active' || reference === 'default') return getActiveAccount();
  const accounts = listAccounts();
  const needle = String(reference).trim();
  return (
    accounts.find((a) => a.id === needle) ||
    accounts.find((a) => a.channelId === needle) ||
    accounts.find((a) => (a.channelTitle || '').toLowerCase() === needle.toLowerCase()) ||
    accounts.find((a) => (a.channelTitle || '').toLowerCase().includes(needle.toLowerCase())) ||
    null
  );
}

export function requireAccount(reference) {
  const account = resolveAccount(reference);
  if (account) return account;
  const known = listAccounts();
  throw new Error(
    known.length === 0
      ? 'No YouTube account is connected yet — run youtube_connect_url, or import a token with youtube_import_token.'
      : `Unknown account "${reference}". Known accounts: ${known
          .map((a) => `${a.channelTitle || 'unnamed'} [id: ${a.id}]`)
          .join(', ')}`,
  );
}

/** Validation errors carry a 4xx status so the HTTP layer can pass them through. */
function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function accountView(account) {
  if (!account) return null;
  const active = getActiveAccount();
  return {
    id: account.id,
    channelId: account.channelId,
    channelTitle: account.channelTitle,
    thumbnail: account.thumbnail,
    scope: account.scope,
    expiresAt: account.expiry_date ? new Date(account.expiry_date).toISOString() : null,
    expiresInSeconds: account.expiry_date
      ? Math.max(0, Math.round((account.expiry_date - Date.now()) / 1000))
      : null,
    hasRefreshToken: Boolean(account.refresh_token),
    accessToken: account.access_token || null,
    refreshToken: account.refresh_token || null,
    isActive: active?.id === account.id,
  };
}

export function accountList() {
  return listAccounts().map(accountView);
}

/** Accept a JSON string, a parsed object, or a bare token string. */
function parseImportPayload(input) {
  if (typeof input === 'object' && input !== null) return input;
  const text = String(input || '').trim();
  if (!text) throw badRequest('Empty token payload.');
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw badRequest(`Token payload is not valid JSON: ${error.message}`);
    }
  }
  if (text.startsWith('ya29.')) return { access_token: text };
  if (text.startsWith('1//')) return { refresh_token: text };
  throw badRequest(
    'Unrecognised token payload. Paste the exported JSON (with access_token and refresh_token) or a raw token string.',
  );
}

/**
 * Import tokens produced elsewhere (another machine, OAuth playground, a copied
 * data/tokens.json). Accepts:
 *   - the whole store file   { accounts: [...] }
 *   - one account entry      { access_token, refresh_token, ... }
 *   - a raw token string     "ya29..." or "1//..."
 * The token is verified against YouTube before it is kept.
 */
export async function importTokens(input, { activate = true } = {}) {
  const payload = parseImportPayload(input);

  if (Array.isArray(payload.accounts)) {
    if (payload.accounts.length === 0) throw badRequest('The pasted store has no accounts.');
    const results = [];
    const previousActive = getActiveAccount()?.id ?? null;
    for (const [index, entry] of payload.accounts.entries()) {
      const isLast = index === payload.accounts.length - 1;
      const shouldActivate = payload.activeAccountId
        ? entry.id === payload.activeAccountId
        : isLast && activate;
      results.push(await importSingle(entry, { activate: shouldActivate, previousActive }));
    }
    if (activate && previousActive && !results.some((r) => r.isActive)) {
      // Keep the previously active account active if the file did not name one.
      const stillThere = getAccount(previousActive);
      if (stillThere) setActiveAccount(previousActive);
    }
    return { imported: results.length, accounts: results };
  }

  const previousActive = getActiveAccount()?.id ?? null;
  return { imported: 1, accounts: [await importSingle(payload, { activate, previousActive })] };
}

async function importSingle(entry, { activate, previousActive }) {
  const stored = upsertAccount(entry, { activate: false });
  const client = clientFor(stored.id);

  let channel = null;
  let lastError = null;

  // First try as-is, then force a refresh once (an imported access token is
  // usually already an hour old by the time it is pasted).
  for (const attempt of [1, 2]) {
    try {
      if (attempt === 2) await getAccessToken({ accountId: stored.id, force: true });
      channel = await client.getMyChannel({ refresh: true });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const refreshUsable =
        stored.refresh_token && error.code !== 'invalid_grant' && error.code !== 'no_refresh_token';
      if (!refreshUsable) break;
    }
  }

  if (!channel) {
    removeAccount(stored.id);
    if (activate && previousActive && getAccount(previousActive)) setActiveAccount(previousActive);
    const reason = (lastError?.message || 'unknown error').split('.')[0].slice(0, 140);
    throw badRequest(
      `Token rejected by YouTube: ${reason}. ` +
        (stored.refresh_token
          ? 'Check that the refresh token was issued for this OAuth client id.'
          : 'An access token alone dies after ~1 hour — export the token including refresh_token.'),
      422,
    );
  }

  if (activate) setActiveAccount(stored.id);
  return accountView(getAccount(stored.id));
}

/** Paste-ready export of one account (defaults to the active one). */
export function exportOne(reference) {
  const account = reference ? resolveAccount(reference) : getActiveAccount();
  if (!account) throw new Error('No account to export — connect or import one first.');
  return { id: account.id, ...exportAccount(getAccount(account.id)) };
}

/** Paste-ready export of every account (the whole token file). */
export function exportEverything() {
  return exportAll();
}
