(function () {
  const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://nostr.wine'
  ];

  const KIND_PROFILE = 0;
  const KIND_REACTION = 7;
  const KIND_LIVE_EVENT = 30311;
  const KIND_LIVE_CHAT = 1311;
  const KIND_ZAP_RECEIPT = 9735;

  const LOCAL_NSEC_STORAGE_KEY = 'nostrflux_local_nsec';
  const NOSTR_TOOLS_SRC = 'https://unpkg.com/nostr-tools/lib/nostr.bundle.js';
  const HLS_JS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
  const SETTINGS_STORAGE_KEY = 'nostrflux_settings_v1';
  const FOLLOWING_STORAGE_KEY = 'nostrflux_following_pubkeys_v1';

  const DEFAULT_SETTINGS = {
    relays: [...DEFAULT_RELAYS],
    autoPublish: true,
    miniPlayer: true,
    showZapNotifications: true,
    showNip05Badges: true,
    compactChat: false,
    animateZaps: true,
    lud16: '',
    website: '',
    banner: ''
  };

  const state = {
    relays: [...DEFAULT_RELAYS],
    settings: { ...DEFAULT_SETTINGS },
    pool: null,
    user: null,
    authMode: 'readonly',
    localSecretKey: null,
    pendingOnboardingNsec: '',
    streamsByAddress: new Map(),
    profilesByPubkey: new Map(),
    profileNotesByPubkey: new Map(),
    profileStatsByPubkey: new Map(),
    liveSubId: null,
    profileSubId: null,
    chatSubId: null,
    profileFeedSubId: null,
    profileStatsSubId: null,
    selectedStreamAddress: null,
    selectedProfilePubkey: null,
    selectedProfileLiveAddress: null,
    profileTab: 'streams',
    profileBioExpandedByPubkey: new Map(),
    isLive: false,
    hlsInstance: null,
    playbackToken: 0,
    profileHlsInstance: null,
    profilePlaybackToken: 0,
    relayPulseTimer: null,
    followedPubkeys: new Set(),
    scriptPromises: {}
  };

  class RelayPool {
    constructor(urls, onStatus) {
      this.urls = [...new Set(urls)];
      this.onStatus = onStatus;
      this.sockets = new Map();
      this.subscriptions = new Map();
      this.connectAll();
    }

    connectAll() {
      this.urls.forEach((url) => this.connect(url));
    }

    connect(url) {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (_) {
        this.onStatus(url, 'error');
        return;
      }

      ws.addEventListener('open', () => {
        this.onStatus(url, 'open');
        this.subscriptions.forEach((sub, id) => {
          this.send(url, ['REQ', id, ...sub.filters]);
        });
      });

      ws.addEventListener('message', (msg) => {
        let data;
        try {
          data = JSON.parse(msg.data);
        } catch (_) {
          return;
        }
        if (!Array.isArray(data)) return;
        const type = data[0];
        if (type === 'EVENT') {
          const sub = this.subscriptions.get(data[1]);
          if (sub && sub.handlers && typeof sub.handlers.event === 'function') {
            sub.handlers.event(data[2], url);
          }
        } else if (type === 'EOSE') {
          const sub = this.subscriptions.get(data[1]);
          if (sub && sub.handlers && typeof sub.handlers.eose === 'function') {
            sub.handlers.eose(url);
          }
        } else if (type === 'OK') {
          const eventId = data[1];
          const ok = data[2];
          const reason = data[3] || '';
          if (window.console && !ok) {
            console.warn('Relay reject', url, eventId, reason);
          }
        }
      });

      ws.addEventListener('error', () => this.onStatus(url, 'error'));
      ws.addEventListener('close', () => {
        this.onStatus(url, 'closed');
        setTimeout(() => this.connect(url), 3000);
      });

      this.sockets.set(url, ws);
    }

    send(url, payload) {
      const ws = this.sockets.get(url);
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(payload));
      return true;
    }

    subscribe(filters, handlers) {
      const id = `sub_${Math.random().toString(36).slice(2, 10)}`;
      this.subscriptions.set(id, { filters, handlers });
      this.urls.forEach((url) => {
        this.send(url, ['REQ', id, ...filters]);
      });
      return id;
    }

    unsubscribe(id) {
      this.subscriptions.delete(id);
      this.urls.forEach((url) => {
        this.send(url, ['CLOSE', id]);
      });
    }

    publish(event) {
      let sent = 0;
      this.urls.forEach((url) => {
        if (this.send(url, ['EVENT', event])) sent += 1;
      });
      return sent;
    }

    destroy() {
      this.subscriptions.forEach((_value, id) => {
        this.urls.forEach((url) => this.send(url, ['CLOSE', id]));
      });
      this.subscriptions.clear();
      this.sockets.forEach((ws) => {
        try {
          ws.close();
        } catch (_) {
          // ignore
        }
      });
      this.sockets.clear();
    }
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function shortHex(hex) {
    if (!hex || hex.length < 16) return hex || '';
    return `${hex.slice(0, 8)}...${hex.slice(-8)}`;
  }

  function toUnixSeconds(dtLocal) {
    if (!dtLocal) return null;
    const t = new Date(dtLocal).getTime();
    if (Number.isNaN(t)) return null;
    return Math.floor(t / 1000);
  }

  function fromUnixSeconds(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const yyyy = d.getUTCFullYear();
    const mm = `${d.getUTCMonth() + 1}`.padStart(2, '0');
    const dd = `${d.getUTCDate()}`.padStart(2, '0');
    const hh = `${d.getUTCHours()}`.padStart(2, '0');
    const mi = `${d.getUTCMinutes()}`.padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  function pickAvatar(seed) {
    const pool = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    if (!seed) return pool[0];
    let sum = 0;
    for (let i = 0; i < seed.length; i += 1) sum += seed.charCodeAt(i);
    return pool[sum % pool.length];
  }

  function loadExternalScript(src, globalName, timeoutMs = 15000) {
    const key = `${src}::${globalName}`;
    if (state.scriptPromises[key]) return state.scriptPromises[key];
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);

    state.scriptPromises[key] = new Promise((resolve, reject) => {
      const existing = qsa(`script[src="${src}"]`)[0];
      if (existing) {
        const started = Date.now();
        const timer = setInterval(() => {
          if (globalName && window[globalName]) {
            clearInterval(timer);
            resolve(window[globalName]);
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            reject(new Error(`Timed out loading ${src}`));
          }
        }, 100);
        return;
      }

      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => {
        if (globalName && !window[globalName]) {
          reject(new Error(`${globalName} did not load from ${src}`));
          return;
        }
        resolve(globalName ? window[globalName] : true);
      };
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });

    return state.scriptPromises[key];
  }

  async function ensureNostrTools() {
    if (window.NostrTools) return window.NostrTools;
    return loadExternalScript(NOSTR_TOOLS_SRC, 'NostrTools');
  }

  async function ensureHlsJs() {
    if (window.Hls) return window.Hls;
    return loadExternalScript(HLS_JS_SRC, 'Hls');
  }

  function hexToBytes(hex) {
    const clean = (hex || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(clean)) {
      throw new Error('Invalid hex private key.');
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function normalizeSecretKey(secret) {
    if (!secret) throw new Error('Missing secret key');
    if (secret instanceof Uint8Array) return secret;
    if (Array.isArray(secret)) return Uint8Array.from(secret);
    if (typeof secret === 'string') return hexToBytes(secret);
    throw new Error('Unsupported secret key format');
  }

  function isLikelyUrl(v) {
    return typeof v === 'string' && /^https?:\/\//i.test(v.trim());
  }

  function normalizeTwitterLink(value) {
    const raw = (value || '').trim();
    if (!raw) return { url: '', label: '' };
    if (isLikelyUrl(raw)) return { url: raw, label: raw };
    let handle = raw.replace(/^@+/, '');
    handle = handle.replace(/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i, '');
    handle = handle.split(/[/?#]/)[0] || '';
    if (!handle) return { url: '', label: '' };
    return { url: `https://x.com/${handle}`, label: `@${handle}` };
  }

  function normalizeGithubLink(value) {
    const raw = (value || '').trim();
    if (!raw) return { url: '', label: '' };
    if (isLikelyUrl(raw)) return { url: raw, label: raw };
    let handle = raw.replace(/^@+/, '');
    handle = handle.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
    handle = handle.split(/[/?#]/)[0] || '';
    if (!handle) return { url: '', label: '' };
    return { url: `https://github.com/${handle}`, label: handle };
  }

  function setProfileVerificationStyle(isVerified) {
    const identityBox = qs('#profileIdentityBox');
    const avatar = qs('#profAv');
    if (identityBox) identityBox.classList.toggle('nip05-verified', !!isVerified);
    if (avatar) avatar.classList.toggle('nip05-verified', !!isVerified);
  }

  function setAvatarEl(el, pictureValue, fallbackText) {
    if (!el) return;
    const raw = (pictureValue || '').trim();
    el.innerHTML = '';

    if (isLikelyUrl(raw)) {
      const img = document.createElement('img');
      img.src = raw;
      img.alt = 'avatar';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      img.onerror = () => { el.textContent = fallbackText; };
      el.appendChild(img);
      return;
    }

    if (raw) {
      el.textContent = raw;
      return;
    }

    el.textContent = fallbackText;
  }

  function loadSettingsFromStorage() {
    let saved = {};
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      saved = raw ? JSON.parse(raw) : {};
    } catch (_) {
      saved = {};
    }

    const merged = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    if (!Array.isArray(merged.relays) || merged.relays.length === 0) {
      merged.relays = [...DEFAULT_RELAYS];
    }
    merged.relays = [...new Set(merged.relays.map((r) => (r || '').trim()).filter((r) => /^wss:\/\//i.test(r)))];
    if (!merged.relays.length) merged.relays = [...DEFAULT_RELAYS];

    state.settings = merged;
    state.relays = [...merged.relays];
  }

  function persistSettings() {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings));
    } catch (_) {
      // no-op
    }
  }

  function loadFollowedPubkeys() {
    let saved = [];
    try {
      const raw = localStorage.getItem(FOLLOWING_STORAGE_KEY);
      saved = raw ? JSON.parse(raw) : [];
    } catch (_) {
      saved = [];
    }

    const list = Array.isArray(saved) ? saved : [];
    state.followedPubkeys = new Set(
      list
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => /^[0-9a-f]{64}$/i.test(v))
    );
  }

  function persistFollowedPubkeys() {
    try {
      localStorage.setItem(FOLLOWING_STORAGE_KEY, JSON.stringify(Array.from(state.followedPubkeys)));
    } catch (_) {
      // no-op
    }
  }

  function isFollowingPubkey(pubkey) {
    return !!(pubkey && state.followedPubkeys.has(pubkey));
  }

  function setFollowingPubkey(pubkey, on) {
    if (!pubkey) return;
    if (on) state.followedPubkeys.add(pubkey);
    else state.followedPubkeys.delete(pubkey);
    persistFollowedPubkeys();
  }

  function applySettingsToDocument() {
    document.body.classList.toggle('hide-nip05', !state.settings.showNip05Badges);
    document.body.classList.toggle('hide-zap-notices', !state.settings.showZapNotifications);
    document.body.classList.toggle('compact-chat', !!state.settings.compactChat);
    document.body.classList.toggle('no-chat-anim', !state.settings.animateZaps);
  }

  function renderSettingsRelayList() {
    const wrap = qs('#settingsRelayList');
    if (!wrap) return;
    wrap.innerHTML = '';

    state.settings.relays.forEach((relay) => {
      const tag = document.createElement('div');
      tag.className = 'relay-tag';
      tag.innerHTML = `${relay} <button class="rem" title="Remove">x</button>`;
      const btn = qs('.rem', tag);
      if (btn) btn.addEventListener('click', () => removeRelayFromSettings(relay));
      wrap.appendChild(tag);
    });
  }

  function removeRelayFromSettings(relay) {
    state.settings.relays = state.settings.relays.filter((r) => r !== relay);
    if (!state.settings.relays.length) state.settings.relays = [...DEFAULT_RELAYS];
    renderSettingsRelayList();
  }

  function addRelayToSettings(relay) {
    const clean = (relay || '').trim();
    if (!/^wss:\/\//i.test(clean)) {
      throw new Error('Relay URL must start with wss://');
    }
    if (!state.settings.relays.includes(clean)) state.settings.relays.push(clean);
    renderSettingsRelayList();
  }

  function setToggleById(id, isOn) {
    const el = qs(`#${id}`);
    if (!el) return;
    el.classList.toggle('on', !!isOn);
  }

  function isToggleOn(id) {
    const el = qs(`#${id}`);
    return !!(el && el.classList.contains('on'));
  }

  function populateSettingsModal() {
    renderSettingsRelayList();
    const lud16 = qs('#settingsLud16Input');
    const web = qs('#settingsWebsiteInput');
    const banner = qs('#settingsBannerInput');

    const up = state.user ? profileFor(state.user.pubkey) : null;
    if (lud16) lud16.value = (up && up.lud16) || state.settings.lud16 || '';
    if (web) web.value = (up && up.website) || state.settings.website || '';
    if (banner) banner.value = (up && up.banner) || state.settings.banner || '';

    setToggleById('setAutoPublishToggle', state.settings.autoPublish);
    setToggleById('setMiniPlayerToggle', state.settings.miniPlayer);
    setToggleById('setZapNoticeToggle', state.settings.showZapNotifications);
    setToggleById('setNip05Toggle', state.settings.showNip05Badges);
    setToggleById('setCompactToggle', state.settings.compactChat);
    setToggleById('setAnimateToggle', state.settings.animateZaps);
  }

  function collectSettingsFromModal() {
    const lud16 = qs('#settingsLud16Input');
    const web = qs('#settingsWebsiteInput');
    const banner = qs('#settingsBannerInput');

    return {
      ...state.settings,
      relays: [...state.settings.relays],
      autoPublish: isToggleOn('setAutoPublishToggle'),
      miniPlayer: isToggleOn('setMiniPlayerToggle'),
      showZapNotifications: isToggleOn('setZapNoticeToggle'),
      showNip05Badges: isToggleOn('setNip05Toggle'),
      compactChat: isToggleOn('setCompactToggle'),
      animateZaps: isToggleOn('setAnimateToggle'),
      lud16: (lud16 && lud16.value.trim()) || '',
      website: (web && web.value.trim()) || '',
      banner: (banner && banner.value.trim()) || ''
    };
  }

  function rebuildRelayPool() {
    if (state.pool) {
      try {
        state.pool.destroy();
      } catch (_) {
        // ignore
      }
    }

    state.pool = new RelayPool(state.relays, () => updateRelayBar());
    updateRelayBar();
    subscribeLive();

    if (state.selectedStreamAddress) {
      const current = state.streamsByAddress.get(state.selectedStreamAddress);
      if (current) subscribeChat(current);
    }

    if (state.selectedProfilePubkey) {
      subscribeProfileFeed(state.selectedProfilePubkey);
      subscribeProfileStats(state.selectedProfilePubkey);
    }

    if (state.relayPulseTimer) clearInterval(state.relayPulseTimer);
    state.relayPulseTimer = setInterval(updateRelayBar, 5000);
  }

  function applySettings(newSettings, opts = { reconnect: false }) {
    state.settings = { ...newSettings, relays: [...newSettings.relays] };
    state.relays = [...state.settings.relays];
    persistSettings();
    applySettingsToDocument();

    if (opts.reconnect) {
      rebuildRelayPool();
    }
  }

  function formatCount(n) {
    const v = Number(n || 0);
    if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return `${v}`;
  }

  function formatTimeAgo(ts) {
    const now = Math.floor(Date.now() / 1000);
    const d = Math.max(1, now - Number(ts || now));
    if (d < 60) return `${d}s`;
    if (d < 3600) return `${Math.floor(d / 60)}m`;
    if (d < 86400) return `${Math.floor(d / 3600)}h`;
    if (d < 604800) return `${Math.floor(d / 86400)}d`;
    return `${Math.floor(d / 604800)}w`;
  }


  function formatNostrAge(ts) {
    const start = Number(ts || 0);
    if (!start) return '-';
    const now = Math.floor(Date.now() / 1000);
    const seconds = Math.max(0, now - start);
    const days = Math.floor(seconds / 86400);
    if (days < 1) return 'less than a day';
    if (days < 30) return `${days} day${days === 1 ? '' : 's'}`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
    const years = Math.floor(months / 12);
    const remMonths = months % 12;
    if (!remMonths) return `${years} year${years === 1 ? '' : 's'}`;
    return `${years}y ${remMonths}mo`;
  }

  function estimateProfileFirstSeen(pubkey, profile) {
    let earliest = Number((profile && profile.created_at) || 0) || 0;

    const noteMap = state.profileNotesByPubkey.get(pubkey) || new Map();
    noteMap.forEach((ev) => {
      if (!ev || ev.pubkey !== pubkey) return;
      const ts = Number(ev.created_at || 0) || 0;
      if (ts && (!earliest || ts < earliest)) earliest = ts;
    });

    Array.from(state.streamsByAddress.values())
      .filter((s) => s.pubkey === pubkey)
      .forEach((s) => {
        const ts = Number(s.created_at || 0) || 0;
        if (ts && (!earliest || ts < earliest)) earliest = ts;
      });

    return earliest;
  }
  function parseNpubMaybe(input) {
    const val = (input || '').trim();
    if (!val || !val.startsWith('npub1')) return '';
    if (!window.NostrTools || !window.NostrTools.nip19) return '';
    try {
      const dec = window.NostrTools.nip19.decode(val);
      if (dec && dec.type === 'npub') return dec.data;
    } catch (_) {
      return '';
    }
    return '';
  }

  function formatNpubForDisplay(pubkeyOrNpub) {
    const raw = (pubkeyOrNpub || '').trim();
    if (!raw) return '';
    if (raw.startsWith('npub1')) return raw;
    if (!/^[0-9a-f]{64}$/i.test(raw)) return raw;
    if (!window.NostrTools || !window.NostrTools.nip19 || typeof window.NostrTools.nip19.npubEncode !== 'function') {
      return shortHex(raw);
    }
    try {
      return window.NostrTools.nip19.npubEncode(raw);
    } catch (_) {
      return shortHex(raw);
    }
  }

  function parseTags(tags) {
    const map = new Map();
    tags.forEach((t) => {
      if (Array.isArray(t) && t.length > 1) {
        const key = t[0];
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(t.slice(1));
      }
    });
    return map;
  }

  function firstTag(map, key) {
    const vals = map.get(key);
    if (!vals || vals.length === 0) return '';
    return vals[0][0] || '';
  }

  function parseLiveEvent(ev) {
    const tagMap = parseTags(ev.tags || []);
    const d = firstTag(tagMap, 'd') || ev.id.slice(0, 12);
    const status = (firstTag(tagMap, 'status') || 'live').toLowerCase();
    const address = `${KIND_LIVE_EVENT}:${ev.pubkey}:${d}`;
    const starts = Number(firstTag(tagMap, 'starts') || 0) || null;
    const title = firstTag(tagMap, 'title') || (ev.content || '').slice(0, 90) || 'Untitled stream';
    const summary = firstTag(tagMap, 'summary') || ev.content || '';
    const image = firstTag(tagMap, 'image') || firstTag(tagMap, 'thumb') || '';
    const streaming = firstTag(tagMap, 'streaming') || firstTag(tagMap, 'url') || '';
    const participants = Number(firstTag(tagMap, 'current_participants') || 0) || 0;
    return {
      id: ev.id,
      pubkey: ev.pubkey,
      created_at: ev.created_at,
      kind: ev.kind,
      d,
      address,
      status,
      title,
      summary,
      image,
      streaming,
      starts,
      participants,
      raw: ev
    };
  }

  function parseProfile(ev) {
    let obj = {};
    try {
      obj = JSON.parse(ev.content || '{}');
    } catch (_) {
      obj = {};
    }
    return {
      pubkey: ev.pubkey,
      created_at: ev.created_at || 0,
      name: obj.display_name || obj.name || shortHex(ev.pubkey),
      about: obj.about || '',
      picture: obj.picture || '',
      banner: obj.banner || '',
      website: obj.website || '',
      nip05: obj.nip05 || '',
      lud16: obj.lud16 || '',
      twitter: obj.twitter || obj.x || '',
      github: obj.github || ''
    };
  }

  async function signAndPublish(kind, content, tags) {
    if (!state.user) {
      throw new Error('You are in read-only mode. Login to publish.');
    }

    const createdAt = Math.floor(Date.now() / 1000);
    const unsigned = {
      kind,
      created_at: createdAt,
      tags,
      content
    };

    let signed;

    if (state.authMode === 'nip07') {
      if (!window.nostr) throw new Error('NIP-07 signer not available.');
      const nip07Payload = { ...unsigned, pubkey: state.user.pubkey };
      if (typeof window.nostr.signEvent === 'function') {
        signed = await window.nostr.signEvent(nip07Payload);
      } else if (typeof window.nostr.finalizeEvent === 'function') {
        signed = await window.nostr.finalizeEvent(nip07Payload);
      } else {
        throw new Error('Signer does not support signEvent/finalizeEvent.');
      }
    } else if (state.authMode === 'local') {
      const tools = await ensureNostrTools();
      const secret = normalizeSecretKey(state.localSecretKey);
      if (typeof tools.finalizeEvent === 'function') {
        signed = tools.finalizeEvent(unsigned, secret);
      } else {
        const legacy = { ...unsigned, pubkey: tools.getPublicKey(secret) };
        if (typeof tools.getEventHash === 'function') legacy.id = tools.getEventHash(legacy);
        if (typeof tools.signEvent === 'function') {
          legacy.sig = tools.signEvent(legacy, bytesToHex(secret));
        }
        signed = legacy;
      }
    } else {
      throw new Error('You are in read-only mode. Login with extension or nsec key first.');
    }

    const sent = state.pool.publish(signed);
    if (sent === 0) throw new Error('No relay connections are currently open.');
    return signed;
  }

  function updateRelayBar() {
    const bar = qs('#relayBar');
    if (!bar || !state.pool) return;
    let open = 0;
    state.pool.sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) open += 1;
    });
    bar.textContent = `Connected relays: ${open}/${state.relays.length} (${state.relays.join(' | ')})`;
  }

  function upsertStream(stream) {
    const existing = state.streamsByAddress.get(stream.address);
    if (!existing || existing.created_at <= stream.created_at) {
      state.streamsByAddress.set(stream.address, stream);
    }
  }

  function sortedLiveStreams() {
    return Array.from(state.streamsByAddress.values())
      .filter((s) => s.status !== 'ended')
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }

  function profileFor(pubkey) {
    return state.profilesByPubkey.get(pubkey) || {
      pubkey,
      name: shortHex(pubkey),
      about: '',
      picture: '',
      banner: '',
      website: '',
      nip05: '',
      lud16: '',
      twitter: '',
      github: ''
    };
  }

  function renderLiveGrid() {
    const grid = qs('#liveGrid');
    if (!grid) return;
    const streams = sortedLiveStreams().slice(0, 8);
    const label = qs('#liveCountLabel') || qsa('.stream-main .sec-hd .see-all')[0];
    if (label) label.textContent = `See all (${sortedLiveStreams().length}) ->`;

    if (streams.length === 0) {
      grid.innerHTML = '<div class="stream-card"><div class="ci"><div class="ci-title">No live streams found yet. Keep this tab open while relays sync.</div></div></div>';
      return;
    }

    grid.innerHTML = '';
    streams.forEach((stream) => {
      const p = profileFor(stream.pubkey);
      const card = document.createElement('div');
      card.className = 'stream-card';
      card.innerHTML = `
        <div class="ct">
          <div class="ct-inner"><div class="tc t2">LIVE</div></div>
          <div class="cb-live"><span class="live-dot"></span>${stream.status.toUpperCase()}</div>
          <div class="cb-viewers">views ${stream.participants || 0}</div>
        </div>
        <div class="ci">
          <div class="ci-row">
            <div class="ci-av">${pickAvatar(stream.pubkey)}</div>
            <div>
              <div class="ci-title"></div>
              <div class="ci-host"></div>
              <div class="ci-tags"><span class="tag">NIP-53</span></div>
            </div>
          </div>
        </div>`;
      qs('.ci-title', card).textContent = stream.title;
      qs('.ci-host', card).textContent = p.nip05 || p.name;
      card.addEventListener('click', () => openStream(stream.address));
      grid.appendChild(card);
    });

    const following = qs('#followingLiveList');
    if (following) {
      following.innerHTML = '';
      streams.slice(0, 3).forEach((s) => {
        const p = profileFor(s.pubkey);
        const row = document.createElement('div');
        row.className = 'sb-link sb-live';
        row.innerHTML = `<span class="live-ind"></span><div class="sb-av">${pickAvatar(s.pubkey)}</div><span>${p.name}</span>`;
        row.addEventListener('click', () => openStream(s.address));
        following.appendChild(row);
      });
    }
  }

  function renderHero(stream) {
    const hero = qs('.hero-stream');
    if (!hero || !stream) return;
    const p = profileFor(stream.pubkey);
    qs('.hero-title', hero).textContent = stream.title;
    qs('.hero-summary', hero).textContent = stream.summary || 'Live stream on Nostr.';
    const heroAv = qs('.hero-av', hero);
    if (heroAv) setAvatarEl(heroAv, p.picture || '', pickAvatar(stream.pubkey));
    const hostSpan = qs('.hero-host span[style*="font-weight:600"]', hero);
    if (hostSpan) hostSpan.textContent = p.name;
    const nip05 = qs('.hero-host .nip05-badge', hero);
    if (nip05) nip05.style.display = p.nip05 ? 'inline' : 'none';
    const stats = qsa('.hero-stats .h-stat .val', hero);
    if (stats[0]) stats[0].textContent = `${stream.participants || 0}`;
    if (stats[1]) stats[1].textContent = 'sat flow';
    if (stats[2]) stats[2].textContent = stream.starts ? new Date(stream.starts * 1000).toUTCString().slice(17, 22) + ' UTC' : 'live';
    hero.onclick = () => openStream(stream.address);
    const watchBtn = qs('.hero-actions .btn-primary', hero);
    if (watchBtn) {
      watchBtn.onclick = (e) => {
        e.stopPropagation();
        openStream(stream.address);
      };
    }
  }

  function clearPlayback() {
    state.playbackToken += 1;
    if (state.hlsInstance) {
      try {
        state.hlsInstance.destroy();
      } catch (_) {
        // no-op
      }
      state.hlsInstance = null;
    }
  }

  function renderPlaybackFallback(message, url) {
    const playerBg = qs('.player-bg');
    const playerUi = qs('.player-ui');
    if (!playerBg) return;

    if (playerUi) playerUi.style.display = '';
    playerBg.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;padding:1rem;text-align:center;gap:.5rem;color:#d0d7e2;';

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:.85rem;line-height:1.5;';
    msg.textContent = message;
    wrap.appendChild(msg);

    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open stream URL';
      link.style.cssText = 'color:#f7b731;text-decoration:none;font-family:"DM Mono",monospace;font-size:.75rem;';
      wrap.appendChild(link);
    }

    playerBg.appendChild(wrap);
  }

  async function renderVideoPlayback(stream) {
    clearPlayback();

    const token = state.playbackToken;
    const playerBg = qs('.player-bg');
    const playerUi = qs('.player-ui');
    if (!playerBg) return;

    const url = (stream.streaming || '').trim();
    if (!url) {
      if (playerUi) playerUi.style.display = '';
      playerBg.textContent = 'LIVE';
      return;
    }

    if (!/^https?:\/\//i.test(url)) {
      renderPlaybackFallback('This stream uses a non-HTTP source. Open it in your external player.', url);
      return;
    }

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.muted = false;
    video.defaultMuted = false;
    video.playsInline = true;
    video.preload = 'metadata';
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;background:#000;';

    video.addEventListener('error', () => {
      if (token !== state.playbackToken) return;
      renderPlaybackFallback('Playback failed. The stream URL may be offline or unsupported.', url);
    });

    playerBg.innerHTML = '';
    playerBg.appendChild(video);
    if (playerUi) playerUi.style.display = 'none';

    const isHlsUrl = /\.m3u8($|\?)/i.test(url);

    if (isHlsUrl) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
      } else {
        try {
          const Hls = await ensureHlsJs();
          if (token !== state.playbackToken) return;
          if (Hls.isSupported()) {
            const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
            state.hlsInstance = hls;
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data && data.fatal && token === state.playbackToken) {
                renderPlaybackFallback('HLS playback error. Try opening the stream directly.', url);
              }
            });
          } else {
            renderPlaybackFallback('HLS is not supported in this browser.', url);
            return;
          }
        } catch (_) {
          renderPlaybackFallback('Could not load the HLS player library.', url);
          return;
        }
      }
    } else {
      video.src = url;
    }

    try {
      await video.play();
    } catch (_) {
      try {
        video.muted = true;
        await video.play();
      } catch (_) {
        // user gesture may still be required; controls remain visible
      }
    }
  }

  function renderVideo(stream) {
    const p = profileFor(stream.pubkey);
    const title = qs('.sib-title');
    if (title) title.textContent = stream.title;
    const summary = qs('.sib-summary');
    if (summary) summary.textContent = stream.summary || 'Live stream.';
    const av = qs('.sib-av');
    if (av) {
      setAvatarEl(av, p.picture || '', pickAvatar(stream.pubkey));
      av.onclick = () => showProfileByPubkey(stream.pubkey);
    }
    const name = qs('.sib-name');
    if (name) {
      name.textContent = p.name;
      if (p.nip05) {
        const badge = document.createElement('span');
        badge.className = 'nip05-badge';
        badge.title = p.nip05;
        badge.textContent = '\\u2713';
        name.appendChild(document.createTextNode(' '));
        name.appendChild(badge);
      }
    }
    const ident = qs('.sib-identity');
    if (ident) ident.textContent = p.nip05 || shortHex(stream.pubkey);

    const statsN = qsa('.sib-stats-row .ss .n');
    if (statsN[1]) statsN[1].textContent = `${stream.participants || 0}`;
    if (statsN[4]) statsN[4].textContent = `${state.relays.length}`;

    renderVideoPlayback(stream);

    const owner = state.user && state.user.pubkey === stream.pubkey;
    const endBtn = qs('#endStreamBtn');
    if (endBtn) endBtn.classList.toggle('visible', !!owner);
    qsa('.owner-only').forEach((n) => n.classList.toggle('visible', !!owner));
  }

  function renderSearch(term) {
    const box = qs('#searchResults');
    if (!box) return;
    if (!term) {
      box.classList.remove('open');
      return;
    }

    const streams = sortedLiveStreams().filter((s) => s.title.toLowerCase().includes(term) || profileFor(s.pubkey).name.toLowerCase().includes(term)).slice(0, 5);
    const profiles = Array.from(state.profilesByPubkey.values()).filter((p) => (p.name || '').toLowerCase().includes(term) || (p.nip05 || '').toLowerCase().includes(term)).slice(0, 5);

    box.innerHTML = '';

    const streamLabel = document.createElement('span');
    streamLabel.className = 'sr-label';
    streamLabel.textContent = 'Streams';
    box.appendChild(streamLabel);

    streams.forEach((s) => {
      const p = profileFor(s.pubkey);
      const item = document.createElement('div');
      item.className = 'sr-item';
      item.innerHTML = `<div class="sr-av rect">L</div><div><div class="sr-title"></div><div class="sr-sub"></div></div><span class="sr-live">LIVE</span>`;
      qs('.sr-title', item).textContent = s.title;
      qs('.sr-sub', item).textContent = p.name;
      item.addEventListener('click', () => {
        openStream(s.address);
        box.classList.remove('open');
      });
      box.appendChild(item);
    });

    const userLabel = document.createElement('span');
    userLabel.className = 'sr-label';
    userLabel.textContent = 'Users';
    box.appendChild(userLabel);

    profiles.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'sr-item';
      item.innerHTML = `<div class="sr-av"></div><div><div class="sr-title"></div><div class="sr-sub"></div></div>`;
      setAvatarEl(qs('.sr-av', item), p.picture || '', pickAvatar(p.pubkey));
      qs('.sr-title', item).textContent = p.name;
      qs('.sr-sub', item).textContent = p.nip05 || shortHex(p.pubkey);
      item.addEventListener('click', () => {
        showProfileByPubkey(p.pubkey);
        box.classList.remove('open');
      });
      box.appendChild(item);
    });

    box.classList.add('open');
  }

  function renderChatMessage(ev) {
    const sc = qs('#chatScroll');
    if (!sc) return;
    const p = profileFor(ev.pubkey);
    const row = document.createElement('div');
    row.className = 'cmsg';
    row.innerHTML = `<div class="c-av"></div><div class="c-body"><div class="c-name-row"><span class="c-name"></span></div><div class="c-text"></div></div>`;
    setAvatarEl(qs('.c-av', row), p.picture || '', pickAvatar(ev.pubkey));
    const name = qs('.c-name', row);
    name.textContent = p.name;
    name.onclick = () => showProfileByPubkey(ev.pubkey);
    const ctext = qs('.c-text', row);
    ctext.textContent = ev.content || '';
    sc.appendChild(row);
    sc.scrollTop = sc.scrollHeight;
    while (sc.children.length > 120) sc.removeChild(sc.firstChild);
  }

  function setLoggedInUi(on) {
    const out = qs('#navLoggedOut');
    const inn = qs('#navLoggedIn');
    if (out) out.classList.toggle('off', on);
    if (inn) inn.classList.toggle('on', on);
  }

  function setUserUi() {
    if (!state.user) {
      setLoggedInUi(false);
      return;
    }
    setLoggedInUi(true);
    const p = state.user.profile || { name: shortHex(state.user.pubkey), nip05: '' };
    const av = pickAvatar(state.user.pubkey);
    const pic = (p.picture || '').trim();
    const navAvatar = qs('#navAvatar');
    const navName = qs('#navDisplayName');
    const pdAv = qs('#pdAvLg');
    const pdName = qs('#pdName');
    const pdSub = qs('#pdSub');
    const navBadge = qs('#navNip05Badge');
    const pdBadge = qs('#pdBadge');

    if (navAvatar) setAvatarEl(navAvatar, pic, av);
    if (pdAv) setAvatarEl(pdAv, pic, av);
    if (navName) navName.textContent = p.name;
    if (pdName) pdName.childNodes[0].textContent = `${p.name} `;
    if (pdSub) { const base = p.nip05 || shortHex(state.user.pubkey); pdSub.textContent = state.authMode === 'local' ? `${base} (local key)` : base; }
    if (navBadge) navBadge.style.display = p.nip05 ? 'inline' : 'none';
    if (pdBadge) pdBadge.style.display = p.nip05 ? 'inline' : 'none';
  }

  function subscribeProfiles(pubkeys) {
    if (!pubkeys.length) return;
    if (state.profileSubId) state.pool.unsubscribe(state.profileSubId);
    state.profileSubId = state.pool.subscribe(
      [{ kinds: [KIND_PROFILE], authors: [...new Set(pubkeys)], limit: pubkeys.length * 2 }],
      {
        event: (ev) => {
          if (ev.kind !== KIND_PROFILE) return;
          state.profilesByPubkey.set(ev.pubkey, parseProfile(ev));
          if (state.user && state.user.pubkey === ev.pubkey) {
            state.user.profile = state.profilesByPubkey.get(ev.pubkey);
            setUserUi();
          }
          renderLiveGrid();
          const sel = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
          if (sel) renderVideo(sel);
          if (state.selectedProfilePubkey === ev.pubkey) renderProfilePage(ev.pubkey);
        }
      }
    );
  }

  function subscribeLive() {
    if (state.liveSubId) state.pool.unsubscribe(state.liveSubId);
    state.liveSubId = state.pool.subscribe(
      [{ kinds: [KIND_LIVE_EVENT], limit: 200, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7 }],
      {
        event: (ev) => {
          const stream = parseLiveEvent(ev);
          upsertStream(stream);
        },
        eose: () => {
          renderLiveGrid();
          const streams = sortedLiveStreams();
          if (streams.length && !state.selectedStreamAddress) {
            renderHero(streams[0]);
          }
          const pubs = streams.map((s) => s.pubkey);
          subscribeProfiles(pubs);
          if (state.selectedProfilePubkey) renderProfilePage(state.selectedProfilePubkey);
        }
      }
    );
  }

  function subscribeChat(stream) {
    if (!stream) return;
    if (state.chatSubId) state.pool.unsubscribe(state.chatSubId);
    const sc = qs('#chatScroll');
    if (sc) sc.innerHTML = '';

    const filters = [{
      kinds: [KIND_LIVE_CHAT],
      '#a': [stream.address],
      limit: 200,
      since: Math.floor(Date.now() / 1000) - 60 * 60 * 8
    }];

    state.chatSubId = state.pool.subscribe(filters, {
      event: (ev) => renderChatMessage(ev)
    });
  }

  function openStream(address) {
    const stream = state.streamsByAddress.get(address);
    if (!stream) return;
    state.selectedStreamAddress = address;
    renderVideo(stream);
    subscribeChat(stream);
    window.showVideoPage();
  }

    function clearProfilePlayback() {
    state.profilePlaybackToken += 1;
    if (state.profileHlsInstance) {
      try {
        state.profileHlsInstance.destroy();
      } catch (_) {
        // no-op
      }
      state.profileHlsInstance = null;
    }
  }

  function renderProfilePlaybackFallback(message, url) {
    const host = qs('#profileLivePlayer');
    if (!host) return;
    host.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.4rem;width:100%;height:100%;padding:.9rem;text-align:center;';

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:.78rem;color:var(--text2);line-height:1.5;';
    msg.textContent = message;
    wrap.appendChild(msg);

    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open stream URL';
      link.style.cssText = 'font-family:"DM Mono",monospace;color:var(--zap);font-size:.7rem;text-decoration:none;';
      wrap.appendChild(link);
    }

    host.appendChild(wrap);
  }

  async function renderProfileLivePlayback(stream) {
    clearProfilePlayback();

    const host = qs('#profileLivePlayer');
    if (!host) return;
    const url = (stream.streaming || '').trim();

    if (!url || !/^https?:\/\//i.test(url)) {
      renderProfilePlaybackFallback('Live stream metadata is available, but no browser-playable URL was found.', url);
      return;
    }

    const token = state.profilePlaybackToken;
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.muted = false;
    video.defaultMuted = false;
    video.playsInline = true;
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;background:#000;';
    host.innerHTML = '';
    host.appendChild(video);

    video.addEventListener('error', () => {
      if (token !== state.profilePlaybackToken) return;
      renderProfilePlaybackFallback('Profile live playback failed in this browser.', url);
    });

    const isHlsUrl = /\.m3u8($|\?)/i.test(url);
    if (isHlsUrl) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
      } else {
        try {
          const Hls = await ensureHlsJs();
          if (token !== state.profilePlaybackToken) return;
          if (!Hls.isSupported()) {
            renderProfilePlaybackFallback('HLS is not supported in this browser.', url);
            return;
          }

          const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
          state.profileHlsInstance = hls;
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data && data.fatal && token === state.profilePlaybackToken) {
              renderProfilePlaybackFallback('HLS playback failed. Open stream directly instead.', url);
            }
          });
        } catch (_) {
          renderProfilePlaybackFallback('Could not load HLS playback library.', url);
          return;
        }
      }
    } else {
      video.src = url;
    }

    try {
      await video.play();
    } catch (_) {
      try {
        video.muted = true;
        await video.play();
      } catch (_) {
        // user gesture may still be required
      }
    }
  }

  function getLatestLiveByPubkey(pubkey) {
    return Array.from(state.streamsByAddress.values())
      .filter((s) => s.pubkey === pubkey && s.status === 'live')
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0] || null;
  }


  function getTagValues(ev, key) {
    const values = [];
    (ev && Array.isArray(ev.tags) ? ev.tags : []).forEach((tag) => {
      if (Array.isArray(tag) && tag[0] === key && tag[1]) values.push(tag[1]);
    });
    return values;
  }

  function isTopLevelProfilePost(ev, pubkey) {
    if (!ev || ev.kind !== 1 || ev.pubkey !== pubkey) return false;
    return getTagValues(ev, 'e').length === 0;
  }

  function pickReferencedPostId(ev, postIdSet) {
    const refs = getTagValues(ev, 'e');
    for (let i = refs.length - 1; i >= 0; i -= 1) {
      if (postIdSet.has(refs[i])) return refs[i];
    }
    return '';
  }

  function classifyReactionContent(content) {
    const val = String(content || '').trim().toLowerCase();
    if (!val || val === '+' || val === 'like' || val === '?' || val === '??' || val === '??') return 'like';
    return 'emoji';
  }

  function buildProfilePostAggregates(pubkey, posts) {
    const map = state.profileNotesByPubkey.get(pubkey) || new Map();
    const postIdSet = new Set(posts.map((p) => p.id));
    const statsByPost = new Map();
    const commentsByPost = new Map();

    posts.forEach((post) => {
      statsByPost.set(post.id, { likes: 0, emoji: 0, boosts: 0, zaps: 0 });
      commentsByPost.set(post.id, []);
    });

    map.forEach((ev) => {
      if (!ev || !ev.id) return;
      const ref = pickReferencedPostId(ev, postIdSet);
      if (!ref) return;

      const stats = statsByPost.get(ref);
      if (!stats) return;

      if (ev.kind === 6) {
        stats.boosts += 1;
        return;
      }

      if (ev.kind === KIND_REACTION) {
        const bucket = classifyReactionContent(ev.content);
        if (bucket === 'like') stats.likes += 1;
        else stats.emoji += 1;
        return;
      }

      if (ev.kind === KIND_ZAP_RECEIPT) {
        stats.zaps += 1;
        return;
      }

      if (ev.kind === 1 && !isTopLevelProfilePost(ev, pubkey)) {
        const list = commentsByPost.get(ref);
        if (list) list.push(ev);
      }
    });

    commentsByPost.forEach((list) => {
      list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    });

    return { statsByPost, commentsByPost };
  }

  function stripMediaUrlsFromText(text, mediaUrls) {
    let out = String(text || '');
    mediaUrls.forEach((url) => {
      out = out.split(url).join(' ');
    });
    return out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  function renderPostMedia(container, mediaItems) {
    if (!container || !mediaItems.length) return;
    container.classList.add('profile-feed-media');
    if (mediaItems.length === 1) container.classList.add('one');

    mediaItems.slice(0, 4).forEach((m) => {
      if (m.kind === 'photo') {
        const link = document.createElement('a');
        link.className = 'profile-feed-photo';
        link.href = m.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';

        const img = document.createElement('img');
        img.src = m.url;
        img.alt = 'Post image';
        img.loading = 'lazy';
        link.appendChild(img);
        container.appendChild(link);
        return;
      }

      if (m.kind === 'video') {
        const frame = document.createElement('div');
        frame.className = 'profile-feed-video';

        if (/\.m3u8($|\?)/i.test(m.url)) {
          const a = document.createElement('a');
          a.href = m.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'Open HLS video';
          frame.appendChild(a);
        } else {
          const v = document.createElement('video');
          v.src = m.url;
          v.controls = true;
          v.playsInline = true;
          v.preload = 'metadata';
          frame.appendChild(v);
        }

        container.appendChild(frame);
      }
    });
  }
  function renderProfileFeedInto(listEl, notes, profile, pubkey, aggregates) {
    if (!listEl) return;

    if (!notes.length) {
      listEl.innerHTML = '<div class="profile-feed-empty">No notes found yet for this profile.</div>';
      return;
    }

    listEl.innerHTML = '';
    notes.slice(0, 50).forEach((note) => {
      const item = document.createElement('div');
      item.className = 'profile-feed-item';
      item.innerHTML = `
        <div class="profile-feed-head">
          <div class="profile-feed-author">
            <div class="profile-feed-av"></div>
            <div class="profile-feed-meta"><div class="profile-feed-name"></div></div>
          </div>
          <div class="profile-feed-time"></div>
        </div>
        <div class="profile-feed-text"></div>
        <div class="profile-feed-media-wrap"></div>
        <div class="profile-feed-stats">
          <span class="pfs"><strong>0</strong> Likes</span>
          <span class="pfs"><strong>0</strong> Emoji</span>
          <span class="pfs"><strong>0</strong> Boosts</span>
          <span class="pfs"><strong>0</strong> Zaps</span>
          <span class="pfs"><strong>0</strong> Comments</span>
        </div>
        <div class="profile-feed-comments"></div>
        <div class="profile-comment-form">
          <textarea class="profile-comment-input" rows="1" placeholder="Write a comment..."></textarea>
          <button class="profile-comment-btn">Comment</button>
        </div>`;

      setAvatarEl(qs('.profile-feed-av', item), profile.picture || '', pickAvatar(note.pubkey));
      const nameEl = qs('.profile-feed-name', item);
      if (nameEl) nameEl.textContent = profile.name;
      const timeEl = qs('.profile-feed-time', item);
      if (timeEl) timeEl.textContent = `${formatTimeAgo(note.created_at)} ago`;

      const mediaUrls = extractMediaUrlsFromEvent(note);
      const mediaItems = mediaUrls
        .map((url) => ({ url, kind: classifyMediaUrl(url) }))
        .filter((m) => m.kind && isLikelyUrl(m.url));
      const text = stripMediaUrlsFromText(note.content || '', mediaUrls);
      const textEl = qs('.profile-feed-text', item);
      if (textEl) {
        textEl.textContent = text || (mediaItems.length ? '' : '[empty note]');
        textEl.style.display = text || !mediaItems.length ? 'block' : 'none';
      }

      const mediaWrap = qs('.profile-feed-media-wrap', item);
      if (mediaWrap) {
        if (mediaItems.length) renderPostMedia(mediaWrap, mediaItems);
        else mediaWrap.style.display = 'none';
      }

      const stats = (aggregates && aggregates.statsByPost.get(note.id)) || { likes: 0, emoji: 0, boosts: 0, zaps: 0 };
      const comments = (aggregates && aggregates.commentsByPost.get(note.id)) || [];
      const statVals = qsa('.pfs strong', item);
      if (statVals[0]) statVals[0].textContent = `${stats.likes}`;
      if (statVals[1]) statVals[1].textContent = `${stats.emoji}`;
      if (statVals[2]) statVals[2].textContent = `${stats.boosts}`;
      if (statVals[3]) statVals[3].textContent = `${stats.zaps}`;
      if (statVals[4]) statVals[4].textContent = `${comments.length}`;

      const commentsWrap = qs('.profile-feed-comments', item);
      const maxPreview = 3;
      let expandedComments = false;
      const renderComments = () => {
        if (!commentsWrap) return;
        commentsWrap.innerHTML = '';

        if (!comments.length) {
          commentsWrap.innerHTML = '<div class="profile-comment-empty">No comments yet.</div>';
          return;
        }

        const list = expandedComments ? comments : comments.slice(0, maxPreview);
        list.forEach((comment) => {
          const cp = profileFor(comment.pubkey);
          const row = document.createElement('div');
          row.className = 'profile-comment-item';
          row.innerHTML = `
            <div class="profile-comment-av"></div>
            <div class="profile-comment-main">
              <div class="profile-comment-meta"><span class="n"></span><span class="t"></span></div>
              <div class="profile-comment-text"></div>
            </div>`;
          setAvatarEl(qs('.profile-comment-av', row), cp.picture || '', pickAvatar(comment.pubkey));
          const n = qs('.profile-comment-meta .n', row);
          if (n) n.textContent = cp.name;
          const t = qs('.profile-comment-meta .t', row);
          if (t) t.textContent = `${formatTimeAgo(comment.created_at)} ago`;
          const ct = qs('.profile-comment-text', row);
          if (ct) ct.textContent = (comment.content || '').trim() || '[empty comment]';
          commentsWrap.appendChild(row);
        });

        if (comments.length > maxPreview) {
          const more = document.createElement('button');
          more.className = 'profile-comments-more';
          more.textContent = expandedComments
            ? 'Show fewer comments'
            : `Show ${comments.length - maxPreview} more comments`;
          more.addEventListener('click', () => {
            expandedComments = !expandedComments;
            renderComments();
          });
          commentsWrap.appendChild(more);
        }
      };
      renderComments();

      const commentInput = qs('.profile-comment-input', item);
      const commentBtn = qs('.profile-comment-btn', item);
      if (commentBtn && commentInput) {
        commentBtn.addEventListener('click', async () => {
          const content = (commentInput.value || '').trim();
          if (!content) return;
          if (!state.user) {
            window.openLogin();
            return;
          }

          commentBtn.disabled = true;
          const original = commentBtn.textContent;
          commentBtn.textContent = 'Posting...';
          try {
            const tags = [['e', note.id], ['p', note.pubkey]];
            const signed = await signAndPublish(1, content, tags);
            const map = state.profileNotesByPubkey.get(pubkey) || new Map();
            map.set(signed.id, signed);
            state.profileNotesByPubkey.set(pubkey, map);
            commentInput.value = '';
            renderProfileFeed(pubkey);
          } catch (err) {
            if (window.console) console.warn('Could not post comment', err);
          } finally {
            commentBtn.disabled = false;
            commentBtn.textContent = original;
          }
        });
      }

      listEl.appendChild(item);
    });
  }

  function renderProfileFeed(pubkey) {
    const leftList = qs('#profileFeedList');
    const tabList = qs('#profileFeedListSide');
    const count = qs('#profileFeedCount');

    const map = state.profileNotesByPubkey.get(pubkey) || new Map();
    const notes = Array.from(map.values())
      .filter((ev) => isTopLevelProfilePost(ev, pubkey))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    if (count) count.textContent = `${notes.length} notes`;

    const aggregates = buildProfilePostAggregates(pubkey, notes);
    const profile = profileFor(pubkey);
    renderProfileFeedInto(leftList, notes, profile, pubkey, aggregates);
    renderProfileFeedInto(tabList, notes, profile, pubkey, aggregates);
  }

  function extractHttpUrls(text) {
    const raw = (text || '').match(/https?:\/\/\S+/gi) || [];
    return raw.map((url) => url.replace(/[),.;!?]+$/g, ''));
  }

  function classifyMediaUrl(url) {
    const base = (url || '').split('#')[0].split('?')[0].toLowerCase();
    if (/\.(mp4|webm|mov|m4v|mkv|m3u8)$/.test(base)) return 'video';
    if (/\.(jpg|jpeg|png|gif|webp|avif)$/.test(base)) return 'photo';
    return '';
  }

  function extractMediaUrlsFromEvent(ev) {
    const urls = extractHttpUrls(ev && ev.content ? ev.content : '');
    const tags = (ev && Array.isArray(ev.tags)) ? ev.tags : [];
    tags.forEach((tag) => {
      if (!Array.isArray(tag) || tag.length < 2) return;
      const key = String(tag[0] || '').toLowerCase();
      const value = String(tag[1] || '').trim();
      if (!/^https?:\/\//i.test(value)) return;
      if (key === 'url' || key === 'r' || key === 'image' || key === 'thumb' || key === 'streaming') {
        urls.push(value);
      }
    });
    return Array.from(new Set(urls));
  }

  function collectProfileMedia(pubkey) {
    const map = state.profileNotesByPubkey.get(pubkey) || new Map();
    const notes = Array.from(map.values())
      .filter((ev) => (ev.pubkey === pubkey) && (ev.kind === 1 || ev.kind === 20 || ev.kind === 21 || ev.kind === 22 || ev.kind === 1063))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const videos = [];
    const photos = [];
    const seenVideo = new Set();
    const seenPhoto = new Set();

    notes.forEach((note) => {
      const urls = extractMediaUrlsFromEvent(note);
      const caption = (note.content || '').trim();
      urls.forEach((url) => {
        const kind = classifyMediaUrl(url);
        if (kind === 'video' && !seenVideo.has(url) && videos.length < 36) {
          videos.push({ url, note, caption });
          seenVideo.add(url);
        }
        if (kind === 'photo' && !seenPhoto.has(url) && photos.length < 72) {
          photos.push({ url, note, caption });
          seenPhoto.add(url);
        }
      });
    });

    return { videos, photos };
  }

  function renderProfilePastStreams(pubkey) {
    const list = qs('#profilePastStreamsList');
    if (!list) return;

    const items = Array.from(state.streamsByAddress.values())
      .filter((stream) => stream.pubkey === pubkey && stream.status !== 'live')
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, 24);

    if (!items.length) {
      list.innerHTML = '<div class="profile-feed-empty">No past streams found yet.</div>';
      return;
    }

    list.innerHTML = '';
    items.forEach((stream) => {
      const row = document.createElement('div');
      row.className = 'profile-stream-item';

      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'profile-stream-title';
      title.textContent = stream.title || 'Untitled stream';
      const meta = document.createElement('div');
      meta.className = 'profile-stream-meta';
      meta.textContent = `${(stream.status || 'past').toUpperCase()} - ${formatTimeAgo(stream.created_at)} ago`;
      left.appendChild(title);
      left.appendChild(meta);

      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-ghost';
      openBtn.style.padding = '.28rem .58rem';
      openBtn.style.fontSize = '.72rem';
      openBtn.textContent = 'Open';
      openBtn.disabled = !stream.address;
      openBtn.addEventListener('click', () => {
        if (stream.address) openStream(stream.address);
      });

      row.appendChild(left);
      row.appendChild(openBtn);
      list.appendChild(row);
    });
  }

  function renderProfileVideos(media) {
    const wrap = qs('#profileVideosList');
    if (!wrap) return;

    if (!media.videos.length) {
      wrap.innerHTML = '<div class="profile-feed-empty">No short videos detected in recent notes.</div>';
      return;
    }

    wrap.innerHTML = '';
    media.videos.slice(0, 18).forEach((item) => {
      const card = document.createElement('div');
      card.className = 'profile-video-card';

      const frame = document.createElement('div');
      frame.className = 'profile-video-frame';
      if (/\.m3u8($|\?)/i.test(item.url)) {
        const fallback = document.createElement('div');
        fallback.className = 'profile-video-fallback';
        fallback.innerHTML = 'HLS video<br><a href="#" style="color:var(--zap)">Open</a>';
        const link = qs('a', fallback);
        if (link) {
          link.href = item.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        frame.appendChild(fallback);
      } else {
        const video = document.createElement('video');
        video.src = item.url;
        video.controls = true;
        video.autoplay = true;
        video.loop = true;
        video.muted = false;
        video.defaultMuted = false;
        video.playsInline = true;
        video.preload = 'metadata';
        frame.appendChild(video);
        video.play().catch(() => {
          video.muted = true;
          video.play().catch(() => {});
        });
      }

      const meta = document.createElement('div');
      meta.className = 'profile-video-meta';
      const caption = document.createElement('div');
      caption.className = 'profile-video-caption';
      caption.textContent = item.caption || item.url;
      const time = document.createElement('div');
      time.className = 'profile-video-time';
      time.textContent = `${formatTimeAgo(item.note.created_at)} ago`;
      meta.appendChild(caption);
      meta.appendChild(time);

      card.appendChild(frame);
      card.appendChild(meta);
      wrap.appendChild(card);
    });
  }

  function renderProfilePhotos(media) {
    const wrap = qs('#profilePhotosList');
    if (!wrap) return;

    if (!media.photos.length) {
      wrap.innerHTML = '<div class="profile-feed-empty">No photo posts detected in recent notes.</div>';
      return;
    }

    wrap.innerHTML = '';
    media.photos.slice(0, 36).forEach((item) => {
      const card = document.createElement('a');
      card.className = 'profile-photo-card';
      card.href = item.url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';

      const img = document.createElement('img');
      img.src = item.url;
      img.alt = 'Nostr photo';
      img.loading = 'lazy';
      card.appendChild(img);

      const cap = document.createElement('div');
      cap.className = 'profile-photo-cap';
      cap.textContent = item.caption || `${formatTimeAgo(item.note.created_at)} ago`;
      card.appendChild(cap);

      wrap.appendChild(card);
    });
  }

  function renderProfileCollections(pubkey) {
    renderProfilePastStreams(pubkey);
    const media = collectProfileMedia(pubkey);
    renderProfileVideos(media);
    renderProfilePhotos(media);
  }

  function setProfileTab(tabName) {
    const tabMap = {
      posts: 'Posts',
      streams: 'Streams',
      videos: 'Videos',
      photos: 'Photos'
    };

    const postsBtn = qs('#profileTabBtnPosts');
    const postsAllowed = !!(postsBtn && postsBtn.style.display !== 'none');

    let tab = Object.prototype.hasOwnProperty.call(tabMap, tabName) ? tabName : 'streams';
    if (tab === 'posts' && !postsAllowed) tab = 'streams';
    state.profileTab = tab;

    Object.keys(tabMap).forEach((key) => {
      const btn = qs(`#profileTabBtn${tabMap[key]}`);
      if (btn) btn.classList.toggle('active', key === tab);
      const pane = qs(`#profileTab${tabMap[key]}`);
      if (pane) pane.classList.toggle('on', key === tab);
    });
  }

  function subscribeProfileStats(pubkey) {
    if (!pubkey) return;
    if (state.profileStatsSubId) state.pool.unsubscribe(state.profileStatsSubId);

    let followerSet = new Set();
    let followingSet = new Set();
    let latestFollowingCreated = 0;

    state.profileStatsByPubkey.set(pubkey, { followers: 0, following: 0 });

    state.profileStatsSubId = state.pool.subscribe(
      [
        { kinds: [3], authors: [pubkey], limit: 10 },
        { kinds: [3], '#p': [pubkey], limit: 400 }
      ],
      {
        event: (ev) => {
          if (ev.kind !== 3) return;

          if (ev.pubkey === pubkey) {
            const created = Number(ev.created_at || 0);
            if (created >= latestFollowingCreated) {
              latestFollowingCreated = created;
              followingSet = new Set();
              (ev.tags || []).forEach((tag) => {
                if (Array.isArray(tag) && tag[0] === 'p' && tag[1]) followingSet.add(tag[1]);
              });
            }
          } else {
            followerSet.add(ev.pubkey);
          }

          state.profileStatsByPubkey.set(pubkey, {
            followers: followerSet.size,
            following: followingSet.size
          });

          if (state.selectedProfilePubkey === pubkey) renderProfilePage(pubkey);
        },
        eose: () => {
          state.profileStatsByPubkey.set(pubkey, {
            followers: followerSet.size,
            following: followingSet.size
          });
          if (state.selectedProfilePubkey === pubkey) renderProfilePage(pubkey);
        }
      }
    );
  }

  function renderProfileFollowButton(pubkey) {
    const btn = qs('#profileFollowBtn');
    if (!btn) return;

    btn.disabled = false;
    btn.classList.remove('following-active');

    if (!pubkey) {
      btn.textContent = '+ Follow';
      return;
    }

    if (state.user && state.user.pubkey === pubkey) {
      btn.textContent = 'You';
      btn.disabled = true;
      return;
    }

    const following = isFollowingPubkey(pubkey);
    btn.textContent = following ? 'Following' : '+ Follow';
    btn.classList.toggle('following-active', following);
  }

  function subscribeProfileFeed(pubkey) {
    if (!pubkey) return;
    if (state.profileFeedSubId) state.pool.unsubscribe(state.profileFeedSubId);

    const leftList = qs('#profileFeedList');
    const sideList = qs('#profileFeedListSide');
    if (leftList) leftList.innerHTML = '<div class="profile-feed-empty">Loading notes from relays...</div>';
    if (sideList) sideList.innerHTML = '<div class="profile-feed-empty">Loading notes from relays...</div>';

    const existing = state.profileNotesByPubkey.get(pubkey);
    if (!existing) state.profileNotesByPubkey.set(pubkey, new Map());

    state.profileFeedSubId = state.pool.subscribe(
      [
        { kinds: [1, 6, KIND_REACTION, 20, 21, 22, 1063, KIND_ZAP_RECEIPT], authors: [pubkey], limit: 260, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 180 },
        { kinds: [1, 6, KIND_REACTION, KIND_ZAP_RECEIPT], '#p': [pubkey], limit: 520, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 180 }
      ],
      {
        event: (ev) => {
          const map = state.profileNotesByPubkey.get(pubkey) || new Map();
          const current = map.get(ev.id);
          if (!current || (current.created_at || 0) <= (ev.created_at || 0)) {
            map.set(ev.id, ev);
            state.profileNotesByPubkey.set(pubkey, map);
          }
          if (state.selectedProfilePubkey === pubkey) {
            renderProfileFeed(pubkey);
            renderProfileCollections(pubkey);
          }
        },
        eose: () => {
          if (state.selectedProfilePubkey === pubkey) {
            renderProfileFeed(pubkey);
            renderProfileCollections(pubkey);
          }
        }
      }
    );
  }

  function renderProfilePage(pubkey) {
    const p = profileFor(pubkey);

    const profName = qs('#profName');
    if (profName) profName.textContent = p.name;

    setAvatarEl(qs('#profAv'), p.picture || '', pickAvatar(pubkey));

    const nip05Main = qs('#profNip05');
    const nip05Check = qs('#profNip05Check');
    const npubEl = qs('#profNpub');

    if (npubEl) npubEl.textContent = formatNpubForDisplay(pubkey);

    if (p.nip05) {
      if (nip05Main) { nip05Main.style.display = 'flex'; nip05Main.textContent = `NIP-05: ${p.nip05}`; }
      if (nip05Check) nip05Check.style.display = 'inline';
    } else {
      if (nip05Main) nip05Main.style.display = 'none';
      if (nip05Check) nip05Check.style.display = 'none';
    }
    if (npubEl) npubEl.style.display = 'block';
    setProfileVerificationStyle(!!p.nip05);

    const bio = qs('#profBio');
    const bioText = (p.about || 'No bio yet.').trim() || 'No bio yet.';
    if (bio) bio.textContent = bioText;

    const bioToggle = qs('#profBioToggle');
    const isExpanded = !!state.profileBioExpandedByPubkey.get(pubkey);
    if (bio) bio.classList.toggle('clamped', !isExpanded);
    const hasLongBio = bioText.length > 280 || (bioText.match(/\n/g) || []).length >= 5;
    if (bioToggle) {
      bioToggle.style.display = hasLongBio ? 'inline-flex' : 'none';
      bioToggle.textContent = isExpanded ? 'Show less' : 'Show more';
    }

    const websiteRow = qs('#profWebsiteRow');
    const websiteBio = qs('#profWebsiteBio');
    let website = (p.website || '').trim();
    if (website && !isLikelyUrl(website) && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(website)) {
      website = `https://${website}`;
    }
    if (website && isLikelyUrl(website)) {
      if (websiteBio) {
        websiteBio.href = website;
        websiteBio.textContent = website;
      }
      if (websiteRow) websiteRow.style.display = 'inline-flex';
    } else if (websiteRow) {
      websiteRow.style.display = 'none';
    }

    const lud16Row = qs('#profLud16Row');
    const lud16Bio = qs('#profLud16Bio');
    const lud16 = (p.lud16 || '').trim();
    if (lud16) {
      if (lud16Bio) lud16Bio.textContent = lud16;
      if (lud16Row) lud16Row.style.display = 'inline-flex';
    } else if (lud16Row) {
      lud16Row.style.display = 'none';
    }

    const twitterRow = qs('#profTwitterRow');
    const twitterBio = qs('#profTwitterBio');
    const tw = normalizeTwitterLink(p.twitter || '');
    if (tw.url) {
      if (twitterBio) {
        twitterBio.href = tw.url;
        twitterBio.textContent = tw.label || tw.url;
      }
      if (twitterRow) twitterRow.style.display = 'inline-flex';
    } else if (twitterRow) {
      twitterRow.style.display = 'none';
    }

    const githubRow = qs('#profGithubRow');
    const githubBio = qs('#profGithubBio');
    const gh = normalizeGithubLink(p.github || '');
    if (gh.url) {
      if (githubBio) {
        githubBio.href = gh.url;
        githubBio.textContent = gh.label || gh.url;
      }
      if (githubRow) githubRow.style.display = 'inline-flex';
    } else if (githubRow) {
      githubRow.style.display = 'none';
    }

    const bannerImg = qs('#profBannerImg');
    if (bannerImg && p.banner && isLikelyUrl(p.banner)) {
      bannerImg.src = p.banner;
      bannerImg.style.display = 'block';
    } else if (bannerImg) {
      bannerImg.removeAttribute('src');
      bannerImg.style.display = 'none';
    }

    const userStreams = Array.from(state.streamsByAddress.values()).filter((s) => s.pubkey === pubkey);
    const sinceEl = qs('#profNostrSince');
    const firstSeenTs = estimateProfileFirstSeen(pubkey, p);
    if (sinceEl) sinceEl.textContent = firstSeenTs ? ('On Nostr for ' + formatNostrAge(firstSeenTs)) : 'On Nostr for -';

    const followers = qs('#profFollowers');
    const following = qs('#profFollowing');
    const streams = qs('#profStreams');
    const sats = qs('#profSats');
    const stats = state.profileStatsByPubkey.get(pubkey) || { followers: 0, following: 0 };

    if (followers) followers.textContent = formatCount(stats.followers || 0);
    if (following) following.textContent = formatCount(stats.following || 0);
    if (streams) streams.textContent = `${userStreams.length}`;
    if (sats) sats.textContent = `SATS ${formatCount(userStreams.length * 2100)}`;

    const liveWrap = qs('#profileLiveWrap');
    const liveStatus = qs('#profLiveStatus');
    const live = getLatestLiveByPubkey(pubkey);
    state.selectedProfileLiveAddress = live ? live.address : null;

    if (live) {
      if (liveWrap) liveWrap.style.display = 'block';
      if (liveStatus) liveStatus.textContent = 'LIVE';
      renderProfileLivePlayback(live);
    } else {
      if (liveWrap) liveWrap.style.display = 'none';
      if (liveStatus) liveStatus.textContent = 'offline';
      clearProfilePlayback();
    }

    const postsLeft = qs('#profilePostsLeft');
    const postsTabBtn = qs('#profileTabBtnPosts');
    if (live) {
      if (postsLeft) postsLeft.style.display = 'none';
      if (postsTabBtn) postsTabBtn.style.display = 'inline-flex';
    } else {
      if (postsLeft) postsLeft.style.display = 'block';
      if (postsTabBtn) postsTabBtn.style.display = 'none';
      if (state.profileTab === 'posts') state.profileTab = 'streams';
    }

    renderProfileFeed(pubkey);
    renderProfileCollections(pubkey);
    renderProfileFollowButton(pubkey);
    setProfileTab(state.profileTab || 'streams');
  }

  function openStreamFromProfile() {
    if (!state.selectedProfileLiveAddress) return;
    openStream(state.selectedProfileLiveAddress);
  }

  function showProfileByPubkey(pubkey) {
    if (!pubkey) return;
    state.selectedProfilePubkey = pubkey;
    const p = profileFor(pubkey);
    window.showProfile(p.name, pickAvatar(pubkey), formatNpubForDisplay(pubkey), p.nip05, pubkey);
    renderProfilePage(pubkey);
    subscribeProfileFeed(pubkey);
    subscribeProfileStats(pubkey);
  }

  function toggleFollowSelectedProfile() {
    const pubkey = state.selectedProfilePubkey;
    if (!pubkey) return;
    if (state.user && state.user.pubkey === pubkey) return;

    const next = !isFollowingPubkey(pubkey);
    setFollowingPubkey(pubkey, next);

    const current = state.profileStatsByPubkey.get(pubkey) || { followers: 0, following: 0 };
    const nextFollowers = Math.max(0, Number(current.followers || 0) + (next ? 1 : -1));
    state.profileStatsByPubkey.set(pubkey, {
      followers: nextFollowers,
      following: Number(current.following || 0)
    });

    renderProfileFollowButton(pubkey);
    const followers = qs('#profFollowers');
    if (followers) followers.textContent = formatCount(nextFollowers);
  }

  function setAuthenticatedUser(pubkey, authMode) {
    state.authMode = authMode;
    state.user = { pubkey, profile: state.profilesByPubkey.get(pubkey) || null };
    setUserUi();
    window.closeLogin();
    subscribeProfiles([pubkey]);
  }

  async function loginWithExtension() {
    if (!window.nostr || typeof window.nostr.getPublicKey !== 'function') {
      throw new Error('No NIP-07 signer found. You can still use nsec login.');
    }
    const pubkey = await window.nostr.getPublicKey();
    state.localSecretKey = null;
    localStorage.removeItem(LOCAL_NSEC_STORAGE_KEY);
    setAuthenticatedUser(pubkey, 'nip07');
  }

  async function loginWithNsec(nsecOrHex, persist = true) {
    const tools = await ensureNostrTools();
    if (!tools || typeof tools.getPublicKey !== 'function') {
      throw new Error('Could not load local key tools.');
    }

    const input = (nsecOrHex || '').trim();
    if (!input) {
      throw new Error('Enter your nsec key first.');
    }

    let secret;
    if (/^[0-9a-f]{64}$/i.test(input)) {
      secret = hexToBytes(input);
    } else {
      if (!tools.nip19 || typeof tools.nip19.decode !== 'function') {
        throw new Error('Could not load NIP-19 key decoder.');
      }

      let decoded;
      try {
        decoded = tools.nip19.decode(input);
      } catch (_) {
        throw new Error('Invalid nsec key.');
      }

      if (!decoded || decoded.type !== 'nsec') {
        throw new Error('Invalid nsec key.');
      }
      secret = normalizeSecretKey(decoded.data);
    }

    const pubkey = tools.getPublicKey(secret);
    state.localSecretKey = secret;
    if (persist) localStorage.setItem(LOCAL_NSEC_STORAGE_KEY, input);
    setAuthenticatedUser(pubkey, 'local');
  }

  async function publishUserProfile(profileData) {
    if (!state.user) return;

    const payload = {
      name: profileData.name || shortHex(state.user.pubkey),
      display_name: profileData.name || shortHex(state.user.pubkey),
      about: profileData.about || '',
      picture: profileData.picture || '',
      banner: profileData.banner || '',
      website: profileData.website || '',
      lud16: profileData.lud16 || ''
    };

    await signAndPublish(KIND_PROFILE, JSON.stringify(payload), []);

    const merged = {
      ...profileFor(state.user.pubkey),
      pubkey: state.user.pubkey,
      name: payload.display_name,
      about: payload.about,
      picture: payload.picture,
      banner: payload.banner,
      website: payload.website,
      lud16: payload.lud16
    };

    state.profilesByPubkey.set(state.user.pubkey, merged);
    state.user.profile = merged;
    setUserUi();

    if (state.selectedProfilePubkey === state.user.pubkey) {
      renderProfilePage(state.user.pubkey);
    }
  }

  function openOnboarding(prefill = {}) {
    const modal = qs('#onboardingModal');
    if (!modal) return;

    if (qs('#onbNsecValue')) qs('#onbNsecValue').textContent = state.pendingOnboardingNsec || 'nsec1...';
    if (qs('#onbDisplayName')) qs('#onbDisplayName').value = prefill.name || '';
    if (qs('#onbAvatar')) qs('#onbAvatar').value = prefill.picture || '';
    if (qs('#onbBanner')) qs('#onbBanner').value = prefill.banner || state.settings.banner || '';
    if (qs('#onbBio')) qs('#onbBio').value = prefill.about || '';
    if (qs('#onbWebsite')) qs('#onbWebsite').value = prefill.website || state.settings.website || '';
    if (qs('#onbLud16')) qs('#onbLud16').value = prefill.lud16 || state.settings.lud16 || '';

    modal.classList.add('open');
  }

  function closeOnboarding() {
    const modal = qs('#onboardingModal');
    if (modal) modal.classList.remove('open');
  }

  async function copyOnboardingNsec() {
    const value = state.pendingOnboardingNsec || (qs('#onbNsecValue') && qs('#onbNsecValue').textContent) || '';
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      const btn = qs('#onbCopyBtn');
      if (btn) {
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1300);
      }
    } catch (_) {
      alert('Copy failed. Please copy the nsec manually.');
    }
  }

  async function completeOnboarding() {
    const profileData = {
      name: (qs('#onbDisplayName') && qs('#onbDisplayName').value.trim()) || shortHex(state.user ? state.user.pubkey : ''),
      picture: (qs('#onbAvatar') && qs('#onbAvatar').value.trim()) || '',
      banner: (qs('#onbBanner') && qs('#onbBanner').value.trim()) || '',
      about: (qs('#onbBio') && qs('#onbBio').value.trim()) || '',
      website: (qs('#onbWebsite') && qs('#onbWebsite').value.trim()) || '',
      lud16: (qs('#onbLud16') && qs('#onbLud16').value.trim()) || ''
    };

    try {
      await publishUserProfile(profileData);

      const nextSettings = {
        ...state.settings,
        website: profileData.website || state.settings.website,
        banner: profileData.banner || state.settings.banner,
        lud16: profileData.lud16 || state.settings.lud16
      };
      applySettings(nextSettings, { reconnect: false });

      closeOnboarding();
    } catch (err) {
      alert(err.message || 'Failed to publish profile.');
    }
  }

  function skipOnboarding() {
    closeOnboarding();
  }

  async function createLocalIdentity() {
    const saved = (localStorage.getItem(LOCAL_NSEC_STORAGE_KEY) || '').trim();
    if (saved) {
      try {
        await loginWithNsec(saved, false);
        state.pendingOnboardingNsec = saved;
        const current = state.user ? profileFor(state.user.pubkey) : null;
        if (state.user) {
          openOnboarding({
            name: (current && current.name) || '',
            picture: (current && current.picture) || pickAvatar(state.user.pubkey),
            banner: (current && current.banner) || state.settings.banner || '',
            about: (current && current.about) || '',
            website: (current && current.website) || state.settings.website || '',
            lud16: (current && current.lud16) || state.settings.lud16 || ''
          });
          return;
        }
      } catch (err) {
        const msg = (err && err.message ? err.message : '').toLowerCase();
        if (msg.includes('invalid')) {
          localStorage.removeItem(LOCAL_NSEC_STORAGE_KEY);
        } else {
          throw err;
        }
      }
    }

    const tools = await ensureNostrTools();
    const secret = typeof tools.generateSecretKey === 'function'
      ? tools.generateSecretKey()
      : crypto.getRandomValues(new Uint8Array(32));

    const nsec = tools.nip19 && typeof tools.nip19.nsecEncode === 'function'
      ? tools.nip19.nsecEncode(secret)
      : bytesToHex(secret);

    const pubkey = tools.getPublicKey(secret);
    state.localSecretKey = normalizeSecretKey(secret);
    state.pendingOnboardingNsec = nsec;
    localStorage.setItem(LOCAL_NSEC_STORAGE_KEY, nsec);
    setAuthenticatedUser(pubkey, 'local');

    openOnboarding({
      name: '',
      picture: pickAvatar(pubkey),
      banner: state.settings.banner || '',
      website: state.settings.website || '',
      lud16: state.settings.lud16 || ''
    });
  }

  async function tryRestoreLocalLogin() {
    const saved = (localStorage.getItem(LOCAL_NSEC_STORAGE_KEY) || '').trim();
    if (!saved) return false;

    try {
      await loginWithNsec(saved, false);
      return true;
    } catch (err) {
      const msg = (err && err.message ? err.message : '').toLowerCase();
      const permanent = msg.includes('invalid') || msg.includes('unsupported') || msg.includes('missing');
      if (permanent) localStorage.removeItem(LOCAL_NSEC_STORAGE_KEY);
      return false;
    }
  }

  async function publishCurrentStream(statusOverride) {
    if (!state.user) {
      window.openLogin();
      throw new Error('Please login first. Signer is optional: you can use nsec mode.');
    }

    const dTagInput = qs('#goLiveDTag');
    const titleInput = qs('#goLiveTitle');
    const summaryInput = qs('#goLiveSummary');
    const streamUrlInput = qs('#goLiveStreamUrl');
    const thumbInput = qs('#goLiveThumb');
    const startsInput = qs('#goLiveStarts');
    const statusEl = qs('.srow .sc.sl');

    const current = state.streamsByAddress.get(state.selectedStreamAddress);
    const dTag = (statusOverride && current ? current.d : (dTagInput && dTagInput.value.trim())) || `stream-${Date.now()}`;
    const title = (statusOverride && current ? current.title : (titleInput && titleInput.value.trim())) || 'Untitled stream';
    const summary = (statusOverride && current ? current.summary : (summaryInput && summaryInput.value.trim())) || '';
    const streamUrl = (statusOverride && current ? current.streaming : (streamUrlInput && streamUrlInput.value.trim())) || '';
    const thumb = (thumbInput && thumbInput.value.trim()) || '';
    const starts = statusOverride && current ? current.starts : toUnixSeconds(startsInput && startsInput.value);
    const rawStatus = (statusOverride || (statusEl ? statusEl.textContent : 'live')).toLowerCase();
    const status = rawStatus.includes('ended') ? 'ended' : (rawStatus.includes('planned') ? 'planned' : 'live');

    const tags = [
      ['d', dTag],
      ['title', title],
      ['summary', summary],
      ['status', status],
      ['alt', `Live stream: ${title}`]
    ];

    if (streamUrl) tags.push(['streaming', streamUrl]);
    if (thumb) tags.push(['image', thumb]);
    if (starts) tags.push(['starts', `${starts}`]);
    state.relays.forEach((r) => tags.push(['relay', r]));

    const ev = await signAndPublish(KIND_LIVE_EVENT, summary, tags);
    const stream = parseLiveEvent(ev);
    upsertStream(stream);
    state.selectedStreamAddress = stream.address;
    state.isLive = status === 'live';
    renderLiveGrid();
    renderHero(stream);
    renderVideo(stream);
    subscribeChat(stream);
    return stream;
  }

  async function sendChatMessage() {
    const input = qs('.chat-inp');
    const text = (input && input.value.trim()) || '';
    if (!text) return;
    if (!state.user) {
      window.openLogin();
      return;
    }
    const stream = state.streamsByAddress.get(state.selectedStreamAddress);
    if (!stream) return;

    const tags = [
      ['a', stream.address],
      ['e', stream.id],
      ['p', stream.pubkey]
    ];

    try {
      const ev = await signAndPublish(KIND_LIVE_CHAT, text, tags);
      renderChatMessage(ev);
      input.value = '';
    } catch (err) {
      alert(err.message || 'Failed to send chat message.');
    }
  }

  async function sendReaction() {
    const stream = state.streamsByAddress.get(state.selectedStreamAddress);
    if (!stream) return;
    if (!state.user) {
      window.openLogin();
      return;
    }

    const tags = [
      ['e', stream.id],
      ['p', stream.pubkey],
      ['a', stream.address]
    ];

    try {
      await signAndPublish(KIND_REACTION, '+', tags);
      const count = qs('#likeCount');
      if (count) {
        const n = Number(count.textContent || '0') || 0;
        count.textContent = `${n + 1}`;
      }
      const likeBtn = qs('#likeBtn');
      if (likeBtn) likeBtn.classList.add('liked');
    } catch (err) {
      alert(err.message || 'Failed to react.');
    }
  }

  function wireEvents() {
    const searchInput = qs('.search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        renderSearch((e.target.value || '').trim().toLowerCase());
      });
      searchInput.addEventListener('focus', (e) => {
        if ((e.target.value || '').trim()) renderSearch((e.target.value || '').trim().toLowerCase());
      });
    }

    const sendBtn = qs('.chat-send-btn');
    if (sendBtn) sendBtn.addEventListener('click', sendChatMessage);
    const chatInput = qs('.chat-inp');
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });
    }

    const likeBtn = qs('#likeBtn');
    if (likeBtn) likeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendReaction();
    });

    qsa('.srow .sc').forEach((c) => {
      c.addEventListener('click', () => {
        const row = c.closest('.srow');
        qsa('.sc', row).forEach((x) => x.classList.remove('sl'));
        c.classList.add('sl');
      });
    });
  }

  function bindLegacyGlobals() {
    window.toggleDD = function (key) {
      const other = key === 'logo' ? 'profile' : 'logo';
      window.closeDD(other);
      const btnId = key === 'logo' ? 'logoBtn' : 'navUserPill';
      const ddId = key === 'logo' ? 'logoDropdown' : 'profileDropdown';
      const dd = qs(`#${ddId}`);
      const btn = qs(`#${btnId}`);
      const open = dd.classList.contains('open');
      dd.classList.toggle('open', !open);
      btn.classList.toggle('dd-open', !open);
    };

    window.closeDD = function (key) {
      const btnId = key === 'logo' ? 'logoBtn' : 'navUserPill';
      const ddId = key === 'logo' ? 'logoDropdown' : 'profileDropdown';
      const dd = qs(`#${ddId}`);
      const btn = qs(`#${btnId}`);
      if (dd) dd.classList.remove('open');
      if (btn) btn.classList.remove('dd-open');
    };

    window.closeAllDD = function () {
      window.closeDD('logo');
      window.closeDD('profile');
    };

    window.showPage = function (p) {
      const home = qs('#homePage');
      const video = qs('#videoPage');
      const profile = qs('#profilePage');
      if (home) home.classList.toggle('active', p === 'home');
      if (video) video.style.display = 'none';
      if (profile) profile.style.display = 'none';
      if (state.settings.miniPlayer && state.selectedStreamAddress) window.showMini();
      else window.hideMini();
      window.scrollTo(0, 0);
    };

    window.showVideoPage = function () {
      const home = qs('#homePage');
      const video = qs('#videoPage');
      const profile = qs('#profilePage');
      if (home) home.classList.remove('active');
      if (video) video.style.display = 'block';
      if (profile) profile.style.display = 'none';
      if (state.settings.miniPlayer && state.selectedStreamAddress) window.showMini();
      else window.hideMini();
      window.scrollTo(0, 0);
    };

    window.showProfile = function (name, av, npub, nip05, rawPubkey) {
      const home = qs('#homePage');
      const video = qs('#videoPage');
      const profile = qs('#profilePage');
      if (home) home.classList.remove('active');
      if (video) video.style.display = 'none';
      if (profile) profile.style.display = 'block';

      setAvatarEl(qs('#profAv'), '', av || 'U');
      if (qs('#profName')) qs('#profName').textContent = name || 'user';
      if (qs('#profNpub')) qs('#profNpub').textContent = formatNpubForDisplay(npub || rawPubkey || '');
      setProfileVerificationStyle(!!nip05);

      const n05 = qs('#profNip05');
      const n05c = qs('#profNip05Check');
      if (nip05) {
        if (n05) {
          n05.style.display = 'flex';
          n05.textContent = `NIP-05: ${nip05}`;
        }
        if (n05c) n05c.style.display = 'inline';
      } else {
        if (n05) n05.style.display = 'none';
        if (n05c) n05c.style.display = 'none';
      }
      if (qs('#profNpub')) qs('#profNpub').style.display = 'block';

      if (qs('#profBio') && !qs('#profBio').textContent.trim()) {
        qs('#profBio').textContent = 'No bio yet.';
      }

      let inferredPubkey = (/^[0-9a-f]{64}$/i.test(rawPubkey || '') ? rawPubkey : parseNpubMaybe(npub || ''));
      if (!inferredPubkey) {
        const wantedName = (name || '').trim().toLowerCase();
        const wantedNip05 = (nip05 || '').trim().toLowerCase();
        const fallback = Array.from(state.profilesByPubkey.values()).find((entry) => {
          const entryName = (entry.name || '').trim().toLowerCase();
          const entryNip05 = (entry.nip05 || '').trim().toLowerCase();
          if (wantedNip05 && entryNip05 === wantedNip05) return true;
          if (wantedName && entryName === wantedName) return true;
          return false;
        });
        inferredPubkey = fallback ? fallback.pubkey : '';
      }

      if (inferredPubkey) {
        state.selectedProfilePubkey = inferredPubkey;
        renderProfilePage(inferredPubkey);
        subscribeProfileFeed(inferredPubkey);
        subscribeProfileStats(inferredPubkey);
      } else {
        state.selectedProfilePubkey = null;
        state.selectedProfileLiveAddress = null;
        const liveWrap = qs('#profileLiveWrap');
        if (liveWrap) liveWrap.style.display = 'none';
        const feed = qs('#profileFeedList');
        if (feed) feed.innerHTML = '<div class="profile-feed-empty">This profile is in preview mode. Open a relay-backed user to load notes.</div>';
        const feedSide = qs('#profileFeedListSide');
        if (feedSide) feedSide.innerHTML = '<div class="profile-feed-empty">This profile is in preview mode. Open a relay-backed user to load notes.</div>';
        const past = qs('#profilePastStreamsList');
        if (past) past.innerHTML = '<div class="profile-feed-empty">Stream history needs a relay-backed profile.</div>';
        const videos = qs('#profileVideosList');
        if (videos) videos.innerHTML = '<div class="profile-feed-empty">Videos need a relay-backed profile.</div>';
        const photos = qs('#profilePhotosList');
        if (photos) photos.innerHTML = '<div class="profile-feed-empty">Photos need a relay-backed profile.</div>';

        const postsLeft = qs('#profilePostsLeft');
        const postsBtn = qs('#profileTabBtnPosts');
        if (postsLeft) postsLeft.style.display = 'block';
        if (postsBtn) postsBtn.style.display = 'none';
        if (state.profileTab === 'posts') state.profileTab = 'streams';
        renderProfileFollowButton('');
        setProfileVerificationStyle(!!nip05);

        const websiteRow = qs('#profWebsiteRow');
        const lud16Row = qs('#profLud16Row');
        const twitterRow = qs('#profTwitterRow');
        const githubRow = qs('#profGithubRow');
        if (websiteRow) websiteRow.style.display = 'none';
        if (lud16Row) lud16Row.style.display = 'none';
        if (twitterRow) twitterRow.style.display = 'none';
        if (githubRow) githubRow.style.display = 'none';
        const bioToggle = qs('#profBioToggle');
        if (bioToggle) bioToggle.style.display = 'none';
        const nostrSince = qs('#profNostrSince');
        if (nostrSince) nostrSince.textContent = 'On Nostr for -';

        setProfileTab(state.profileTab || 'streams');
      }

      window.scrollTo(0, 0);
    };

    window.goBackFromProfile = function () {
      window.showPage('home');
    };

    window.openMyProfile = function () {
      if (!state.user) {
        window.openLogin();
        return;
      }
      showProfileByPubkey(state.user.pubkey);
    };

    window.switchProfileTab = function (tab) {
      setProfileTab(tab);
    };

    window.toggleProfileBio = function () {
      const pubkey = state.selectedProfilePubkey;
      if (!pubkey) return;
      const current = !!state.profileBioExpandedByPubkey.get(pubkey);
      state.profileBioExpandedByPubkey.set(pubkey, !current);
      renderProfilePage(pubkey);
    };

    window.toggleFollowProfile = function () {
      toggleFollowSelectedProfile();
    };

    window.openProfileMessage = function () {
      const btn = qs('#profileMessageBtn');
      if (btn) {
        const original = btn.textContent;
        btn.textContent = 'Soon';
        setTimeout(() => { btn.textContent = original; }, 1200);
      }
    };

    window.addProfileToList = function () {
      const pubkey = state.selectedProfilePubkey;
      if (!pubkey) return;

      const key = 'nostrflux_profile_list_v1';
      let list = [];
      try {
        const raw = localStorage.getItem(key);
        list = raw ? JSON.parse(raw) : [];
      } catch (_) {
        list = [];
      }

      const set = new Set(Array.isArray(list) ? list : []);
      set.add(pubkey);
      try {
        localStorage.setItem(key, JSON.stringify(Array.from(set)));
      } catch (_) {
        // ignore
      }

      const btn = qs('#profileAddToListBtn');
      if (btn) {
        btn.textContent = 'Saved';
        setTimeout(() => { btn.textContent = 'Add to List'; }, 1200);
      }
    };

    window.shareProfile = async function () {
      const pubkey = state.selectedProfilePubkey;
      if (!pubkey) return;

      const npub = formatNpubForDisplay(pubkey);
      const text = `Nostr profile: ${npub}`;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
        }
      } catch (_) {
        // ignore clipboard failures
      }

      const btn = qs('#profileShareBtn');
      if (btn) {
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Share'; }, 1200);
      }
    };

    window.showMini = function () {
      const m = qs('#miniPlayer');
      if (m) m.classList.add('visible');
    };

    window.hideMini = function () {
      const m = qs('#miniPlayer');
      if (m) m.classList.remove('visible');
    };

    window.closeMini = window.hideMini;
    window.returnToStream = function () { window.showVideoPage(); };

    window.openGoLive = function () {
      if (!state.user) {
        window.openLogin();
        return;
      }
      const dtag = qs('#goLiveDTag');
      if (dtag && !dtag.value.trim()) dtag.value = `stream-${Date.now()}`;
      const starts = qs('#goLiveStarts');
      if (starts && !starts.value) starts.value = fromUnixSeconds(Math.floor(Date.now() / 1000));
      qs('#goLiveModal').classList.add('open');
      qs('#mForm').style.display = 'block';
      qs('#mSuccess').className = 'msuccess';
    };

    window.closeGoLive = function () { qs('#goLiveModal').classList.remove('open'); };

    window.publishStream = async function () {
      try {
        await publishCurrentStream();
        qs('#mForm').style.display = 'none';
        qs('#mSuccess').classList.add('on');
        state.isLive = true;
        qs('#goLiveBtn').style.display = 'none';
        qs('#myLiveBtn').style.display = 'flex';
      } catch (err) {
        alert(err.message || 'Failed to publish stream.');
      }
    };

    window.goToMyStream = function () {
      if (state.selectedStreamAddress) openStream(state.selectedStreamAddress);
      window.closeGoLive();
    };

    window.openEnd = function () { qs('#endModal').classList.add('open'); };
    window.closeEnd = function () { qs('#endModal').classList.remove('open'); };

    window.confirmEndStream = async function () {
      try {
        await publishCurrentStream('ended');
      } catch (err) {
        alert(err.message || 'Failed to publish end event.');
      }
      window.closeEnd();
      state.isLive = false;
      qs('#goLiveBtn').style.display = 'flex';
      qs('#myLiveBtn').style.display = 'none';
      window.showPage('home');
    };

    window.openLogin = function () { qs('#loginModal').classList.add('open'); };
    window.closeLogin = function () { qs('#loginModal').classList.remove('open'); };

    window.loginDemo = async function (name) {
      try {
        if (name === 'keyuser') {
          const nsecInput = qs('.key-inp');
          const nsec = (nsecInput && nsecInput.value.trim()) || '';
          if (!nsec) throw new Error('Enter your nsec key first.');
          await loginWithNsec(nsec, true);
          if (nsecInput) nsecInput.value = '';
          return;
        }

        if (name === 'newnostr') {
          await createLocalIdentity();
          return;
        }

        await loginWithExtension();
      } catch (err) {
        alert(err.message || 'Login failed.');
      }
    };

    window.signOut = function () {
      state.user = null;
      state.authMode = 'readonly';
      state.localSecretKey = null;
      state.pendingOnboardingNsec = '';
      localStorage.removeItem(LOCAL_NSEC_STORAGE_KEY);
      setUserUi();
    };

    window.openSettings = function () {
      populateSettingsModal();
      qs('#settingsModal').classList.add('open');
    };

    window.closeSettings = function () {
      qs('#settingsModal').classList.remove('open');
    };

    window.toggleSetting = function (el) {
      if (el) el.classList.toggle('on');
    };

    window.addRelayFromSettings = function () {
      try {
        const input = qs('#settingsRelayInput');
        const value = (input && input.value.trim()) || '';
        if (!value) return;
        addRelayToSettings(value);
        if (input) input.value = '';
      } catch (err) {
        alert(err.message || 'Invalid relay URL.');
      }
    };

    window.saveSettings = async function () {
      try {
        const next = collectSettingsFromModal();
        const relaysChanged = next.relays.join('|') !== state.settings.relays.join('|');
        applySettings(next, { reconnect: relaysChanged });

        if (state.user) {
          const current = profileFor(state.user.pubkey);
          const shouldUpdateProfile = (next.lud16 !== (current.lud16 || '')) || (next.website !== (current.website || '')) || (next.banner !== (current.banner || ''));
          if (shouldUpdateProfile) {
            await publishUserProfile({
              name: current.name,
              picture: current.picture,
              about: current.about,
              website: next.website,
              banner: next.banner,
              lud16: next.lud16
            });
          }
        }

        window.closeSettings();
      } catch (err) {
        alert(err.message || 'Failed to save settings.');
      }
    };

    window.copyOnboardingNsec = copyOnboardingNsec;
    window.completeOnboarding = completeOnboarding;
    window.skipOnboarding = skipOnboarding;
    window.closeOnboarding = closeOnboarding;
    window.openStreamFromProfile = openStreamFromProfile;

    window.openFaq = function () { qs('#faqModal').classList.add('open'); };
    window.closeFaq = function () { qs('#faqModal').classList.remove('open'); };
    window.toggleFaq = function (el) { el.closest('.faq-item').classList.toggle('open'); };
    window.switchTab = function (t) {
      const isChat = t === 'chat';
      qsa('.stab').forEach((s, i) => s.classList.toggle('active', isChat ? i === 0 : i === 1));
      if (qs('#chatScroll')) qs('#chatScroll').style.display = isChat ? 'flex' : 'none';
      if (qs('#viewersPanel')) qs('#viewersPanel').classList.toggle('on', !isChat);
    };

    window.toggleEmoji = function (ev) {
      ev.stopPropagation();
      qs('#emojiPicker').classList.toggle('open');
    };

    window.closeEmoji = function () {
      qs('#emojiPicker').classList.remove('open');
    };

    window.handleSearch = function (inp) {
      renderSearch((inp.value || '').trim().toLowerCase());
    };

    window.toggleLike = function () {
      sendReaction();
    };
  }

  function initEmojiPicker() {
    const emojis = [':)', ':D', '<3', ':fire:', ':zap:', ':rocket:', ':100:', ':wave:', ':music:', ':clap:'];
    const grid = qs('#epGrid');
    if (!grid) return;
    grid.innerHTML = '';
    emojis.forEach((emoji) => {
      const d = document.createElement('div');
      d.className = 'ep-emoji';
      d.textContent = emoji;
      d.onclick = () => {
        const input = qs('.chat-inp');
        if (input) input.value += emoji;
        window.closeEmoji();
      };
      grid.appendChild(d);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.chat-acts')) window.closeEmoji();
      if (!e.target.closest('.logo-wrap') && !e.target.closest('.nav-profile')) window.closeAllDD();
    });

    ['goLiveModal', 'endModal', 'loginModal', 'settingsModal', 'faqModal', 'onboardingModal'].forEach((id) => {
      const el = qs(`#${id}`);
      if (!el) return;
      el.addEventListener('click', function (e) {
        if (e.target === this) this.classList.remove('open');
      });
    });
  }

  function initRelay() {
    rebuildRelayPool();
  }

  async function init() {
    loadSettingsFromStorage();
    loadFollowedPubkeys();
    applySettingsToDocument();

    bindLegacyGlobals();
    initEmojiPicker();
    wireEvents();

    const logoBtn = qs('#logoBtn');
    if (logoBtn) logoBtn.addEventListener('click', (e) => { e.stopPropagation(); window.toggleDD('logo'); });
    const pill = qs('#navUserPill');
    if (pill) pill.addEventListener('click', (e) => { e.stopPropagation(); window.toggleDD('profile'); });

    initRelay();
    await tryRestoreLocalLogin();
    setUserUi();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
















































































