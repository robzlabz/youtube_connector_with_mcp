import fs from 'node:fs';
import { Readable } from 'node:stream';
import { getAccessToken } from './google.js';
import { describeAccount } from './store.js';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3';

export class YouTubeApiError extends Error {
  constructor(message, { status = 500, reason = null, errors = [] } = {}) {
    super(message);
    this.name = 'YouTubeApiError';
    this.status = status;
    this.reason = reason;
    this.errors = errors;
  }
}

async function parseError(res) {
  const text = await res.text().catch(() => '');
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const detail = payload?.error;
  const first = detail?.errors?.[0];
  return new YouTubeApiError(detail?.message || text || res.statusText, {
    status: res.status,
    reason: first?.reason || null,
    errors: detail?.errors || [],
  });
}

function toVideo(item) {
  return {
    id: item.id,
    title: item.snippet?.title || '',
    description: item.snippet?.description || '',
    tags: item.snippet?.tags || [],
    categoryId: item.snippet?.categoryId || null,
    channelTitle: item.snippet?.channelTitle || '',
    publishedAt: item.snippet?.publishedAt || null,
    thumbnail:
      item.snippet?.thumbnails?.medium?.url ||
      item.snippet?.thumbnails?.default?.url ||
      null,
    privacyStatus: item.status?.privacyStatus || null,
    uploadStatus: item.status?.uploadStatus || null,
    duration: item.contentDetails?.duration || null,
    views: Number(item.statistics?.viewCount ?? 0),
    likes: Number(item.statistics?.likeCount ?? 0),
    comments: Number(item.statistics?.commentCount ?? 0),
  };
}

function toPlaylist(item) {
  return {
    id: item.id,
    title: item.snippet?.title || '',
    description: item.snippet?.description || '',
    privacyStatus: item.status?.privacyStatus || null,
    items: Number(item.contentDetails?.itemCount ?? 0),
    thumbnail: item.snippet?.thumbnails?.default?.url || null,
  };
}

const channelCache = new Map(); // accountId -> { at, value }

/**
 * YouTube Data API client bound to one stored account.
 * Every call resolves that account's access token, refreshing it if needed.
 */
export function clientFor(accountId) {
  async function api(pathname, { method = 'GET', query, body } = {}) {
    const token = await getAccessToken({ accountId });
    const url = new URL(`${API}${pathname}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return {};
    return res.json();
  }

  async function getMyChannel({ refresh = false } = {}) {
    const cached = channelCache.get(accountId);
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.value;
    const data = await api('/channels', {
      query: { part: 'snippet,statistics,contentDetails', mine: 'true' },
    });
    const item = data.items?.[0] || null;
    const value = item
      ? {
          id: item.id,
          title: item.snippet?.title || '',
          description: item.snippet?.description || '',
          customUrl: item.snippet?.customUrl || '',
          thumbnail: item.snippet?.thumbnails?.default?.url || null,
          country: item.snippet?.country || null,
          subscribers: Number(item.statistics?.subscriberCount ?? 0),
          videos: Number(item.statistics?.videoCount ?? 0),
          views: Number(item.statistics?.viewCount ?? 0),
          uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
        }
      : null;
    channelCache.set(accountId, { at: Date.now(), value });
    if (value) {
      describeAccount(accountId, {
        channelId: value.id,
        channelTitle: value.title,
        thumbnail: value.thumbnail,
      });
    }
    return value;
  }

  async function listVideos({ maxResults = 25, pageToken } = {}) {
    const channel = await getMyChannel();
    if (!channel?.uploadsPlaylistId) return { items: [], nextPageToken: null };
    const list = await api('/playlistItems', {
      query: {
        part: 'contentDetails',
        playlistId: channel.uploadsPlaylistId,
        maxResults: Math.min(Math.max(Number(maxResults) || 25, 1), 50),
        pageToken,
      },
    });
    const ids = (list.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (ids.length === 0) return { items: [], nextPageToken: list.nextPageToken || null };
    const details = await api('/videos', {
      query: { part: 'snippet,status,statistics,contentDetails', id: ids.join(',') },
    });
    const byId = new Map((details.items || []).map((v) => [v.id, v]));
    return {
      items: ids.map((id) => byId.get(id)).filter(Boolean).map(toVideo),
      nextPageToken: list.nextPageToken || null,
    };
  }

  async function getVideo(videoId) {
    const data = await api('/videos', {
      query: { part: 'snippet,status,statistics,contentDetails', id: videoId },
    });
    const item = data.items?.[0];
    if (!item) throw new YouTubeApiError(`Video ${videoId} not found`, { status: 404 });
    return toVideo(item);
  }

  async function updateVideo(videoId, changes) {
    const current = await getVideo(videoId);
    const snippet = {
      title: changes.title ?? current.title,
      description: changes.description ?? current.description,
      tags: changes.tags ?? current.tags,
      categoryId: String(changes.categoryId ?? current.categoryId ?? '22'),
    };
    const status = {
      privacyStatus: changes.privacyStatus ?? current.privacyStatus ?? 'private',
    };
    const data = await api('/videos', {
      method: 'PUT',
      query: { part: 'snippet,status' },
      body: { id: videoId, snippet, status },
    });
    return toVideo(data);
  }

  async function deleteVideo(videoId) {
    await api('/videos', { method: 'DELETE', query: { id: videoId } });
    return { deleted: true, id: videoId };
  }

  async function uploadVideo({
    filePath,
    size,
    mimeType = 'video/*',
    title,
    description = '',
    tags = [],
    privacyStatus = 'private',
    categoryId = '22',
    madeForKids = false,
    publishAt = null,
    playlistId = null,
  }) {
    const token = await getAccessToken({ accountId });
    const status = {
      privacyStatus,
      selfDeclaredMadeForKids: Boolean(madeForKids),
    };
    if (publishAt) {
      // Scheduled publishing requires the video to be private at upload time.
      status.privacyStatus = 'private';
      status.publishAt = publishAt;
    }
    const metadata = {
      snippet: { title, description, tags, categoryId: String(categoryId) },
      status,
    };

    const initRes = await fetch(
      `${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(size),
          'X-Upload-Content-Type': mimeType,
        },
        body: JSON.stringify(metadata),
      },
    );
    if (!initRes.ok) throw await parseError(initRes);

    const sessionUrl = initRes.headers.get('location');
    if (!sessionUrl) {
      throw new YouTubeApiError('YouTube did not return a resumable upload URL');
    }

    const putRes = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(size),
      },
      body: Readable.toWeb(fs.createReadStream(filePath)),
      duplex: 'half',
    });
    if (!putRes.ok) throw await parseError(putRes);

    const uploaded = await putRes.json();
    const video = toVideo(uploaded);

    if (playlistId) {
      await addVideoToPlaylist(playlistId, video.id);
      video.playlistId = playlistId;
    }
    channelCache.delete(accountId);
    return video;
  }

  async function listPlaylists({ maxResults = 50 } = {}) {
    const data = await api('/playlists', {
      query: { part: 'snippet,status,contentDetails', mine: 'true', maxResults },
    });
    return (data.items || []).map(toPlaylist);
  }

  async function createPlaylist({ title, description = '', privacyStatus = 'private' }) {
    const data = await api('/playlists', {
      method: 'POST',
      query: { part: 'snippet,status' },
      body: { snippet: { title, description }, status: { privacyStatus } },
    });
    return toPlaylist(data);
  }

  async function addVideoToPlaylist(playlistId, videoId) {
    const data = await api('/playlistItems', {
      method: 'POST',
      query: { part: 'snippet' },
      body: {
        snippet: {
          playlistId,
          resourceId: { kind: 'youtube#video', videoId },
        },
      },
    });
    return { id: data.id, playlistId, videoId };
  }

  return {
    accountId,
    getMyChannel,
    listVideos,
    getVideo,
    updateVideo,
    deleteVideo,
    uploadVideo,
    listPlaylists,
    createPlaylist,
    addVideoToPlaylist,
    invalidateChannel: () => channelCache.delete(accountId),
  };
}
