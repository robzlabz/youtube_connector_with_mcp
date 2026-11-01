const state = {
  status: null,
  accounts: [],
  activeAccountId: null,
  videos: [],
  nextPageToken: null,
  playlists: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const nf = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: { message: text } };
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || res.statusText);
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(message, { error = false } = {}) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${error ? ' toast--error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

function banner(message, { error = false, html = false } = {}) {
  const el = $('#banner');
  if (!message) {
    el.hidden = true;
    return;
  }
  if (html) el.innerHTML = message;
  else el.textContent = message;
  el.className = `banner${error ? ' banner--error' : ''}`;
  el.hidden = false;
}

const mask = (value) =>
  !value ? '—' : value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;

const label = (account) => account.channelTitle || account.channelId || account.id;

function humanDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return '';
  const [, d, hh, mm, ss] = m;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (hh) parts.push(`${hh}h`);
  if (mm) parts.push(`${mm}m`);
  if (ss) parts.push(`${ss}s`);
  return parts.join(' ');
}

async function copyText(value, okMessage) {
  try {
    await navigator.clipboard.writeText(value);
    toast(okMessage);
    return true;
  } catch {
    return false;
  }
}

// --- accounts ---------------------------------------------------------------

function renderAccountSelect() {
  const select = $('#accountSelect');
  const addBtn = $('#addAccountBtn');
  const hasAccounts = state.accounts.length > 0;

  select.hidden = !hasAccounts;
  addBtn.hidden = !hasAccounts;

  select.replaceChildren(
    ...state.accounts.map((a) =>
      h('option', {
        value: a.id,
        selected: a.id === state.activeAccountId,
        text: `${label(a)}${a.hasRefreshToken ? '' : ' (no refresh token)'}`,
      }),
    ),
  );
}

async function switchAccount(accountId) {
  if (!accountId || accountId === state.activeAccountId) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(accountId)}/activate`, { method: 'POST' });
    state.videos = [];
    state.nextPageToken = null;
    await loadStatus();
    await Promise.allSettled([loadVideos(), loadPlaylists()]);
    toast(`Switched to ${$('#accountSelect').selectedOptions[0]?.textContent || 'account'}`);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// --- token transfer ---------------------------------------------------------

async function copyActiveToken() {
  if (!state.activeAccountId) return toast('No account selected', { error: true });
  const payload = await api(`/api/accounts/${encodeURIComponent(state.activeAccountId)}/export`);
  const text = JSON.stringify(payload, null, 2);
  $('#exportArea').value = text;
  $('#exportArea').select();
  const copied = await copyText(text, 'Token copied');
  $('#exportStatus').textContent = copied
    ? `${label(payload)} · ${text.length} chars`
    : 'Clipboard blocked — JSON is selected, press Cmd+C';
}

async function copyAllTokens() {
  const payload = await api('/api/export');
  const text = JSON.stringify(payload, null, 2);
  $('#exportArea').value = text;
  $('#exportArea').select();
  const copied = await copyText(text, 'All tokens copied');
  $('#exportStatus').textContent = copied
    ? `${payload.accounts.length} account(s) · ${text.length} chars`
    : 'Clipboard blocked — JSON is selected, press Cmd+C';
}

async function importToken() {
  const text = $('#importArea').value.trim();
  if (!text) return toast('Paste a token JSON first', { error: true });
  const status = $('#importStatus');
  status.textContent = 'Verifying with YouTube…';
  try {
    const result = await api('/api/accounts/import', {
      method: 'POST',
      body: JSON.stringify({ token: text, activate: true }),
    });
    status.textContent = result.accounts
      .map((a) => `${label(a)}${a.hasRefreshToken ? '' : ' (no refresh token)'}`)
      .join(', ');
    $('#importArea').value = '';
    await loadStatus();
    await Promise.allSettled([loadVideos(), loadPlaylists()]);
    toast(`Imported ${result.imported} account(s)`);
  } catch (err) {
    status.textContent = '';
    toast(err.message, { error: true });
  }
}

// --- status -----------------------------------------------------------------

async function loadStatus() {
  state.status = await api('/api/status');
  state.accounts = state.status.accounts || [];
  state.activeAccountId = state.status.activeAccountId;
  renderStatus();
}

function renderStatus() {
  const s = state.status;
  const pill = $('#statusPill');
  const connected = s.connected;
  const configured = s.configured;
  const count = state.accounts.length;

  pill.textContent = connected
    ? count > 1
      ? `connected · ${count} accounts`
      : 'connected'
    : configured
      ? 'not connected'
      : 'not configured';
  pill.className = `pill ${connected ? 'pill--ok' : 'pill--muted'}`;

  renderAccountSelect();
  $('#connectCard').hidden = connected;
  $('#accountCard').hidden = !connected;
  $('#transferCard').hidden = !connected;
  $('#uploadCard').hidden = !connected;
  $('#videosCard').hidden = !connected;
  $('#playlistsCard').hidden = !connected;

  $('#redirectUri').textContent = s.redirectUri;
  const connectBtn = $('#connectBtn');
  connectBtn.disabled = !configured;
  connectBtn.textContent = count > 0 ? 'Connect another YouTube account' : 'Connect to YouTube';
  $('#connectHint').textContent = configured
    ? `Redirect URI must be registered exactly as ${s.redirectUri}`
    : `Missing in .env: ${s.missing.join(', ')}. Copy .env.example to .env and fill it in.`;

  if (!configured) {
    banner(
      `Google credentials are missing (${s.missing.join(', ')}). Create an OAuth client in Google Cloud Console, put the values in <code>.env</code>, then restart the server.`,
      { html: true },
    );
  } else if (s.authError) {
    banner(`Token problem: ${s.authError.message} — refresh the token, or import it again.`, {
      error: true,
    });
  }

  if (connected) renderAccount();
}

function renderAccount() {
  const { channel, token } = state.status;
  const account = state.accounts.find((a) => a.id === state.activeAccountId);

  if (channel) {
    $('#channelTitle').textContent = channel.title;
    $('#channelMeta').textContent = `${channel.customUrl || channel.id} · ${nf.format(channel.subscribers)} subscribers · ${nf.format(channel.videos)} videos · ${nf.format(channel.views)} views`;
    const img = $('#channelAvatar');
    if (channel.thumbnail) {
      img.src = channel.thumbnail;
      img.hidden = false;
    }
  } else {
    $('#channelTitle').textContent = account ? label(account) : 'YouTube account';
    $('#channelMeta').textContent = 'Channel details unavailable — try Refresh token or reconnect.';
  }

  if (!token) return;
  for (const [field, value] of [
    ['accessToken', token.accessToken],
    ['refreshToken', token.refreshToken],
  ]) {
    const input = $(`#${field}`);
    input.dataset.full = value || '';
    input.dataset.revealed = 'false';
    input.value = mask(value);
    const btn = document.querySelector(`[data-reveal="${field}"]`);
    if (btn) btn.textContent = 'Reveal';
  }

  const expiry = $('#tokenExpiry');
  if (token.expiresAt) {
    expiry.textContent = `${new Date(token.expiresAt).toLocaleString()} (in ${Math.max(0, token.expiresInSeconds)}s)`;
  } else {
    expiry.textContent = 'unknown';
  }
  $('#tokenScope').textContent = token.scope || '—';
}

// --- videos -----------------------------------------------------------------

async function loadVideos({ append = false } = {}) {
  const query = new URLSearchParams({ maxResults: '25' });
  if (append && state.nextPageToken) query.set('pageToken', state.nextPageToken);
  const data = await api(`/api/videos?${query}`);
  state.videos = append ? [...state.videos, ...data.items] : data.items;
  state.nextPageToken = data.nextPageToken;
  renderVideos();
}

const CATEGORIES = [
  ['22', 'People & Blogs'],
  ['27', 'Education'],
  ['28', 'Science & Technology'],
  ['20', 'Gaming'],
  ['10', 'Music'],
  ['24', 'Entertainment'],
  ['26', 'Howto & Style'],
  ['25', 'News & Politics'],
  ['23', 'Comedy'],
  ['17', 'Sports'],
  ['19', 'Travel & Events'],
  ['15', 'Pets & Animals'],
  ['2', 'Autos & Vehicles'],
  ['1', 'Film & Animation'],
  ['29', 'Nonprofits & Activism'],
];

function renderVideos() {
  const list = $('#videoList');
  list.replaceChildren();

  if (state.videos.length === 0) {
    list.append(h('p', { class: 'muted', text: 'No videos yet — upload one above.' }));
  }

  for (const video of state.videos) {
    const editor = h('div', { class: 'video__editor', hidden: true });
    const row = h(
      'div',
      { class: 'video' },
      video.thumbnail
        ? h('img', { class: 'video__thumb', src: video.thumbnail, alt: '' })
        : h('div', { class: 'video__thumb' }),
      h(
        'div',
        {},
        h('div', { class: 'video__title', text: video.title }),
        h(
          'div',
          { class: 'video__meta' },
          h('span', { text: video.privacyStatus || 'unknown' }),
          h('span', { text: `${nf.format(video.views)} views` }),
          h('span', { text: video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : '' }),
          video.duration ? h('span', { text: humanDuration(video.duration) }) : null,
          h('a', { href: `https://youtu.be/${video.id}`, target: '_blank', rel: 'noreferrer', text: 'Open ↗' }),
        ),
      ),
      h(
        'div',
        { class: 'video__actions' },
        h('button', {
          class: 'btn',
          text: 'Edit',
          onclick: () => {
            editor.hidden = !editor.hidden;
            if (!editor.hidden && editor.childElementCount === 0) buildEditor(editor, video);
          },
        }),
        h('button', {
          class: 'btn btn--danger',
          text: 'Delete',
          onclick: () => deleteVideo(video),
        }),
      ),
      editor,
    );
    list.append(row);
  }

  $('#loadMoreBtn').hidden = !state.nextPageToken;
}

function buildEditor(editor, video) {
  const title = h('input', { value: video.title, maxlength: '100' });
  const description = h('textarea', { rows: '3', maxlength: '5000' });
  description.value = video.description || '';
  const tags = h('input', { value: (video.tags || []).join(', ') });
  const privacy = h(
    'select',
    {},
    ['private', 'unlisted', 'public'].map((p) =>
      h('option', { value: p, selected: p === video.privacyStatus, text: p }),
    ),
  );
  const category = h(
    'select',
    {},
    CATEGORIES.map(([id, name]) =>
      h('option', { value: id, selected: id === String(video.categoryId), text: name }),
    ),
  );
  const playlist = h(
    'select',
    {},
    h('option', { value: '', text: '— playlist —' }),
    state.playlists.map((p) => h('option', { value: p.id, text: p.title })),
  );

  const save = h('button', {
    class: 'btn btn--primary',
    text: 'Save',
    onclick: async () => {
      try {
        save.disabled = true;
        const updated = await api(`/api/videos/${video.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: title.value.trim(),
            description: description.value,
            tags: tags.value,
            privacyStatus: privacy.value,
            categoryId: category.value,
          }),
        });
        Object.assign(video, updated);
        renderVideos();
        toast('Video updated');
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        save.disabled = false;
      }
    },
  });

  const addToPlaylist = h('button', {
    class: 'btn',
    text: 'Add to playlist',
    onclick: async () => {
      if (!playlist.value) return toast('Pick a playlist first', { error: true });
      try {
        await api(`/api/playlists/${playlist.value}/items`, {
          method: 'POST',
          body: JSON.stringify({ videoId: video.id }),
        });
        toast('Added to playlist');
      } catch (err) {
        toast(err.message, { error: true });
      }
    },
  });

  editor.append(
    h(
      'div',
      { class: 'grid-3' },
      h('div', { class: 'field' }, h('label', { text: 'Title' }), title),
      h('div', { class: 'field' }, h('label', { text: 'Privacy' }), privacy),
      h('div', { class: 'field' }, h('label', { text: 'Category' }), category),
    ),
    h('div', { class: 'field' }, h('label', { text: 'Description' }), description),
    h('div', { class: 'field' }, h('label', { text: 'Tags' }), tags),
    h(
      'div',
      { class: 'actions' },
      playlist,
      addToPlaylist,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', text: 'Close', onclick: () => { editor.hidden = true; } }),
      save,
    ),
  );
}

async function deleteVideo(video) {
  if (!confirm(`Delete "${video.title}"? This cannot be undone.`)) return;
  try {
    await api(`/api/videos/${video.id}`, { method: 'DELETE' });
    state.videos = state.videos.filter((v) => v.id !== video.id);
    renderVideos();
    toast('Video deleted');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// --- playlists --------------------------------------------------------------

async function loadPlaylists() {
  const data = await api('/api/playlists');
  state.playlists = data.items || [];
  const uploadSelect = $('#playlistId');
  uploadSelect.replaceChildren(h('option', { value: '', text: '— none —' }));
  for (const p of state.playlists) {
    uploadSelect.append(h('option', { value: p.id, text: p.title }));
  }
  const list = $('#playlistList');
  list.replaceChildren(
    ...state.playlists.map((p) =>
      h(
        'li',
        {},
        h('span', { text: p.title }),
        h('span', { class: 'muted', text: `${p.privacyStatus} · ${p.items} videos` }),
      ),
    ),
  );
  if (state.playlists.length === 0) {
    list.append(h('li', { class: 'muted', text: 'No playlists yet.' }));
  }
}

// --- upload -----------------------------------------------------------------

function uploadWithProgress(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error?.message || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(formData);
  });
}

// --- wiring -----------------------------------------------------------------

function wire() {
  $('#connectBtn').addEventListener('click', () => {
    window.location.href = '/auth/start';
  });

  $('#addAccountBtn').addEventListener('click', () => {
    window.location.href = '/auth/start';
  });

  $('#accountSelect').addEventListener('change', (e) => switchAccount(e.target.value));

  $('#copyActiveTokenBtn').addEventListener('click', () => {
    copyActiveToken().catch((err) => toast(err.message, { error: true }));
  });

  $('#copyAllTokensBtn').addEventListener('click', () => {
    copyAllTokens().catch((err) => toast(err.message, { error: true }));
  });

  $('#importBtn').addEventListener('click', importToken);

  $('#importFileBtn').addEventListener('click', () => $('#importFile').click());

  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $('#importArea').value = await file.text();
    e.target.value = '';
  });

  $('#refreshTokenBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      btn.disabled = true;
      await api('/api/token/refresh', { method: 'POST' });
      await loadStatus();
      toast('Access token refreshed');
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false;
    }
  });

  $('#disconnectBtn').addEventListener('click', async () => {
    const title = $('#channelTitle').textContent;
    if (!confirm(`Disconnect "${title}" and revoke its token at Google?`)) return;
    try {
      await api('/api/disconnect', { method: 'POST' });
      state.videos = [];
      await loadStatus();
      toast('Account disconnected');
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  for (const btn of document.querySelectorAll('[data-reveal]')) {
    btn.addEventListener('click', () => {
      const input = $(`#${btn.dataset.reveal}`);
      const revealed = input.dataset.revealed === 'true';
      input.dataset.revealed = String(!revealed);
      input.value = revealed ? mask(input.dataset.full) : input.dataset.full || '—';
      btn.textContent = revealed ? 'Reveal' : 'Hide';
    });
  }

  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const input = $(`#${btn.dataset.copy}`);
      const value = input.dataset.full || '';
      if (!value) return toast('Nothing to copy', { error: true });
      const copied = await copyText(value, 'Token copied');
      if (!copied) toast('Clipboard blocked by the browser', { error: true });
    });
  }

  $('#videoFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $('#fileInfo').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    const title = $('#title');
    if (!title.value) title.value = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
  });

  $('#uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#videoFile').files?.[0];
    if (!file) return toast('Pick a video file first', { error: true });

    const btn = $('#uploadBtn');
    const bar = $('#progressBar');
    const wrap = $('#progressWrap');
    const status = $('#uploadStatus');
    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', $('#title').value.trim());
    formData.append('description', $('#description').value);
    formData.append('tags', $('#tags').value);
    formData.append('privacyStatus', $('#privacyStatus').value);
    formData.append('categoryId', $('#categoryId').value);
    formData.append('madeForKids', $('#madeForKids').checked ? 'true' : 'false');
    if ($('#playlistId').value) formData.append('playlistId', $('#playlistId').value);
    const publishAt = $('#publishAt').value;
    if (publishAt) formData.append('publishAt', new Date(publishAt).toISOString());

    btn.disabled = true;
    wrap.hidden = false;
    bar.style.width = '0%';
    status.textContent = 'Sending to the local server…';

    try {
      const video = await uploadWithProgress(formData, (ratio) => {
        bar.style.width = `${Math.round(ratio * 100)}%`;
        if (ratio >= 1) status.textContent = 'Uploading to YouTube (this can take a while)…';
      });
      bar.style.width = '100%';
      status.textContent = '';
      toast(`Uploaded: ${video.title} (${video.privacyStatus})`);
      $('#uploadForm').reset();
      $('#fileInfo').textContent = '';
      await loadVideos();
    } catch (err) {
      status.textContent = '';
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false;
      wrap.hidden = true;
    }
  });

  $('#reloadVideosBtn').addEventListener('click', () => {
    loadVideos().catch((err) => toast(err.message, { error: true }));
  });

  $('#loadMoreBtn').addEventListener('click', () => {
    loadVideos({ append: true }).catch((err) => toast(err.message, { error: true }));
  });

  $('#playlistForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#newPlaylistTitle').value.trim();
    if (!title) return;
    try {
      await api('/api/playlists', {
        method: 'POST',
        body: JSON.stringify({ title, privacyStatus: $('#newPlaylistPrivacy').value }),
      });
      $('#newPlaylistTitle').value = '';
      await loadPlaylists();
      toast('Playlist created');
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

async function boot() {
  wire();
  const params = new URLSearchParams(window.location.search);
  if (params.get('connected')) {
    toast('Connected to YouTube');
    history.replaceState({}, '', '/');
  }
  if (params.get('error')) {
    banner(`Google returned an error: ${params.get('error')}`, { error: true });
    history.replaceState({}, '', '/');
  }

  const config = await api('/api/config');
  $('#redirectUri').textContent = config.redirectUri;

  await loadStatus();

  if (state.status?.connected) {
    await Promise.allSettled([loadVideos(), loadPlaylists()]);
  }
}

boot().catch((err) => {
  banner(err.message, { error: true });
});
