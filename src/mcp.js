import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, missingConfig } from './config.js';
import * as google from './google.js';
import * as store from './store.js';
import * as accounts from './accounts.js';
import { clientFor } from './youtube.js';

const SERVER_INFO = { name: 'youtube-connector', version: '1.1.0' };

const ACCOUNT_ARG = z
  .string()
  .optional()
  .describe(
    'Which connected account: account id, YouTube channel id (UC...), or channel title. Omit to use the active account.',
  );

const INSTRUCTIONS = `Tools for the YouTube accounts connected to this local app (${config.redirectUri}). Several accounts can be connected at once.

Start here:
1. Call youtube_status: {configured, connected, activeAccountId, accounts[], channel, tokenExpiresInSeconds}.
2. Not connected? Call youtube_connect_url and give the URL to the user (they open it, choose a channel, approve). Calling it again adds another account.
3. Tokens from another machine or another OAuth flow? youtube_import_token accepts pasted JSON. youtube_export_token returns paste-ready JSON to move an account elsewhere.

Choosing an account: every tool takes an optional "account" argument (id, channel id, or title). Omit it for the active account; youtube_accounts with "activate" switches the active one.

Tools:
- Read: youtube_list_videos, youtube_get_video, youtube_list_playlists.
- Write: youtube_update_video, youtube_upload_video, youtube_create_playlist, youtube_add_video_to_playlist, youtube_delete_video.
- Anything not wrapped: youtube_get_token returns a valid access token plus a curl example for the YouTube Data API v3.

Facts:
- This server runs on the user's machine, so youtube_upload_video takes an absolute local file path (no upload).
- 1 upload costs 1600 of the 10000 daily quota units; uploads default to privacyStatus "private".
- youtube_delete_video is permanent. Confirm with the user first.
- Access tokens expire after ~1 hour and refresh automatically; ask the user to reconnect only when a tool reports an auth error. A pasted access token without refresh_token dies after that hour, so prefer exporting with the refresh token.`;

function text(value) {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function fail(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${error?.message || String(error)}` }],
  };
}

/** Wrap a tool body so thrown errors become MCP tool errors, not protocol errors. */
function tool(fn) {
  return async (args) => {
    try {
      return text(await fn(args ?? {}));
    } catch (error) {
      return fail(error);
    }
  };
}

function requireConfigured() {
  if (!google.isConfigured()) {
    throw new Error(
      `Missing ${missingConfig().join(', ')} in .env — ask the user to add Google OAuth credentials first.`,
    );
  }
}

function accountFor(reference) {
  const account = accounts.requireAccount(reference);
  return { account, client: clientFor(account.id) };
}

function buildServer() {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  // --- accounts -------------------------------------------------------------

  server.registerTool(
    'youtube_status',
    {
      title: 'Connection status',
      description:
        'Report configuration, connected accounts, which one is active, channel summary and token expiry. Call this first.',
      inputSchema: { account: ACCOUNT_ARG },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ account }) => {
      const active = accounts.resolveAccount(account || null);
      const payload = {
        configured: google.isConfigured(),
        missingConfig: missingConfig(),
        connected: Boolean(active),
        activeAccountId: active?.id ?? null,
        accounts: accounts.accountList(),
        channel: null,
        token: null,
        authError: null,
      };
      if (active) {
        const view = store.publicTokenView(active);
        payload.token = {
          accountId: active.id,
          expiresAt: view.expiresAt,
          expiresInSeconds: view.expiresInSeconds,
          hasRefreshToken: Boolean(view.refreshToken),
        };
        try {
          payload.channel = await clientFor(active.id).getMyChannel();
        } catch (error) {
          payload.authError = { code: error.code || 'error', message: error.message };
        }
      }
      return payload;
    }),
  );

  server.registerTool(
    'youtube_accounts',
    {
      title: 'List or switch accounts',
      description:
        'List every connected account (id, channel, expiry, active flag). Pass "activate" (id, channel id or title) to make one active.',
      inputSchema: {
        activate: z
          .string()
          .optional()
          .describe('Account id, YouTube channel id, or channel title to switch the active account to.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    tool(async ({ activate }) => {
      let switched = null;
      if (activate) {
        const account = accounts.requireAccount(activate);
        store.setActiveAccount(account.id);
        switched = { id: account.id, channelTitle: account.channelTitle };
      }
      return {
        activeAccountId: store.getActiveAccount()?.id ?? null,
        switched,
        accounts: accounts.accountList(),
      };
    }),
  );

  server.registerTool(
    'youtube_connect_url',
    {
      title: 'Start OAuth for an account',
      description:
        'Return a one-time Google consent URL (10 minutes). The user opens it, picks a channel and approves; that channel becomes a connected account. Call again to add another account.',
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      requireConfigured();
      return {
        url: google.authUrlForNewState(),
        redirectUri: config.redirectUri,
        scopes: config.scopes,
        note: 'Open in a browser and approve. Expires in 10 minutes, single use.',
      };
    }),
  );

  server.registerTool(
    'youtube_import_token',
    {
      title: 'Import tokens (paste)',
      description:
        'Connect an account from tokens produced elsewhere. Accepts the JSON from youtube_export_token, a copied data/tokens.json (whole multi-account file), a single {access_token, refresh_token} object, or a raw token string. Verified against YouTube before it is kept.',
      inputSchema: {
        token: z
          .string()
          .describe('Paste-ready token JSON (single account or whole store), as a string.'),
        activate: z.boolean().default(true).describe('Make the imported account active.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    tool(async ({ token, activate }) => {
      const result = await accounts.importTokens(token, { activate: activate !== false });
      return {
        imported: result.imported,
        accounts: result.accounts.map((a) => ({
          id: a.id,
          channelId: a.channelId,
          channelTitle: a.channelTitle,
          isActive: a.isActive,
          hasRefreshToken: a.hasRefreshToken,
        })),
      };
    }),
  );

  server.registerTool(
    'youtube_export_token',
    {
      title: 'Export tokens (copy)',
      description:
        'Return paste-ready JSON for one account, or for all accounts with all=true. Feed it to youtube_import_token on another machine to move the connection.',
      inputSchema: {
        account: ACCOUNT_ARG,
        all: z.boolean().default(false).describe('Export every account as one store file.'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ account, all }) => (all ? accounts.exportEverything() : accounts.exportOne(account || null))),
  );

  server.registerTool(
    'youtube_get_token',
    {
      title: 'Get a valid access token',
      description:
        'Return a currently valid access token (refreshed if needed) plus a ready-to-run curl example, for YouTube Data API v3 endpoints this server does not wrap.',
      inputSchema: { account: ACCOUNT_ARG },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ account }) => {
      const { account: resolved } = accountFor(account);
      const accessToken = await google.getAccessToken({ accountId: resolved.id, force: true });
      return {
        accountId: resolved.id,
        channelTitle: resolved.channelTitle,
        accessToken,
        tokenType: 'Bearer',
        expiresAt: store.publicTokenView(store.getAccount(resolved.id))?.expiresAt,
        example: `curl -s -H "Authorization: Bearer ${accessToken}" "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true"`,
      };
    }),
  );

  // --- videos ---------------------------------------------------------------

  server.registerTool(
    'youtube_list_videos',
    {
      title: 'List channel videos',
      description:
        'List the newest videos on an account (25 by default, 50 max), newest first. Use pageToken from the previous result for the next page.',
      inputSchema: {
        maxResults: z.number().int().min(1).max(50).optional().describe('Page size, 1-50. Default 25.'),
        pageToken: z.string().optional().describe('nextPageToken from a previous call.'),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ maxResults, pageToken, account }) =>
      accountFor(account).client.listVideos({ maxResults: maxResults ?? 25, pageToken }),
    ),
  );

  server.registerTool(
    'youtube_get_video',
    {
      title: 'Get one video',
      description: 'Full details (snippet, status, statistics, duration) of one video by ID.',
      inputSchema: {
        videoId: z.string().min(1).describe('YouTube video ID, e.g. "dQw4w9WgXcQ".'),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ videoId, account }) => accountFor(account).client.getVideo(videoId)),
  );

  server.registerTool(
    'youtube_update_video',
    {
      title: 'Update video metadata',
      description:
        'Change title, description, tags, category or privacy of an existing video. Only the fields you pass change. privacyStatus: private | unlisted | public.',
      inputSchema: {
        videoId: z.string().min(1),
        title: z.string().min(1).max(100).optional(),
        description: z.string().max(5000).optional(),
        tags: z.array(z.string()).optional(),
        categoryId: z.string().optional().describe('YouTube category ID, default 22 (People & Blogs).'),
        privacyStatus: z.enum(['private', 'unlisted', 'public']).optional(),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ videoId, account, ...changes }) =>
      accountFor(account).client.updateVideo(videoId, changes),
    ),
  );

  server.registerTool(
    'youtube_upload_video',
    {
      title: 'Upload a video',
      description:
        'Upload a local video file to an account via resumable upload. Costs 1600 quota units. Defaults to privacyStatus "private". Confirm title and privacy with the user first.',
      inputSchema: {
        filePath: z
          .string()
          .min(1)
          .describe('Absolute path to the video file on this machine, e.g. /Users/me/Movies/demo.mp4.'),
        title: z.string().min(1).max(100),
        description: z.string().max(5000).optional(),
        tags: z.array(z.string()).optional(),
        privacyStatus: z.enum(['private', 'unlisted', 'public']).default('private'),
        categoryId: z.string().optional().describe('YouTube category ID, default 22 (People & Blogs).'),
        playlistId: z.string().optional().describe('Add the new video to this playlist afterwards.'),
        madeForKids: z.boolean().optional(),
        publishAt: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp to schedule publishing; forces privacyStatus "private".'),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    tool(async ({ filePath, account, ...rest }) => {
      const { client } = accountFor(account);
      const { statSync } = await import('node:fs');
      const { extname } = await import('node:path');

      let info;
      try {
        info = statSync(filePath);
      } catch {
        throw new Error(`File not found: ${filePath}`);
      }
      if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`);
      if (info.size === 0) throw new Error(`File is empty: ${filePath}`);

      const mimes = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
        '.webm': 'video/webm',
        '.flv': 'video/x-flv',
        '.wmv': 'video/x-ms-wmv',
        '.m4v': 'video/x-m4v',
      };

      const video = await client.uploadVideo({
        filePath,
        size: info.size,
        mimeType: mimes[extname(filePath).toLowerCase()] || 'video/*',
        title: rest.title,
        description: rest.description ?? '',
        tags: rest.tags ?? [],
        privacyStatus: rest.privacyStatus ?? 'private',
        categoryId: rest.categoryId ?? '22',
        madeForKids: rest.madeForKids ?? false,
        publishAt: rest.publishAt ?? null,
        playlistId: rest.playlistId ?? null,
      });
      return { ...video, url: `https://youtu.be/${video.id}` };
    }),
  );

  server.registerTool(
    'youtube_delete_video',
    {
      title: 'Delete a video',
      description:
        'Permanently delete a video from an account. Irreversible — confirm with the user before calling.',
      inputSchema: { videoId: z.string().min(1), account: ACCOUNT_ARG },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    tool(async ({ videoId, account }) => accountFor(account).client.deleteVideo(videoId)),
  );

  server.registerTool(
    'youtube_list_playlists',
    {
      title: 'List playlists',
      description: 'List an account playlists with id, title, privacy and item count.',
      inputSchema: { account: ACCOUNT_ARG },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ account }) => ({ items: await accountFor(account).client.listPlaylists() })),
  );

  server.registerTool(
    'youtube_create_playlist',
    {
      title: 'Create a playlist',
      description: 'Create a new playlist on an account.',
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        privacyStatus: z.enum(['private', 'unlisted', 'public']).default('private'),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    tool(async (args) =>
      accountFor(args.account).client.createPlaylist({
        title: args.title,
        description: args.description ?? '',
        privacyStatus: args.privacyStatus ?? 'private',
      }),
    ),
  );

  server.registerTool(
    'youtube_add_video_to_playlist',
    {
      title: 'Add video to playlist',
      description: 'Add an existing video to one of the account playlists.',
      inputSchema: {
        playlistId: z.string().min(1),
        videoId: z.string().min(1),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    tool(async ({ playlistId, videoId, account }) =>
      accountFor(account).client.addVideoToPlaylist(playlistId, videoId),
    ),
  );

  return server;
}

/**
 * MCP Streamable HTTP endpoint: one URL, POST for client messages, JSON or SSE
 * responses. Stateless (no Mcp-Session-Id) so any client can call it directly.
 */
export function mcpRoutes() {
  async function handle(req, res) {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  const notAllowed = (_req, res) =>
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });

  return { post: handle, get: notAllowed, delete: notAllowed };
}

export const mcpEndpointUrl = `http://localhost:${config.port}/mcp`;
