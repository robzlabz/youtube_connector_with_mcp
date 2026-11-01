import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const port = Number(process.env.PORT || 3000);

export const config = {
  root,
  host: process.env.HOST || '127.0.0.1',
  port,
  clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  redirectUri:
    (process.env.GOOGLE_REDIRECT_URI || '').trim() ||
    `http://localhost:${port}/oauth2callback`,
  scopes: (process.env.GOOGLE_SCOPES || 'https://www.googleapis.com/auth/youtube')
    .split(/[\s,]+/)
    .filter(Boolean),
  tokenFile: process.env.TOKEN_FILE || path.join(root, 'data', 'tokens.json'),
  uploadDir: path.join(root, 'data', 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024,
};

/** Names of the env vars that still need a value. Empty array = configured. */
export function missingConfig() {
  const missing = [];
  if (!config.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  return missing;
}
