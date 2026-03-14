(function () {
  const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://nostr.wine',
    'wss://relay.primal.net'
  ];

  const KIND_PROFILE = 0;
  const KIND_DELETION = 5;
  const KIND_CONTACTS = 3;
  const KIND_REACTION = 7;
  const KIND_LIVE_EVENT = 30311;
  const KIND_LIVE_CHAT = 1311;
  const KIND_ZAP_RECEIPT = 9735;
  const KIND_PEOPLE_LIST = 30000;   // NIP-51 people list
  const KIND_GENERIC_LIST = 30001;  // NIP-51 generic list (bookmark-style)

  const LOCAL_NSEC_STORAGE_KEY = 'nostrflux_local_nsec';
  const NOSTR_TOOLS_SRC = 'https://unpkg.com/nostr-tools/lib/nostr.bundle.js';
  const HLS_JS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
  const SETTINGS_STORAGE_KEY = 'nostrflux_settings_v1';
  const FOLLOWING_STORAGE_KEY = 'nostrflux_following_pubkeys_v1';
  const HIDDEN_ENDED_STREAMS_STORAGE_KEY = 'nostrflux_hidden_ended_streams_v1';
  const NIP05_LOOKUP_CACHE_TTL_MS = 1000 * 60 * 30;

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

  const SAVED_LISTS_STORAGE_KEY = 'nostrflux_saved_lists_v1';

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
    nip51SubId: null,
    contactsSubId: null,
    savedListsSubId: null,
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
    contactListPubkeys: new Set(),          // from kind:3 contact list
    contactsLatestCreatedAt: 0,
    contactsContent: '',
    contactsPTagByPubkey: new Map(),
    contactsOtherTags: [],
    followPublishPending: false,
    nip51Lists: new Map(),                  // listId -> { name, pubkeys, kind, d }
    savedExternalLists: [],                 // [{ naddr, name, pubkeys }] from Liststr/external
    activeListFilter: 'all',               // 'all' | 'following' | 'contacts' | listId | naddr
    listFilterDDOpen: false,
    // Hero featured stream cycling
    heroHlsInstance: null,
    heroPlaybackToken: 0,
    featuredIndex: 0,
    featuredCurrentAddress: '',
    featuredCycleTimer: null,
    featuredCycleStart: 0,
    featuredCycleRafId: null,
    featuredFailed: new Set(),             // addresses that failed playback
    // Infinite scroll
    liveGridPage: 0,
    liveGridObserver: null,
    GRID_PAGE_SIZE: 20,
    scriptPromises: {},
    streamZapTotals: new Map(),
    _theaterRuntimeInterval: null,
    likedStreamAddresses: new Set(),  // tracks which streams the user has liked
    streamLikeEventIdByAddress: new Map(),
    streamLikePublishPending: false,
    boostedStreamAddresses: new Set(),
    streamBoostEventIdByAddress: new Map(),
    streamBoostCheckedByAddress: new Set(),
    streamBoostCheckPendingByAddress: new Set(),
    streamReactionPubkeysByKey: new Map(),
    streamReactionMetaByKey: new Map(),
    streamReactionIdByKeyAndPubkey: new Map(),
    streamReactionEventById: new Map(),
    streamOwnReactionIdByKey: new Map(),
    streamReactionPublishPendingByKey: new Set(),
    chatReactionSubId: null,
    chatLikePubkeysByMessageId: new Map(),
    chatReactionIdByMessageAndPubkey: new Map(),
    chatReactionEventById: new Map(), // reactionEventId -> { messageId, pubkey }
    chatOwnLikeEventByMessageId: new Map(),
    chatMessageEventsById: new Map(),
    chatLikePublishPendingByMessageId: new Set(),
    postReactionPublishPendingByNoteAndKey: new Set(),
    reactionPickerTarget: null,
    shareModalStreamAddress: '',
    activeViewerAddress: '',
    activeHeroViewerAddress: '',
    goLiveSelectedAddress: '',
    goLiveHiddenEndedAddresses: new Set(),
    nip05VerificationByPubkey: new Map(),   // pubkey -> { nip05, verified, checkedAt }
    nip05VerificationPendingByPubkey: new Set(),
    nip05LookupCacheByNip05: new Map(),     // nip05 -> { pubkey, checkedAt }
    pendingRouteAddress: '',
    pendingRouteNaddr: ''
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

  function sanitizeMediaUrl(v) {
    const raw = String(v || '').trim();
    if (!raw) return '';
    const unwrapped = raw.replace(/^['"]+|['"]+$/g, '');
    return unwrapped
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .trim();
  }

  function isLikelyUrl(v) {
    const clean = sanitizeMediaUrl(v);
    return !!clean && /^https?:\/\//i.test(clean);
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

  function setProfileVerificationStyle(mode) {
    const identityBox = qs('#profileIdentityBox');
    const avatar = qs('#profAv');
    const nip05Main = qs('#profNip05');
    const nip05Check = qs('#profNip05Check');
    const resolved = (mode === true || mode === 'verified')
      ? 'verified'
      : (mode === 'invalid' ? 'invalid' : 'none');
    if (identityBox) identityBox.classList.toggle('nip05-verified', resolved === 'verified');
    if (avatar) avatar.classList.toggle('nip05-verified', resolved === 'verified');
    if (nip05Main) nip05Main.classList.toggle('nip05-invalid', resolved === 'invalid');
    if (nip05Check) nip05Check.classList.toggle('nip05-invalid', resolved === 'invalid');
  }

  function setAvatarEl(el, pictureValue, fallbackText) {
    if (!el) return;
    const raw = sanitizeMediaUrl(pictureValue);
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

  function normalizePubkeyHex(pubkey) {
    const normalized = (pubkey || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : '';
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
        .map((v) => normalizePubkeyHex(typeof v === 'string' ? v : ''))
        .filter(Boolean)
    );
  }

  function persistFollowedPubkeys() {
    try {
      localStorage.setItem(FOLLOWING_STORAGE_KEY, JSON.stringify(Array.from(state.followedPubkeys)));
    } catch (_) {
      // no-op
    }
  }

  function readHiddenEndedStreamsStore() {
    try {
      const raw = localStorage.getItem(HIDDEN_ENDED_STREAMS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function loadHiddenEndedStreamsForPubkey(pubkey) {
    const key = normalizePubkeyHex(pubkey);
    if (!key) return new Set();
    const store = readHiddenEndedStreamsStore();
    const list = Array.isArray(store[key]) ? store[key] : [];
    return new Set(
      list
        .map((v) => String(v || '').trim())
        .filter((v) => /^[0-9]+:[0-9a-f]{64}:.+/i.test(v))
    );
  }

  function persistHiddenEndedStreamsForCurrentUser() {
    const own = state.user ? normalizePubkeyHex(state.user.pubkey) : '';
    if (!own) return;
    const store = readHiddenEndedStreamsStore();
    const values = Array.from(state.goLiveHiddenEndedAddresses)
      .map((v) => String(v || '').trim())
      .filter((v) => /^[0-9]+:[0-9a-f]{64}:.+/i.test(v))
      .slice(-300);
    if (values.length) store[own] = values;
    else delete store[own];
    try {
      localStorage.setItem(HIDDEN_ENDED_STREAMS_STORAGE_KEY, JSON.stringify(store));
    } catch (_) {
      // no-op
    }
  }

  function isFollowingPubkey(pubkey) {
    const normalized = normalizePubkeyHex(pubkey);
    return !!(normalized && state.followedPubkeys.has(normalized));
  }

  function setFollowingPubkey(pubkey, on) {
    const normalized = normalizePubkeyHex(pubkey);
    if (!normalized) return;
    if (on) state.followedPubkeys.add(normalized);
    else state.followedPubkeys.delete(normalized);
    persistFollowedPubkeys();
    renderFollowingCount();
  }

  function captureContactsMetadata(ev) {
    if (!ev || ev.kind !== KIND_CONTACTS) return false;
    const created = Number(ev.created_at || 0) || 0;
    if (created < (state.contactsLatestCreatedAt || 0)) return false;

    state.contactsLatestCreatedAt = created;
    state.contactsContent = typeof ev.content === 'string' ? ev.content : '';
    state.contactsPTagByPubkey = new Map();
    state.contactsOtherTags = [];

    (ev.tags || []).forEach((tag) => {
      if (!Array.isArray(tag) || !tag.length) return;
      if (tag[0] === 'p' && tag[1]) {
        const pk = normalizePubkeyHex(tag[1]);
        if (!pk) return;
        const cloned = [...tag];
        cloned[1] = pk;
        state.contactsPTagByPubkey.set(pk, cloned);
      } else {
        state.contactsOtherTags.push([...tag]);
      }
    });

    return true;
  }

  function buildContactsTagsFromFollowedSet() {
    const tags = [];
    (state.contactsOtherTags || []).forEach((t) => {
      if (!Array.isArray(t) || !t.length || t[0] === 'p') return;
      tags.push([...t]);
    });

    const followed = Array.from(state.followedPubkeys)
      .map((pk) => normalizePubkeyHex(pk))
      .filter(Boolean)
      .sort();

    followed.forEach((pk) => {
      const existing = state.contactsPTagByPubkey && state.contactsPTagByPubkey.get(pk);
      if (Array.isArray(existing) && existing.length >= 2 && existing[0] === 'p') {
        const cloned = [...existing];
        cloned[1] = pk;
        tags.push(cloned);
      } else {
        tags.push(['p', pk]);
      }
    });

    return tags;
  }

  async function publishFollowedPubkeysToNostr() {
    if (!state.user) throw new Error('Please login first to publish your follow list.');
    const tags = buildContactsTagsFromFollowedSet();
    const content = typeof state.contactsContent === 'string' ? state.contactsContent : '';
    const ev = await signAndPublish(KIND_CONTACTS, content, tags);
    captureContactsMetadata(ev);
    return ev;
  }

  function applySettingsToDocument() {
    document.body.classList.toggle('hide-nip05', !state.settings.showNip05Badges);
    document.body.classList.toggle('hide-zap-notices', !state.settings.showZapNotifications);
    document.body.classList.toggle('compact-chat', !!state.settings.compactChat);
    document.body.classList.toggle('no-chat-anim', !state.settings.animateZaps);
  }

  function renderSettingsRelayList() {
    const wrap = qs('#settingsRelayList2') || qs('#settingsRelayList');
    if (!wrap) return;
    wrap.innerHTML = '';

    state.settings.relays.forEach((relay) => {
      const tag = document.createElement('div');
      tag.className = 'relay-tag';
      tag.innerHTML = `${relay} <button class="rem" title="Remove">×</button>`;
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
    const displayName = qs('#settingsDisplayName');
    const username = qs('#settingsUsername');
    const about = qs('#settingsAbout');
    const avatarUrl = qs('#settingsAvatarUrl');
    const nip05 = qs('#settingsNip05Input');

    const up = state.user ? profileFor(state.user.pubkey) : null;
    if (lud16) lud16.value = (up && up.lud16) || state.settings.lud16 || '';
    if (web) web.value = (up && up.website) || state.settings.website || '';
    if (banner) banner.value = (up && up.banner) || state.settings.banner || '';
    if (displayName) displayName.value = (up && (up.display_name || up.name)) || '';
    if (username) username.value = (up && up.name) || '';
    if (about) about.value = (up && up.about) || '';
    if (avatarUrl) avatarUrl.value = (up && up.picture) || '';
    if (nip05) nip05.value = (up && up.nip05) || '';

    if (up && up.picture) previewSettingsAvatar(up.picture);

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
    // NIP-53 address always uses the event publisher's pubkey
    const address = `${KIND_LIVE_EVENT}:${ev.pubkey}:${d}`;
    const starts = Number(firstTag(tagMap, 'starts') || 0) || null;
    const title = firstTag(tagMap, 'title') || (ev.content || '').slice(0, 90) || 'Untitled stream';
    const summary = firstTag(tagMap, 'summary') || ev.content || '';
    const image = sanitizeMediaUrl(firstTag(tagMap, 'image') || firstTag(tagMap, 'thumb') || '');
    const streaming = sanitizeMediaUrl(firstTag(tagMap, 'streaming') || firstTag(tagMap, 'url') || '');
    const participants = Number(firstTag(tagMap, 'current_participants') || 0) || 0;

    // NIP-53: platforms (zap.stream, shosho, etc.) publish under their own key
    // but embed the real streamer as ["p", "<pubkey>", "<relay>", "host"].
    let hostPubkey = ev.pubkey;
    const platformPubkey_ref = { val: null };
    for (const t of (ev.tags || [])) {
      if (t[0] === 'p' && t[1] && /^[0-9a-f]{64}$/i.test(t[1])) {
        const role = (t[3] || t[2] || '').toLowerCase().trim();
        if (role === 'host' || role === 'streamer') {
          hostPubkey = t[1];
          platformPubkey_ref.val = ev.pubkey;
          break;
        }
      }
    }
    const platformPubkey = platformPubkey_ref.val;

    return {
      id: ev.id,
      pubkey: ev.pubkey,     // event publisher (used for NIP-53 address & ownership)
      hostPubkey,            // actual streamer for display (equals pubkey when self-published)
      platformPubkey,        // non-null when a platform published on behalf of the streamer
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

  function isHomePath(pathname) {
    const raw = (pathname || '/').trim();
    const normalized = raw === '' ? '/' : (raw.replace(/\/+$/, '') || '/');
    return normalized === '/' || normalized.toLowerCase() === '/index.html';
  }

  function decodePathPart(part) {
    try {
      return decodeURIComponent(part || '');
    } catch (_) {
      return part || '';
    }
  }

  function pathParts(pathname) {
    return (pathname || '').split('/').filter(Boolean).map((p) => decodePathPart(p).trim());
  }

  function extractNaddrFromPath(pathname) {
    const parts = pathParts(pathname);
    if (!parts.length) return '';
    const candidate = parts[0].toLowerCase() === 'a' && parts[1] ? parts[1] : parts[0];
    const naddr = (candidate || '').trim().toLowerCase();
    return /^naddr1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(naddr) ? naddr : '';
  }

  function normalizeNip05Value(value) {
    const raw = (value || '').trim().toLowerCase();
    if (!raw || raw.includes('/')) return '';
    const parts = raw.split('@');
    if (parts.length !== 2) return '';
    const localPart = (parts[0] || '').trim();
    const domain = (parts[1] || '').trim();
    if (!localPart || !domain || !domain.includes('.')) return '';
    if (!/^[a-z0-9._-]+$/i.test(localPart)) return '';
    if (!/^[a-z0-9.-]+$/i.test(domain)) return '';
    return `${localPart}@${domain}`;
  }

  function nip05EntryForPubkey(pubkey, nip05Value) {
    const key = normalizePubkeyHex(pubkey);
    const nip05 = normalizeNip05Value(nip05Value);
    if (!key || !nip05) return null;
    const row = state.nip05VerificationByPubkey.get(key);
    if (!row || row.nip05 !== nip05) return null;
    return row;
  }

  function getVerifiedNip05ForPubkey(pubkey, nip05Value) {
    const nip05 = normalizeNip05Value(nip05Value);
    const row = nip05EntryForPubkey(pubkey, nip05);
    return row && row.verified ? nip05 : '';
  }

  function refreshNip05DependentUi(pubkey) {
    const normalized = normalizePubkeyHex(pubkey);
    if (!normalized) return;
    renderLiveGrid();

    const selected = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
    if (selected) {
      const isRelated = [selected.pubkey, selected.hostPubkey, selected.platformPubkey]
        .map((v) => normalizePubkeyHex(v))
        .includes(normalized);
      if (isRelated) renderVideo(selected);
    }

    if (state.user && normalizePubkeyHex(state.user.pubkey) === normalized) {
      setUserUi();
    }

    if (normalizePubkeyHex(state.selectedProfilePubkey) === normalized) {
      renderProfilePage(normalized);
      syncProfileRoute(normalized, 'replace');
    }

    const chatEl = qs('#chatScroll');
    if (chatEl) {
      const verified = !!getVerifiedNip05ForPubkey(normalized, profileFor(normalized).nip05 || '');
      const escaped = (window.CSS && typeof window.CSS.escape === 'function')
        ? window.CSS.escape(normalized)
        : normalized.replace(/["\\]/g, '');
      chatEl.querySelectorAll(`.cmsg[data-pubkey="${escaped}"] .c-av`).forEach((el) => {
        el.classList.toggle('nip05-square', verified);
      });
    }
  }

  async function fetchNip05PubkeyFromWellKnown(nip05Input, opts = {}) {
    const normalized = normalizeNip05Value(nip05Input);
    if (!normalized) return '';
    const now = Date.now();
    const cached = state.nip05LookupCacheByNip05.get(normalized);
    const maxAge = Number(opts.maxAgeMs || NIP05_LOOKUP_CACHE_TTL_MS);
    if (!opts.force && cached && (now - Number(cached.checkedAt || 0)) < maxAge) {
      return normalizePubkeyHex(cached.pubkey || '');
    }

    const [localPart, domain] = normalized.split('@');
    let resolved = '';
    try {
      const resp = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(localPart)}`, { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        const names = data && data.names && typeof data.names === 'object' ? data.names : {};
        resolved = normalizePubkeyHex(names[localPart] || names[localPart.toLowerCase()] || '');
      }
    } catch (_) {
      resolved = '';
    }

    state.nip05LookupCacheByNip05.set(normalized, { pubkey: resolved, checkedAt: now });
    return resolved;
  }

  async function ensureNip05Verification(pubkey, nip05Input, opts = {}) {
    const key = normalizePubkeyHex(pubkey);
    const nip05 = normalizeNip05Value(nip05Input);
    if (!key) return false;
    if (!nip05) {
      const prev = state.nip05VerificationByPubkey.get(key);
      state.nip05VerificationByPubkey.delete(key);
      if (prev) refreshNip05DependentUi(key);
      return false;
    }

    const existing = nip05EntryForPubkey(key, nip05);
    const maxAge = Number(opts.maxAgeMs || NIP05_LOOKUP_CACHE_TTL_MS);
    const existingFresh = existing && (Date.now() - Number(existing.checkedAt || 0)) < maxAge;
    if (!opts.force && existingFresh) return !!existing.verified;
    if (state.nip05VerificationPendingByPubkey.has(key)) return !!(existing && existing.verified);

    state.nip05VerificationPendingByPubkey.add(key);
    try {
      const resolved = await fetchNip05PubkeyFromWellKnown(nip05, opts);
      const verified = !!resolved && resolved === key;
      const prev = state.nip05VerificationByPubkey.get(key);
      const changed = !prev || prev.nip05 !== nip05 || !!prev.verified !== verified;
      state.nip05VerificationByPubkey.set(key, { nip05, verified, checkedAt: Date.now() });
      if (changed) refreshNip05DependentUi(key);
      return verified;
    } finally {
      state.nip05VerificationPendingByPubkey.delete(key);
    }
  }

  function extractProfileTokenFromPath(pathname) {
    const parts = pathParts(pathname);
    if (!parts.length) return '';
    if (parts[0].toLowerCase() === 'a') return '';
    const token = parts[0];
    const lower = token.toLowerCase();
    if (/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(lower)) return lower;
    const nip05 = normalizeNip05Value(token);
    if (nip05) return nip05;
    return '';
  }

  function encodeStreamNaddr(stream) {
    if (!stream || !window.NostrTools || !window.NostrTools.nip19 || typeof window.NostrTools.nip19.naddrEncode !== 'function') {
      return '';
    }
    try {
      return window.NostrTools.nip19.naddrEncode({
        kind: Number(stream.kind || KIND_LIVE_EVENT),
        pubkey: stream.pubkey,
        identifier: stream.d,
        relays: state.relays.slice(0, 3)
      });
    } catch (_) {
      return '';
    }
  }

  async function decodeNaddrToAddress(naddr) {
    const value = (naddr || '').trim().toLowerCase();
    if (!value) return '';
    try {
      const tools = await ensureNostrTools();
      if (!tools || !tools.nip19 || typeof tools.nip19.decode !== 'function') return '';
      const decoded = tools.nip19.decode(value);
      if (!decoded || decoded.type !== 'naddr' || !decoded.data) return '';
      const kind = Number(decoded.data.kind || KIND_LIVE_EVENT);
      const pubkey = (decoded.data.pubkey || '').toLowerCase();
      const identifier = (decoded.data.identifier || '').trim();
      if (!pubkey || !identifier) return '';
      return `${kind}:${pubkey}:${identifier}`;
    } catch (_) {
      return '';
    }
  }

  async function decodeNpubToPubkey(npub) {
    const value = (npub || '').trim().toLowerCase();
    if (!/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(value)) return '';
    try {
      const tools = await ensureNostrTools();
      if (!tools || !tools.nip19 || typeof tools.nip19.decode !== 'function') return '';
      const decoded = tools.nip19.decode(value);
      if (!decoded || decoded.type !== 'npub') return '';
      return /^[0-9a-f]{64}$/i.test(decoded.data || '') ? decoded.data.toLowerCase() : '';
    } catch (_) {
      return '';
    }
  }

  async function resolveNip05ToPubkey(nip05) {
    const normalized = normalizeNip05Value(nip05);
    if (!normalized) return '';
    const resolved = await fetchNip05PubkeyFromWellKnown(normalized);
    if (!resolved) return '';

    const existing = profileFor(resolved);
    const existingNip05 = normalizeNip05Value(existing.nip05 || '');
    if (existingNip05 === normalized) {
      state.nip05VerificationByPubkey.set(resolved, { nip05: normalized, verified: true, checkedAt: Date.now() });
    }
    return resolved;
  }

  async function resolveProfileTokenToPubkey(token) {
    const value = (token || '').trim();
    if (!value) return '';
    const lower = value.toLowerCase();
    if (/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(lower)) {
      return decodeNpubToPubkey(lower);
    }
    const nip05 = normalizeNip05Value(value);
    if (nip05) return resolveNip05ToPubkey(nip05);
    return '';
  }

  function syncHomeRoute(mode = 'push') {
    if (!window.history || !window.history.pushState) return;
    if (isHomePath(window.location.pathname)) return;
    const method = mode === 'replace' ? 'replaceState' : 'pushState';
    try {
      window.history[method]({ view: 'home' }, '', '/');
    } catch (_) {
      // ignore
    }
  }

  function syncTheaterRoute(stream, mode = 'push') {
    if (!stream || !window.history || !window.history.pushState) return;

    const applyRoute = (naddr) => {
      const val = (naddr || '').trim().toLowerCase();
      if (!val) return false;
      const targetPath = `/${val}`;
      if (window.location.pathname === targetPath) return true;
      const method = mode === 'replace' ? 'replaceState' : 'pushState';
      try {
        window.history[method]({ view: 'theater', address: stream.address, naddr: val }, '', targetPath);
        return true;
      } catch (_) {
        return false;
      }
    };

    if (applyRoute(encodeStreamNaddr(stream))) return;
    ensureNostrTools().then(() => {
      applyRoute(encodeStreamNaddr(stream));
    }).catch(() => {});
  }

  function syncProfileRoute(pubkey, mode = 'push') {
    if (!pubkey || !window.history || !window.history.pushState) return;

    const applyRoute = (path) => {
      const targetPath = (path || '').trim();
      if (!targetPath) return false;
      if (window.location.pathname === targetPath) return true;
      const method = mode === 'replace' ? 'replaceState' : 'pushState';
      try {
        window.history[method]({ view: 'profile', pubkey }, '', targetPath);
        return true;
      } catch (_) {
        return false;
      }
    };

    const profile = profileFor(pubkey);
    const nip05 = getVerifiedNip05ForPubkey(pubkey, profile.nip05 || '');
    if (nip05 && applyRoute(`/${nip05}`)) return;
    if (!nip05) ensureNip05Verification(pubkey, profile.nip05 || '').catch(() => {});

    const applyNpub = () => {
      if (!window.NostrTools || !window.NostrTools.nip19 || typeof window.NostrTools.nip19.npubEncode !== 'function') {
        return false;
      }
      try {
        const npub = window.NostrTools.nip19.npubEncode(pubkey);
        return applyRoute(`/${(npub || '').toLowerCase()}`);
      } catch (_) {
        return false;
      }
    };

    if (applyNpub()) return;
    ensureNostrTools().then(() => {
      const latest = profileFor(pubkey);
      const latestNip05 = getVerifiedNip05ForPubkey(pubkey, latest.nip05 || '');
      if (latestNip05) {
        applyRoute(`/${latestNip05}`);
        return;
      }
      applyNpub();
    }).catch(() => {});
  }

  function tryOpenPendingRouteStream() {
    if (!state.pendingRouteAddress) return false;
    const stream = state.streamsByAddress.get(state.pendingRouteAddress);
    if (!stream) return false;
    const address = state.pendingRouteAddress;
    state.pendingRouteAddress = '';
    state.pendingRouteNaddr = '';
    openStream(address, { routeMode: 'skip' });
    return true;
  }

  function showHomeFromRoute() {
    if (window.showPage) window.showPage('home', { routeMode: 'skip' });
  }

  async function syncViewFromLocation(opts = {}) {
    const fallbackMode = opts.fallbackMode || 'replace';
    const naddr = extractNaddrFromPath(window.location.pathname);
    if (naddr) {
      state.pendingRouteNaddr = naddr;
      if (window.showVideoPage) window.showVideoPage({ routeMode: 'skip' });
      const address = await decodeNaddrToAddress(naddr);
      if (!address) {
        state.pendingRouteAddress = '';
        state.pendingRouteNaddr = '';
        if (fallbackMode !== 'skip' && !isHomePath(window.location.pathname)) syncHomeRoute(fallbackMode);
        showHomeFromRoute();
        return;
      }
      state.pendingRouteAddress = address;
      tryOpenPendingRouteStream();
      return;
    }

    state.pendingRouteAddress = '';
    state.pendingRouteNaddr = '';

    const profileToken = extractProfileTokenFromPath(window.location.pathname);
    if (profileToken) {
      const pubkey = await resolveProfileTokenToPubkey(profileToken);
      if (!pubkey) {
        if (fallbackMode !== 'skip' && !isHomePath(window.location.pathname)) syncHomeRoute(fallbackMode);
        showHomeFromRoute();
        return;
      }
      showProfileByPubkey(pubkey, { routeMode: 'skip' });
      return;
    }

    if (!isHomePath(window.location.pathname) && fallbackMode !== 'skip') syncHomeRoute(fallbackMode);
    showHomeFromRoute();
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
      display_name: obj.display_name || '',
      username: obj.name || '',
      about: obj.about || '',
      picture: obj.picture || '',
      banner: obj.banner || '',
      website: obj.website || '',
      nip05: normalizeNip05Value(obj.nip05 || ''),
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
    if (state.selectedStreamAddress === stream.address) {
      const selected = state.streamsByAddress.get(stream.address) || stream;
      const status = normalizeStreamStatus(selected.status);
      const ownPubkey = state.user ? normalizePubkeyHex(state.user.pubkey) : '';
      const streamPubkey = normalizePubkeyHex(selected.pubkey);
      const isOwnStream = !!ownPubkey && ownPubkey === streamPubkey;
      const videoPage = qs('#videoPage');
      const isWatchingSelected = state.activeViewerAddress === selected.address
        || !!(videoPage && videoPage.style.display !== 'none');

      if (status === 'ended' && !isOwnStream && isWatchingSelected) {
        setActiveViewerAddress('');
        if (window.showPage) window.showPage('home');
      } else if (isWatchingSelected || isOwnStream) {
        renderVideo(selected);
      }
    }
    updateGoLiveButtonState();
  }

  function normalizeStreamStatus(status) {
    const raw = String(status || '').toLowerCase();
    if (raw.includes('ended')) return 'ended';
    if (raw.includes('planned')) return 'planned';
    return 'live';
  }

  function ownManageableStreams() {
    if (!state.user) return [];
    const own = normalizePubkeyHex(state.user.pubkey);
    if (!own) return [];
    return Array.from(state.streamsByAddress.values())
      .filter((s) => normalizePubkeyHex(s.pubkey) === own)
      .filter((s) => !state.goLiveHiddenEndedAddresses.has(s.address))
      .sort((a, b) => {
        const rank = (stream) => {
          const st = normalizeStreamStatus(stream.status);
          if (st === 'live') return 0;
          if (st === 'planned') return 1;
          return 2;
        };
        const r = rank(a) - rank(b);
        if (r) return r;
        return (b.created_at || 0) - (a.created_at || 0);
      });
  }

  function setGoLiveStatusSelection(statusValue) {
    const normalized = normalizeStreamStatus(statusValue);
    const row = qs('.srow');
    if (!row) return;
    const buttons = qsa('.sc', row);
    buttons.forEach((btn) => btn.classList.remove('sl'));
    const target = buttons.find((btn) => normalizeStreamStatus(btn.textContent) === normalized) || buttons[0];
    if (target) target.classList.add('sl');
  }

  function populateGoLiveFormFromStream(stream) {
    const dTagInput = qs('#goLiveDTag');
    const titleInput = qs('#goLiveTitle');
    const summaryInput = qs('#goLiveSummary');
    const streamUrlInput = qs('#goLiveStreamUrl');
    const thumbInput = qs('#goLiveThumb');
    const startsInput = qs('#goLiveStarts');
    const eventIdInput = qs('#goLiveEventId');

    if (dTagInput) dTagInput.value = stream ? (stream.d || '') : '';
    if (titleInput) titleInput.value = stream ? (stream.title || '') : '';
    if (summaryInput) summaryInput.value = stream ? (stream.summary || '') : '';
    if (streamUrlInput) streamUrlInput.value = stream ? (stream.streaming || '') : '';
    if (thumbInput) thumbInput.value = stream ? (stream.image || '') : '';
    if (startsInput) startsInput.value = stream && stream.starts ? fromUnixSeconds(stream.starts) : '';
    if (eventIdInput) eventIdInput.value = stream && stream.id ? stream.id : '';
    setGoLiveStatusSelection(stream ? stream.status : 'live');
  }

  function resetGoLiveFormDefaults() {
    populateGoLiveFormFromStream(null);
    const dtag = qs('#goLiveDTag');
    if (dtag && !dtag.value.trim()) dtag.value = `stream-${Date.now()}`;
    const starts = qs('#goLiveStarts');
    if (starts && !starts.value) starts.value = fromUnixSeconds(Math.floor(Date.now() / 1000));
    const title = qs('#goLiveTitle');
    if (title && !title.value.trim()) title.value = 'Untitled stream';
  }

  function updateGoLiveModalState() {
    const manageWrap = qs('#goLiveManageWrap');
    const manageHint = qs('#goLiveManageHint');
    const selector = qs('#goLiveStreamSelect');
    const publishBtn = qs('#goLivePublishBtn');
    const removeBtn = qs('#goLiveRemoveBtn');
    const modalTitle = qs('#goLiveModalTitle');
    const modalSub = qs('#goLiveModalSub');

    const streams = ownManageableStreams();
    let selected = streams.find((s) => s.address === state.goLiveSelectedAddress) || null;
    if (!selected && streams.length) selected = streams[0];
    state.goLiveSelectedAddress = selected ? selected.address : '';

    if (manageWrap) manageWrap.classList.toggle('on', streams.length > 0);
    if (selector) {
      selector.innerHTML = '';
      streams.forEach((stream) => {
        const opt = document.createElement('option');
        const statusLabel = normalizeStreamStatus(stream.status).toUpperCase();
        const title = (stream.title || 'Untitled stream').slice(0, 64);
        opt.value = stream.address;
        opt.textContent = `${statusLabel} - ${title}`;
        selector.appendChild(opt);
      });
      if (state.goLiveSelectedAddress) selector.value = state.goLiveSelectedAddress;
    }

    if (selected) {
      populateGoLiveFormFromStream(selected);
      const status = normalizeStreamStatus(selected.status);
      if (modalTitle) modalTitle.innerHTML = '<span class="mi"></span>Edit Stream';
      if (modalSub) modalSub.textContent = 'You already have stream events. Edit details and publish updates.';
      if (publishBtn) publishBtn.textContent = status === 'live' ? 'Save Live Update' : 'Save Stream Update';
      if (removeBtn) removeBtn.style.display = status === 'ended' ? 'inline-flex' : 'none';
      if (manageHint) manageHint.textContent = streams.length > 1
        ? 'Pick a stream from the list to edit or end it.'
        : 'You can edit title, stream id, URL, summary, and status.';
    } else {
      resetGoLiveFormDefaults();
      if (modalTitle) modalTitle.innerHTML = '<span class="mi"></span>Publish Your Stream';
      if (modalSub) modalSub.innerHTML = 'Broadcasts a <span style="color:var(--purple);font-family:\'DM Mono\',monospace">kind:30311</span> NIP-53 event to your relays.';
      if (publishBtn) publishBtn.textContent = 'Go Live Now';
      if (removeBtn) removeBtn.style.display = 'none';
      if (manageHint) manageHint.textContent = 'Create your first stream event, then it will appear here for editing.';
    }
  }

  function updateGoLiveButtonState() {
    const btn = qs('#goLiveBtn');
    if (!btn) return;
    const streams = ownManageableStreams();
    const hasLive = streams.some((s) => normalizeStreamStatus(s.status) === 'live');
    if (hasLive) {
      btn.textContent = 'Edit Stream';
      btn.classList.remove('btn-ghost');
      btn.classList.add('btn-live-pulse', 'btn-edit-stream-live');
      return;
    }
    btn.textContent = 'Go Live';
    btn.classList.remove('btn-live-pulse', 'btn-edit-stream-live');
    btn.classList.add('btn-ghost');
  }

  function effectiveParticipants(stream) {
    if (!stream) return 0;
    const base = Number(stream.participants || 0) || 0;
    const watchingBoost = (
      (state.activeViewerAddress && stream.address === state.activeViewerAddress)
      || (state.activeHeroViewerAddress && stream.address === state.activeHeroViewerAddress)
    ) ? 1 : 0;
    return Math.max(0, base + watchingBoost);
  }

  function refreshParticipantDependentUi() {
    renderLiveGrid();

    const featured = heroFeaturedStreams();
    if (featured.length) {
      let idx = Math.min(Math.max(0, state.featuredIndex), featured.length - 1);
      if (state.featuredCurrentAddress) {
        const currentIdx = featured.findIndex((s) => s.address === state.featuredCurrentAddress);
        if (currentIdx >= 0) idx = currentIdx;
      }
      state.featuredIndex = idx;
      renderHeroIndicators(featured, idx);
      const heroViewers = qs('#heroViewers');
      if (heroViewers) {
        const viewerCount = effectiveParticipants(featured[idx]);
        heroViewers.textContent = viewerCount > 0 ? viewerCount.toLocaleString() : '-';
      }
    }

    const selected = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
    if (selected) {
      const viewers = qs('#theaterViewers');
      if (viewers) viewers.textContent = formatCount(effectiveParticipants(selected));
    }

    if (window.renderRecoStreams) window.renderRecoStreams();
  }

  function setActiveViewerAddress(address) {
    const next = (address || '').trim();
    if (state.activeViewerAddress === next) return;
    state.activeViewerAddress = next;
    refreshParticipantDependentUi();
  }

  function setActiveHeroViewerAddress(address) {
    const next = (address || '').trim();
    if (state.activeHeroViewerAddress === next) return;
    state.activeHeroViewerAddress = next;
    refreshParticipantDependentUi();
  }

  function sortedLiveStreams() {
    return Array.from(state.streamsByAddress.values())
      .filter((s) => s.status !== 'ended')
      .sort((a, b) => {
        // Tier 1: has viewers > 0  â†’  Tier 2: has streaming URL but 0 viewers  â†’  Tier 3: no URL no viewers
        const tierA = effectiveParticipants(a) > 0 ? 0 : (a.streaming ? 1 : 2);
        const tierB = effectiveParticipants(b) > 0 ? 0 : (b.streaming ? 1 : 2);
        if (tierA !== tierB) return tierA - tierB;
        // Within same tier: higher viewers first
        return effectiveParticipants(b) - effectiveParticipants(a);
      });
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

  /* =====================================================================
     NIP-51 PEOPLE LISTS + FOLLOWING LIVE SECTION
     ===================================================================== */

  function loadSavedExternalLists() {
    try {
      const raw = localStorage.getItem(SAVED_LISTS_STORAGE_KEY);
      state.savedExternalLists = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.savedExternalLists)) state.savedExternalLists = [];
    } catch (_) {
      state.savedExternalLists = [];
    }
  }

  function persistSavedExternalLists() {
    try {
      localStorage.setItem(SAVED_LISTS_STORAGE_KEY, JSON.stringify(state.savedExternalLists));
    } catch (_) {}
  }

  function parseNip51PeopleList(ev) {
    const tagMap = parseTags(ev.tags || []);
    const d = firstTag(tagMap, 'd') || '';
    const name = firstTag(tagMap, 'name') || firstTag(tagMap, 'title') || d || 'Unnamed list';
    const pubkeys = (ev.tags || [])
      .filter((t) => t[0] === 'p' && t[1] && /^[0-9a-f]{64}$/i.test(t[1]))
      .map((t) => t[1]);
    return { id: `${ev.kind}:${ev.pubkey}:${d}`, name, pubkeys, kind: ev.kind, d, pubkey: ev.pubkey };
  }

  // Subscribe to user's kind:3 (contacts) and kind:30000 (people lists)
  function subscribeUserLists(pubkey) {
    const normalizedUser = normalizePubkeyHex(pubkey);
    if (!normalizedUser) return;

    // Unsubscribe old
    if (state.nip51SubId) { state.pool.unsubscribe(state.nip51SubId); state.nip51SubId = null; }
    if (state.contactsSubId) { state.pool.unsubscribe(state.contactsSubId); state.contactsSubId = null; }
    let latestContactsCreated = 0;

    // Kind 3: contact list
    state.contactsSubId = state.pool.subscribe(
      [{ kinds: [KIND_CONTACTS], authors: [normalizedUser], limit: 10 }],
      {
        event: (ev) => {
          if (ev.kind !== KIND_CONTACTS) return;
          const created = Number(ev.created_at || 0) || 0;
          if (created < latestContactsCreated) return;
          latestContactsCreated = created;

          if (!captureContactsMetadata(ev)) return;

          const pubs = (ev.tags || [])
            .map((t) => (Array.isArray(t) && t[0] === 'p' ? normalizePubkeyHex(t[1]) : ''))
            .filter(Boolean);
          state.contactListPubkeys = new Set(pubs);

          // Keep app follow state in sync with relay-backed contact list for the logged-in user.
          if (state.user && normalizePubkeyHex(state.user.pubkey) === normalizedUser) {
            state.followedPubkeys = new Set(pubs);
            persistFollowedPubkeys();
            renderFollowingCount();

            const ownStats = state.profileStatsByPubkey.get(normalizedUser) || { followers: 0, following: 0 };
            state.profileStatsByPubkey.set(normalizedUser, {
              followers: Number(ownStats.followers || 0),
              following: pubs.length
            });
            if (normalizePubkeyHex(state.selectedProfilePubkey) === normalizedUser) {
              const followingEl = qs('#profFollowing');
              if (followingEl) followingEl.textContent = formatCount(pubs.length);
            }

            const selectedStream = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
            if (selectedStream && selectedStream.hostPubkey) updateTheaterFollowBtn(selectedStream.hostPubkey);
            if (state.selectedProfilePubkey) renderProfileFollowButton(state.selectedProfilePubkey);
          }

          renderLiveGrid();
        }
      }
    );

    // Kind 30000: NIP-51 people lists
    state.nip51SubId = state.pool.subscribe(
      [{ kinds: [KIND_PEOPLE_LIST], authors: [normalizedUser], limit: 50 }],
      {
        event: (ev) => {
          if (ev.kind !== KIND_PEOPLE_LIST) return;
          const list = parseNip51PeopleList(ev);
          if (!list.pubkeys.length) return;
          state.nip51Lists.set(list.id, list);
          renderListFilterDD();
          renderLiveGrid();
        }
      }
    );
  }

  // Subscribe to an external NIP-51 list by naddr (kind:30000:pubkey:d)
  function subscribeExternalList(naddrOrUrl, onDone) {
    let naddr = naddrOrUrl.trim();

    // Handle Liststr URLs: https://listr.lol/a/naddr1...
    const listrMatch = naddr.match(/\/a\/(naddr1[a-z0-9]+)/i);
    if (listrMatch) naddr = listrMatch[1];

    // Strip trailing slashes or query params
    naddr = naddr.split(/[?#]/)[0].trim();

    if (!naddr.startsWith('naddr1')) {
      if (onDone) onDone(null, new Error('Not a valid naddr. Paste an naddr1â€¦ or a listr.lol URL.'));
      return;
    }

    // Decode via NostrTools
    ensureNostrTools().then((tools) => {
      let decoded;
      try {
        decoded = tools.nip19.decode(naddr);
      } catch (e) {
        if (onDone) onDone(null, new Error('Could not decode naddr: ' + e.message));
        return;
      }

      if (!decoded || decoded.type !== 'naddr') {
        if (onDone) onDone(null, new Error('Expected naddr type, got: ' + (decoded && decoded.type)));
        return;
      }

      const { kind, pubkey, identifier, relays: hintRelays } = decoded.data;

      const subId = state.pool.subscribe(
        [{ kinds: [kind], authors: [pubkey], '#d': [identifier], limit: 1 }],
        {
          event: (ev) => {
            if (ev.kind !== kind || ev.pubkey !== pubkey) return;
            const list = parseNip51PeopleList(ev);
            state.pool.unsubscribe(subId);

            // Check if already saved
            const existingIdx = state.savedExternalLists.findIndex((l) => l.naddr === naddr);
            const entry = { naddr, name: list.name, pubkeys: list.pubkeys };
            if (existingIdx >= 0) {
              state.savedExternalLists[existingIdx] = entry;
            } else {
              state.savedExternalLists.push(entry);
            }
            persistSavedExternalLists();
            renderListFilterDD();
            if (onDone) onDone(entry, null);
          },
          eose: () => {
            // If no event came back, report to caller
            if (onDone) onDone(null, new Error('List not found on connected relays.'));
          }
        }
      );
    }).catch((e) => {
      if (onDone) onDone(null, e);
    });
  }

  // Get the pubkeys relevant to the current filter
  function getPubkeysForFilter() {
    const f = state.activeListFilter;
    if (f === 'all') return null;                        // null = show everything
    if (f === 'following') return state.followedPubkeys; // app-level follow set
    if (f === 'contacts') return state.contactListPubkeys;

    // NIP-51 list by id
    const nip51 = state.nip51Lists.get(f);
    if (nip51) return new Set(nip51.pubkeys);

    // Saved external list by naddr
    const saved = state.savedExternalLists.find((l) => l.naddr === f);
    if (saved) return new Set(saved.pubkeys);

    return null;
  }

  /* ---- Dropdown rendering ---- */
  function renderListFilterDD() {
    // NIP-51 owned lists
    const nip51Section = qs('#lf-nip51-section');
    const nip51Items = qs('#lf-nip51-items');
    if (nip51Items) {
      nip51Items.innerHTML = '';
      if (state.nip51Lists.size > 0) {
        if (nip51Section) nip51Section.style.display = '';
        state.nip51Lists.forEach((list) => {
          const btn = document.createElement('button');
          btn.className = 'lf-item' + (state.activeListFilter === list.id ? ' active' : '');
          btn.innerHTML = `<span class="lf-dot"></span><span class="lf-item-name"></span><span class="lf-item-count">${list.pubkeys.length}</span>`;
          qs('.lf-item-name', btn).textContent = list.name;
          btn.addEventListener('click', () => setListFilter(list.id, btn));
          nip51Items.appendChild(btn);
        });
      } else {
        if (nip51Section) nip51Section.style.display = 'none';
      }
    }

    // Saved external lists
    const savedSection = qs('#lf-saved-section');
    const savedItems = qs('#lf-saved-items');
    if (savedItems) {
      savedItems.innerHTML = '';
      if (state.savedExternalLists.length > 0) {
        if (savedSection) savedSection.style.display = '';
        state.savedExternalLists.forEach((entry) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;';

          const btn = document.createElement('button');
          btn.className = 'lf-item' + (state.activeListFilter === entry.naddr ? ' active' : '');
          btn.style.flex = '1';
          btn.innerHTML = `<span class="lf-dot"></span><span class="lf-item-name"></span><span class="lf-item-count">${entry.pubkeys.length}</span>`;
          qs('.lf-item-name', btn).textContent = entry.name;
          btn.addEventListener('click', () => setListFilter(entry.naddr, btn));

          // Remove button
          const rem = document.createElement('button');
          rem.title = 'Remove list';
          rem.innerHTML = '&times;';
          rem.style.cssText = 'background:none;border:none;color:var(--muted);cursor:pointer;font-size:.9rem;padding:.2rem .4rem;line-height:1;flex-shrink:0;';
          rem.addEventListener('click', (e) => {
            e.stopPropagation();
            state.savedExternalLists = state.savedExternalLists.filter((l) => l.naddr !== entry.naddr);
            persistSavedExternalLists();
            if (state.activeListFilter === entry.naddr) setListFilter('all', qs('#lf-all'));
            else renderListFilterDD();
          });
          rem.addEventListener('mouseover', () => { rem.style.color = 'var(--live)'; });
          rem.addEventListener('mouseout', () => { rem.style.color = 'var(--muted)'; });

          row.appendChild(btn);
          row.appendChild(rem);
          savedItems.appendChild(row);
        });
      } else {
        if (savedSection) savedSection.style.display = 'none';
      }
    }
  }

  function setActiveListFilterBtn(activeId) {
    // Deactivate all items
    qsa('.lf-item').forEach((b) => b.classList.remove('active'));
    const target = qs(`#lf-${activeId}`) || qs(`.lf-item.active`);
    if (target) target.classList.add('active');
  }

  function getFilterLabelText() {
    const f = state.activeListFilter;
    if (f === 'all') return 'All Live';
    if (f === 'following') return 'My Following';
    if (f === 'contacts') return 'Contacts';
    const n51 = state.nip51Lists.get(f);
    if (n51) return n51.name;
    const sv = state.savedExternalLists.find((l) => l.naddr === f);
    if (sv) return sv.name;
    return 'Custom List';
  }

  function renderFollowingCount() {
    const cnt = qs('#lfFollowingCount');
    if (cnt) cnt.textContent = state.followedPubkeys.size || '';
  }


  /* ---- Global controls wired to HTML ---- */
  function toggleListFilterDDInternal(e) {
    if (e) e.stopPropagation();
    const dd = qs('#listFilterDD');
    const btn = qs('#listFilterBtn');
    if (!dd || !btn) return;
    const isOpen = dd.classList.toggle('open');
    btn.classList.toggle('open', isOpen);
    state.listFilterDDOpen = isOpen;
    if (isOpen) renderListFilterDD();
  }

  function closeListFilterDD() {
    const dd = qs('#listFilterDD');
    const btn = qs('#listFilterBtn');
    if (dd) dd.classList.remove('open');
    if (btn) btn.classList.remove('open');
    state.listFilterDDOpen = false;
  }

  function setListFilterInternal(filterId, clickedBtn) {
    state.activeListFilter = filterId;

    // Update active class
    qsa('.lf-item').forEach((b) => b.classList.remove('active'));
    if (clickedBtn) clickedBtn.classList.add('active');

    // Update button label
    const label = qs('#listFilterLabel');
    if (label) label.textContent = getFilterLabelText();

    closeListFilterDD();
    renderLiveGrid();
  }

  function lfAddInputChangeInternal(inputEl) {
    // Optional: real-time validation feedback could go here
  }

  function lfAddListInternal() {
    const input = qs('#lfAddInput');
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;

    const btn = qs('.lf-add-btn');
    if (btn) { btn.textContent = 'â€¦'; btn.disabled = true; }

    subscribeExternalList(val, (entry, err) => {
      if (btn) { btn.textContent = 'Add'; btn.disabled = false; }
      if (err) {
        const hint = qs('.lf-add-hint');
        if (hint) { hint.style.color = 'var(--live)'; hint.textContent = err.message; setTimeout(() => { hint.style.color = ''; hint.textContent = 'Paste a Liststr URL or NIP-51 naddr to load a curated list of streamers.'; }, 4000); }
        return;
      }
      input.value = '';
      renderListFilterDD();
      setListFilterInternal(entry.naddr, null);
    });
  }

  function buildStreamCard(stream, idx) {
    // NIP-53: show actual streamer (hostPubkey), not the platform publisher
    const p = profileFor(stream.hostPubkey);
    const card = document.createElement('div');
    const viewerCount = effectiveParticipants(stream);
    const hasViewers = viewerCount > 0;
    const hasVideo = !!stream.streaming;
    card.className = 'stream-card' + (!hasViewers && !hasVideo ? ' stream-card-dim' : '');

    const gradients = ['t1','t2','t3','t4','t5','t6','t7','t8'];
    let thumbHtml;
    if (stream.image) {
      const fb = gradients[idx % gradients.length];
      thumbHtml = `<div class="ct-thumb-wrap"><img class="ct-thumb" src="${stream.image}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'tc ${fb}\\'></div>'"></div>`;
    } else {
      thumbHtml = `<div class="tc ${gradients[idx % gradients.length]}"></div>`;
    }

    const statusLabel = stream.status === 'planned' ? 'SOON' : stream.status.toUpperCase();
    const statusBg = stream.status === 'planned' ? 'background:var(--purple)' : '';
    const viewerText = hasViewers ? `&#128065; ${viewerCount.toLocaleString()}` : (hasVideo ? '&#128065; 0' : '&#8212;');

    card.innerHTML = `
      <div class="ct">
        <div class="ct-inner">${thumbHtml}</div>
        <div class="cb-live" style="${statusBg}"><span class="live-dot"></span>${statusLabel}</div>
        <div class="cb-viewers">${viewerText}</div>
      </div>
      <div class="ci">
        <div class="ci-row">
          <div class="ci-av"></div>
          <div>
            <div class="ci-title"></div>
            <div class="ci-host"></div>
            <div class="ci-tags"><span class="ci-hosted-badge"></span></div>
          </div>
        </div>
      </div>`;

    const avEl = qs('.ci-av', card);
    if (avEl) {
      setAvatarEl(avEl, p.picture || '', pickAvatar(stream.hostPubkey));
      const verifiedNip05 = getVerifiedNip05ForPubkey(stream.hostPubkey, p.nip05 || '');
      if (verifiedNip05) avEl.classList.add('nip05-square');
      else if (normalizeNip05Value(p.nip05 || '')) ensureNip05Verification(stream.hostPubkey, p.nip05 || '').catch(() => {});
    }
    qs('.ci-title', card).textContent = stream.title;
    qs('.ci-host', card).textContent = p.display_name || p.name || shortHex(stream.hostPubkey);
    const hostedBadge = qs('.ci-hosted-badge', card);
    if (hostedBadge && stream.platformPubkey) {
      const plat = profileFor(stream.platformPubkey);
      const platDisplayName = plat.display_name || plat.name || '';
      const hostDisplayName = p.display_name || p.name || '';
      // Only show if the platform is genuinely different from the streamer
      if (platDisplayName && platDisplayName !== hostDisplayName) {
        hostedBadge.textContent = 'via ' + platDisplayName;
      }
    }
    card.addEventListener('click', () => openStream(stream.address));
    return card;
  }

  function getFilteredStreams() {
    // Only show streams that have a browser-playable HTTP(S) URL
    const allStreams = sortedLiveStreams().filter((s) => {
      const url = (s.streaming || '').trim();
      return url && /^https?:\/\//i.test(url);
    });
    const filterPubkeys = getPubkeysForFilter();
    return filterPubkeys
      ? allStreams.filter((s) => filterPubkeys.has(s.pubkey) || filterPubkeys.has(s.hostPubkey))
      : allStreams;
  }

  function renderLiveGrid() {
    const grid = qs('#liveGrid');
    const sentinel = qs('#liveGridSentinel');
    if (!grid) return;

    const allStreams = sortedLiveStreams();
    const streams = getFilteredStreams();

    // Update count pill
    const pill = qs('#liveCountPill');
    if (pill) pill.textContent = streams.length ? `${streams.length} live` : '';

    // Reset page counter and disconnect old observer
    state.liveGridPage = 0;
    if (state.liveGridObserver) { state.liveGridObserver.disconnect(); state.liveGridObserver = null; }

    // Loading state
    if (allStreams.length === 0) {
      grid.innerHTML = '<div class="live-grid-loading"><div class="lf-spinner"></div>Syncing streams from relaysâ€¦</div>';
      return;
    }

    // Empty for filter
    if (streams.length === 0) {
      const f = state.activeListFilter;
      const filterName = f === 'following' ? 'your following list'
        : (() => {
          const n51 = state.nip51Lists.get(f);
          if (n51) return `"${n51.name}"`;
          const sv = state.savedExternalLists.find((l) => l.naddr === f);
          if (sv) return `"${sv.name}"`;
          return 'this filter';
        })();
      grid.innerHTML = `<div class="following-empty" style="grid-column:1/-1"><div class="following-empty-icon">📡</div><div class="following-empty-title">No live streams in ${filterName}</div><div class="following-empty-sub">Nobody in this list is streaming right now.</div></div>`;
      return;
    }

    // Render first page
    grid.innerHTML = '';
    const firstBatch = streams.slice(0, state.GRID_PAGE_SIZE);
    firstBatch.forEach((s, i) => grid.appendChild(buildStreamCard(s, i)));
    state.liveGridPage = 1;

    // If all loaded, show end marker
    if (streams.length <= state.GRID_PAGE_SIZE) {
      grid.insertAdjacentHTML('beforeend', `<div class="live-grid-end">&#8212; ${streams.length} streams loaded &#8212;</div>`);
      return;
    }

    // Set up IntersectionObserver on sentinel for infinite scroll
    if (sentinel && 'IntersectionObserver' in window) {
      state.liveGridObserver = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        loadMoreStreams();
      }, { rootMargin: '200px' });
      state.liveGridObserver.observe(sentinel);
    }
  }

  function loadMoreStreams() {
    const grid = qs('#liveGrid');
    if (!grid) return;
    const streams = getFilteredStreams();
    const start = state.liveGridPage * state.GRID_PAGE_SIZE;
    if (start >= streams.length) {
      if (state.liveGridObserver) { state.liveGridObserver.disconnect(); state.liveGridObserver = null; }
      // Remove existing end marker then add final one
      const existing = grid.querySelector('.live-grid-end');
      if (existing) existing.remove();
      grid.insertAdjacentHTML('beforeend', `<div class="live-grid-end">&#8212; ${streams.length} streams loaded &#8212;</div>`);
      return;
    }

    const batch = streams.slice(start, start + state.GRID_PAGE_SIZE);
    const offset = start; // for gradient cycling
    batch.forEach((s, i) => grid.appendChild(buildStreamCard(s, offset + i)));
    state.liveGridPage++;
  }

  /* =========================================================
     HERO FEATURED STREAM SYSTEM
     - Randomly features available live streams
     - Autoplay with AUDIO (muted only if browser blocks)
     - Skips streams where playback fails
     - Sci-fi glitch/scan-line transition between streams
     - Cycles every 120 s with progress bar; prev/next nav
     ========================================================= */
  const HERO_CYCLE_MS = 120000;

  function heroFeaturedStreams() {
    return sortedLiveStreams().filter(
      (s) => {
        const url = (s.streaming || '').trim();
        return url && /^https?:\/\//i.test(url) && !state.featuredFailed.has(s.address);
      }
    );
  }

  /* ---- Sci-fi transition animation ---- */
  function runHeroTransition(cb) {
    const ov = qs('#heroTransitionOv');
    const player = qs('#heroPlayer');
    if (!ov) { cb(); return; }

    // Spawn data-rain particles
    const NUM_PARTICLES = 18;
    const particles = [];
    for (let i = 0; i < NUM_PARTICLES; i++) {
      const p = document.createElement('div');
      p.className = 'hero-data-particle';
      const h = 30 + Math.random() * 120;
      p.style.cssText = `left:${Math.random() * 100}%;height:${h}px;animation-delay:${Math.random() * 0.25}s;opacity:0;`;
      ov.appendChild(p);
      particles.push(p);
    }

    // Show the fx layers
    ['heroScanLine','heroGlitchA','heroGlitchB','heroGridFlash','heroStatic'].forEach((id) => {
      const el = qs(`#${id}`);
      if (el) el.style.display = '';
    });
    ov.classList.add('active');

    // Glitch background on hero player too
    if (player) player.style.filter = 'brightness(1.4) hue-rotate(-15deg)';

    setTimeout(() => {
      if (player) player.style.filter = '';
      // Clear particles
      particles.forEach((p) => p.remove());
      ['heroScanLine','heroGlitchA','heroGlitchB','heroGridFlash','heroStatic'].forEach((id) => {
        const el = qs(`#${id}`);
        if (el) el.style.display = 'none';
      });
      ov.classList.remove('active');
      cb();
    }, 680);
  }

  /* ---- Progress bar RAF loop ---- */
  function startProgressBar() {
    const fill = qs('#heroCycleBarFill');
    if (!fill) return;
    fill.style.transition = 'none';
    fill.style.width = '0%';
    state.featuredCycleStart = Date.now();

    function tick() {
      const elapsed = Date.now() - state.featuredCycleStart;
      const pct = Math.min((elapsed / HERO_CYCLE_MS) * 100, 100);
      fill.style.width = pct + '%';
      if (pct < 100) {
        state.featuredCycleRafId = requestAnimationFrame(tick);
      }
    }
    if (state.featuredCycleRafId) cancelAnimationFrame(state.featuredCycleRafId);
    state.featuredCycleRafId = requestAnimationFrame(tick);
  }

  /* ---- Indicators ---- */
  function renderHeroIndicators(streams, activeIdx) {
    const wrap = qs('#heroIndicators');
    if (!wrap) return;
    wrap.innerHTML = '';
    const count = Math.min(streams.length, 12);
    for (let i = 0; i < count; i++) {
      const dot = document.createElement('button');
      dot.className = 'hero-dot' + (i === activeIdx ? ' active' : '');
      dot.addEventListener('click', (e) => { e.stopPropagation(); heroGoTo(i, true); });
      wrap.appendChild(dot);
    }
  }

  /* ---- Clear hero HLS ---- */
  function clearHeroPlayback() {
    state.heroPlaybackToken++;
    state.featuredCurrentAddress = '';
    setActiveHeroViewerAddress('');
    if (state.heroHlsInstance) {
      try { state.heroHlsInstance.destroy(); } catch (_) {}
      state.heroHlsInstance = null;
    }
  }

  /* ---- Load and autoplay with AUDIO ---- */
  async function renderHeroPlayer(stream, token) {
    const playerEl = qs('#heroPlayer');
    const bgEl = qs('#heroPlayerBg');
    const ovEl = qs('#heroPlayOv');
    if (!playerEl || !bgEl) return;

    const url = sanitizeMediaUrl(stream.streaming || '');
    const image = sanitizeMediaUrl(stream.image || '');

    // Set background: thumbnail or gradient
    if (image) {
      const safeImage = image.replace(/"/g, '\\"');
      bgEl.style.cssText = `width:100%;height:100%;background:url("${safeImage}") center/cover no-repeat,linear-gradient(135deg,#0d1e30,#1a0a00);`;
    } else {
      bgEl.style.cssText = 'width:100%;height:100%;background:linear-gradient(135deg,#0d1e30,#1a0a00,#080d18);';
    }

    // Wipe any existing video
    const existingVid = playerEl.querySelector('video');
    if (existingVid) existingVid.remove();
    if (ovEl) ovEl.style.display = '';

    if (!url || !/^https?:\/\//i.test(url)) {
      setActiveHeroViewerAddress('');
      return;
    }

    const video = document.createElement('video');
    // Start muted so browser allows autoplay, then unmute immediately
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;z-index:2;';

    const isHls = /\.m3u8($|\?)/i.test(url);
    let hlsObj = null;

    // On media loaded / playing â†’ unmute for audio
    const onCanPlay = () => {
      if (token !== state.heroPlaybackToken) return;
      setActiveHeroViewerAddress(stream.address);
      video.muted = false; // restore audio
      video.volume = 0.8;
      if (ovEl) ovEl.style.display = 'none';
    };
    video.addEventListener('canplay', onCanPlay, { once: true });

    // On error â†’ mark as failed and advance
    video.addEventListener('error', () => {
      if (token !== state.heroPlaybackToken) return;
      setActiveHeroViewerAddress('');
      state.featuredFailed.add(stream.address);
      heroAdvance(1); // skip to next
    });

    playerEl.appendChild(video);

    if (isHls) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().catch(() => {});
      } else {
        try {
          const Hls = await ensureHlsJs();
          if (token !== state.heroPlaybackToken) return;
          if (Hls.isSupported()) {
            hlsObj = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 10 });
            state.heroHlsInstance = hlsObj;
            hlsObj.loadSource(url);
            hlsObj.attachMedia(video);
            hlsObj.on(Hls.Events.MANIFEST_PARSED, () => {
              if (token !== state.heroPlaybackToken) return;
              video.play().catch(() => {});
            });
            hlsObj.on(Hls.Events.ERROR, (_e, data) => {
              if (data && data.fatal && token === state.heroPlaybackToken) {
                setActiveHeroViewerAddress('');
                state.featuredFailed.add(stream.address);
                heroAdvance(1);
              }
            });
          }
        } catch (_) {
          if (token === state.heroPlaybackToken) {
            setActiveHeroViewerAddress('');
            state.featuredFailed.add(stream.address);
            heroAdvance(1);
          }
        }
      }
    } else {
      video.src = url;
      video.play().catch(() => {});
    }
  }

  /* ---- Render hero info panel ---- */
  function renderHero(stream, idx, total) {
    if (!stream) return;
    state.featuredCurrentAddress = stream.address;
    const p = profileFor(stream.hostPubkey);

    const set = (id, v) => { const el = qs('#' + id); if (el) el.textContent = v; };
    const viewerCount = effectiveParticipants(stream);
    set('heroTitle', stream.title);
    set('heroSummary', stream.summary || 'Live stream on Nostr.');
    set('heroHostName', p.name);
    set('heroStatusLabel', (stream.status || 'live').toUpperCase());
    set('heroViewers', viewerCount > 0 ? viewerCount.toLocaleString() : '-');
    set('heroSats', '-');
    set('heroTime', stream.starts ? new Date(stream.starts * 1000).toUTCString().slice(17, 22) + ' UTC' : 'live');

    const avEl = qs('#heroAv');
    if (avEl) setAvatarEl(avEl, p.picture || '', pickAvatar(stream.hostPubkey));
    const nip05El = qs('#heroNip05');
    const heroNip05 = getVerifiedNip05ForPubkey(stream.hostPubkey, p.nip05 || '');
    if (!heroNip05 && normalizeNip05Value(p.nip05 || '')) ensureNip05Verification(stream.hostPubkey, p.nip05 || '').catch(() => {});
    if (nip05El) { nip05El.style.display = heroNip05 ? 'inline' : 'none'; if (heroNip05) nip05El.title = heroNip05; }

    // Wire click to open stream
    const heroEl = qs('#heroStream');
    if (heroEl) heroEl.onclick = () => openStream(stream.address);
    const watchBtn = qs('#heroWatchBtn');
    if (watchBtn) watchBtn.onclick = (e) => { e.stopPropagation(); openStream(stream.address); };

    renderHeroIndicators(heroFeaturedStreams(), idx);
  }

  /* ---- Navigate to a specific index ---- */
  function heroGoTo(idx, userInitiated) {
    const streams = heroFeaturedStreams();
    if (!streams.length) return;
    state.featuredIndex = ((idx % streams.length) + streams.length) % streams.length;

    if (userInitiated) {
      // Instant switch without transition for user-clicked nav
      clearHeroPlayback();
      const token = state.heroPlaybackToken;
      renderHero(streams[state.featuredIndex], state.featuredIndex, streams.length);
      renderHeroPlayer(streams[state.featuredIndex], token);
      resetHeroCycle();
    } else {
      // Auto-cycle: play the sci-fi transition then swap
      runHeroTransition(() => {
        clearHeroPlayback();
        const token = state.heroPlaybackToken;
        renderHero(streams[state.featuredIndex], state.featuredIndex, streams.length);
        renderHeroPlayer(streams[state.featuredIndex], token);
      });
    }
  }

  /* ---- Advance by delta (wraps) ---- */
  function heroAdvance(delta) {
    const streams = heroFeaturedStreams();
    if (!streams.length) return;
    heroGoTo(state.featuredIndex + delta, false);
    resetHeroCycle();
  }

  /* ---- Reset / restart the 120-s cycle timer ---- */
  function resetHeroCycle() {
    if (state.featuredCycleTimer) clearInterval(state.featuredCycleTimer);
    startProgressBar();
    state.featuredCycleTimer = setInterval(() => heroAdvance(1), HERO_CYCLE_MS);
  }

  /* ---- Start hero cycle on page load ---- */
  function startHeroCycle() {
    const streams = heroFeaturedStreams();
    if (!streams.length) return;
    state.featuredIndex = Math.floor(Math.random() * streams.length);
    clearHeroPlayback();
    const token = state.heroPlaybackToken;
    renderHero(streams[state.featuredIndex], state.featuredIndex, streams.length);
    renderHeroPlayer(streams[state.featuredIndex], token);
    resetHeroCycle();
  }

  function stopHeroCycle() {
    if (state.featuredCycleTimer) { clearInterval(state.featuredCycleTimer); state.featuredCycleTimer = null; }
    if (state.featuredCycleRafId) { cancelAnimationFrame(state.featuredCycleRafId); state.featuredCycleRafId = null; }
    clearHeroPlayback();
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
    if (normalizeStreamStatus(stream.status) === 'ended') {
      const endedSummary = String(stream.summary || '').trim();
      const message = endedSummary ? `Stream ended. ${endedSummary}` : 'Stream ended.';
      renderPlaybackFallback(message, stream.streaming || '');
      return;
    }

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

    const isHlsUrl = /\.m3u8($|\?)/i.test(url) || /zap\.stream\//i.test(url);

    if (isHlsUrl) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
      } else {
        try {
          const Hls = await ensureHlsJs();
          if (token !== state.playbackToken) return;
          if (Hls.isSupported()) {
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: true,
              maxBufferLength: 30,
              maxMaxBufferLength: 60,
              manifestLoadingTimeOut: 15000,
              manifestLoadingMaxRetry: 4,
              manifestLoadingRetryDelay: 1000,
              levelLoadingTimeOut: 15000,
              levelLoadingMaxRetry: 4,
              fragLoadingTimeOut: 20000,
              fragLoadingMaxRetry: 4,
              xhrSetup: (xhr) => { xhr.withCredentials = false; }
            });
            state.hlsInstance = hls;
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (token !== state.playbackToken) return;
              video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (token !== state.playbackToken || !data.fatal) return;
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                try { hls.startLoad(); } catch (_) {
                  renderPlaybackFallback('Stream connection lost. The stream may have ended.', url);
                }
              } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                try { hls.recoverMediaError(); } catch (_) {
                  renderPlaybackFallback('Media decode error. Try opening the stream directly.', url);
                }
              } else {
                renderPlaybackFallback('HLS playback error. Try opening the stream directly.', url);
              }
            });
            return; // play triggered via MANIFEST_PARSED
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
    const p = profileFor(stream.hostPubkey);

    // Title & summary
    const title = qs('.sib-title');
    if (title) title.textContent = stream.title;
    const summary = qs('.sib-summary');
    if (summary) summary.textContent = stream.summary || 'Live stream.';

    // Host avatar
    const av = qs('.sib-av');
    if (av) {
      setAvatarEl(av, p.picture || '', pickAvatar(stream.hostPubkey));
      av.onclick = () => showProfileByPubkey(stream.hostPubkey);
    }

    // Host name + nip05
    const name = qs('.sib-name');
    const verifiedNip05 = getVerifiedNip05ForPubkey(stream.hostPubkey, p.nip05 || '');
    if (!verifiedNip05 && normalizeNip05Value(p.nip05 || '')) ensureNip05Verification(stream.hostPubkey, p.nip05 || '').catch(() => {});
    if (name) {
      name.innerHTML = '';
      name.textContent = p.name || shortHex(stream.hostPubkey);
      if (verifiedNip05) {
        const badge = document.createElement('span');
        badge.className = 'nip05-badge';
        badge.title = `NIP-05: ${verifiedNip05}`;
        badge.textContent = '\u2713';
        name.appendChild(document.createTextNode(' '));
        name.appendChild(badge);
      }
    }
    const ident = qs('.sib-identity');
    if (ident) ident.textContent = verifiedNip05 || shortHex(stream.hostPubkey);

    // Hosted-by box: inline in .sib-host-row to the right of .sib-host-info
    let sibHostedBy = qs('.sib-hosted-by');
    if (!sibHostedBy) {
      sibHostedBy = document.createElement('div');
      sibHostedBy.className = 'sib-hosted-by';
      const hostRow = qs('.sib-host-row');
      if (hostRow) hostRow.appendChild(sibHostedBy);
      else if (ident && ident.parentNode) ident.parentNode.appendChild(sibHostedBy);
    }
    sibHostedBy.innerHTML = '';
    if (stream.platformPubkey) {
      const plat = profileFor(stream.platformPubkey);
      const host = profileFor(stream.hostPubkey);
      const platName = plat.display_name || plat.name || '';
      const hostName = host.display_name || host.name || '';
      if (platName && platName !== hostName) {
        const platPic = (plat.picture || '').trim();
        const avHtml = platPic
          ? `<img src="${platPic}" alt="" onerror="this.style.display='none'">`
          : `<span class="hosted-by-av-fallback">${platName.charAt(0).toUpperCase()}</span>`;
        sibHostedBy.innerHTML = `<div class="hosted-by-box"><div class="hosted-by-av">${avHtml}</div><div class="hosted-by-inner"><span class="hosted-by-label">Hosted via</span><span class="hosted-by-name">${platName}</span></div></div>`;
        const box = sibHostedBy.querySelector('.hosted-by-box');
        if (box) box.addEventListener('click', () => showProfileByPubkey(stream.platformPubkey));
      }
    }

    // Stats â€” viewers & relays
    const viewers = qs('#theaterViewers');
    if (viewers) viewers.textContent = formatCount(effectiveParticipants(stream));
    const relays = qs('#theaterRelays');
    if (relays) relays.textContent = String(state.relays.length);

    // Sats â€” sum of zaps received on this stream (if tracked), else show 'â€”'
    const satsEl = qs('#theaterSats');
    if (satsEl) {
      const zapTotal = state.streamZapTotals && state.streamZapTotals.get(stream.address);
      satsEl.textContent = zapTotal != null ? formatCount(zapTotal) : '-';
    }

    // Followers â€” fetch from profileStats if already loaded
    const followersEl = qs('#theaterFollowers');
    if (followersEl) {
      const stats = state.profileStatsByPubkey && state.profileStatsByPubkey.get(stream.pubkey);
      followersEl.textContent = stats ? formatCount(stats.followers || 0) : '-';
    }

    // Runtime counter â€” ticks every second from stream.starts
    clearInterval(state._theaterRuntimeInterval);
    const runtimeEl = qs('#theaterRuntime');
    if (runtimeEl) {
      const updateRuntime = () => {
        const startTs = stream.starts || stream.created_at;
        if (!startTs) { runtimeEl.textContent = '-'; return; }
        const secs = Math.max(0, Math.floor(Date.now() / 1000) - startTs);
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        runtimeEl.textContent = h > 0
          ? `${h}h ${String(m).padStart(2,'0')}m`
          : `${m}m ${String(s).padStart(2,'0')}s`;
      };
      updateRuntime();
      state._theaterRuntimeInterval = setInterval(updateRuntime, 1000);
    }

    // Reactions row state
    const likeBtn = qs('#likeBtn');
    const isLiked = state.likedStreamAddresses.has(stream.address);
    if (likeBtn) likeBtn.classList.toggle('liked', isLiked);
    renderStreamReactionsUi(stream);

    // Follow/share button state
    updateTheaterFollowBtn(stream.hostPubkey);
    updateTheaterShareBtn(stream);
    refreshOwnStreamBoostState(stream);

    renderVideoPlayback(stream);

    // Owner-only controls
    // Ownership: the person who published the NIP-53 event (stream.pubkey), not the host
    const owner = state.user && state.user.pubkey === stream.pubkey;
    const endBtn = qs('#endStreamBtn');
    if (endBtn) endBtn.classList.toggle('visible', !!owner);
    qsa('.owner-only').forEach((n) => n.classList.toggle('visible', !!owner));
  }

  function updateTheaterFollowBtn(pubkey) {
    const btn = qs('#theaterFollowBtn');
    if (!btn) return;
    const isFollowing = isFollowingPubkey(pubkey);
    btn.textContent = isFollowing ? 'Unfollow' : 'Follow';
    btn.classList.toggle('following-active', isFollowing);
  }

  function updateTheaterShareBtn(stream) {
    const btn = qs('#theaterShareBtn');
    if (!btn) return;
    const boosted = !!(state.user && stream && state.boostedStreamAddresses.has(stream.address));
    btn.classList.toggle('boosted', boosted);
  }

  async function findOwnStreamBoostEventId(stream) {
    if (!state.user || !stream || !state.pool) return '';
    const own = normalizePubkeyHex(state.user.pubkey);
    if (!own || !stream.id || !stream.address) return '';

    return new Promise((resolve) => {
      const reposts = new Map();
      const deletedIds = new Set();
      let done = false;
      let subId = null;

      const finish = (id = '') => {
        if (done) return;
        done = true;
        if (subId) {
          try { state.pool.unsubscribe(subId); } catch (_) {}
        }
        resolve(id || '');
      };

      const timeout = setTimeout(() => finish(''), 1800);
      const safeFinish = (id = '') => {
        clearTimeout(timeout);
        finish(id);
      };

      subId = state.pool.subscribe(
        [
          { kinds: [6], authors: [own], '#e': [stream.id], limit: 120, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 120 },
          { kinds: [6], authors: [own], '#a': [stream.address], limit: 120, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 120 },
          { kinds: [KIND_DELETION], authors: [own], limit: 150, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 120 }
        ],
        {
          event: (ev) => {
            if (!ev || !ev.id) return;
            if (ev.kind === 6) {
              reposts.set(ev.id, ev);
              return;
            }
            if (ev.kind === KIND_DELETION) {
              (ev.tags || []).forEach((t) => {
                if (Array.isArray(t) && t[0] === 'e' && t[1]) deletedIds.add(String(t[1]));
              });
            }
          },
          eose: () => {
            const newest = Array.from(reposts.values())
              .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
              .find((ev) => !deletedIds.has(ev.id));
            safeFinish(newest ? newest.id : '');
          }
        }
      );
    });
  }

  async function refreshOwnStreamBoostState(stream) {
    if (!stream || !stream.address) return;
    if (!state.user || !state.pool) {
      state.boostedStreamAddresses.delete(stream.address);
      state.streamBoostEventIdByAddress.delete(stream.address);
      state.streamBoostCheckedByAddress.delete(stream.address);
      state.streamBoostCheckPendingByAddress.delete(stream.address);
      updateTheaterShareBtn(stream);
      return;
    }

    if (state.streamBoostCheckedByAddress.has(stream.address) || state.streamBoostCheckPendingByAddress.has(stream.address)) {
      updateTheaterShareBtn(stream);
      return;
    }

    state.streamBoostCheckPendingByAddress.add(stream.address);
    try {
      const boostId = await findOwnStreamBoostEventId(stream);
      if (boostId) {
        state.boostedStreamAddresses.add(stream.address);
        state.streamBoostEventIdByAddress.set(stream.address, boostId);
      } else {
        state.boostedStreamAddresses.delete(stream.address);
        state.streamBoostEventIdByAddress.delete(stream.address);
      }
      state.streamBoostCheckedByAddress.add(stream.address);
      if (state.selectedStreamAddress === stream.address) updateTheaterShareBtn(stream);
    } catch (_) {
      // no-op
    } finally {
      state.streamBoostCheckPendingByAddress.delete(stream.address);
    }
  }

  // Debounce timer for relay search
  let _searchRelaySubId = null;
  let _searchDebounceTimer = null;

  function buildSearchProfileItem(p, box) {
    const item = document.createElement('div');
    item.className = 'sr-item';
    const verifiedNip05 = getVerifiedNip05ForPubkey(p.pubkey, p.nip05 || '');
    if (!verifiedNip05 && normalizeNip05Value(p.nip05 || '')) ensureNip05Verification(p.pubkey, p.nip05 || '').catch(() => {});
    const hasNip05 = !!verifiedNip05;
    const avClass = hasNip05 ? 'sr-av nip05-square' : 'sr-av';
    item.innerHTML = `<div class="${avClass}"></div><div><div class="sr-title"></div><div class="sr-sub"></div></div>`;
    setAvatarEl(qs('.sr-av', item), p.picture || '', pickAvatar(p.pubkey));
    qs('.sr-title', item).textContent = p.name;
    qs('.sr-sub', item).textContent = verifiedNip05 || shortHex(p.pubkey);
    item.addEventListener('click', () => {
      showProfileByPubkey(p.pubkey);
      box.classList.remove('open');
    });
    return item;
  }

  function renderSearch(term) {
    const box = qs('#searchResults');
    if (!box) return;

    // Cancel any in-flight relay search
    if (_searchDebounceTimer) { clearTimeout(_searchDebounceTimer); _searchDebounceTimer = null; }
    if (_searchRelaySubId && state.pool) {
      try { state.pool.unsubscribe(_searchRelaySubId); } catch (_) {}
      _searchRelaySubId = null;
    }

    if (!term) {
      box.classList.remove('open');
      return;
    }

    const streams = sortedLiveStreams().filter((s) => s.title.toLowerCase().includes(term) || profileFor(s.hostPubkey).name.toLowerCase().includes(term)).slice(0, 5);

    // Local cache match â€” all cached profiles, not just streamers
    const localProfiles = Array.from(state.profilesByPubkey.values()).filter((p) => {
      const t = term.toLowerCase();
      return (p.name || '').toLowerCase().includes(t) ||
             (p.display_name || '').toLowerCase().includes(t) ||
             (p.username || '').toLowerCase().includes(t) ||
             (p.nip05 || '').toLowerCase().includes(t) ||
             (p.pubkey || '').toLowerCase().startsWith(t);
    }).slice(0, 8);

    function rebuildBox(extraProfiles) {
      box.innerHTML = '';

      // --- Streams ---
      if (streams.length) {
        const streamLabel = document.createElement('span');
        streamLabel.className = 'sr-label';
        streamLabel.textContent = 'Live Streams';
        box.appendChild(streamLabel);

        streams.forEach((s) => {
          const p = profileFor(s.pubkey);
          const item = document.createElement('div');
          item.className = 'sr-item';
          item.innerHTML = `<div class="sr-av rect">L</div><div><div class="sr-title"></div><div class="sr-sub"></div></div><span class="sr-live">LIVE</span>`;
          qs('.sr-title', item).textContent = s.title;
          qs('.sr-sub', item).textContent = p.name;
          item.addEventListener('click', () => { openStream(s.address); box.classList.remove('open'); });
          box.appendChild(item);
        });

        const sep = document.createElement('div'); sep.className = 'dd-sep'; box.appendChild(sep);
      }

      // Merge local + extra, de-dupe by pubkey
      const seen = new Set();
      const merged = [];
      [...localProfiles, ...extraProfiles].forEach((p) => {
        if (!seen.has(p.pubkey)) { seen.add(p.pubkey); merged.push(p); }
      });

      // --- Users ---
      const userLabel = document.createElement('span');
      userLabel.className = 'sr-label';
      userLabel.textContent = merged.length ? 'Users' : 'Searching Nostrâ€¦';
      box.appendChild(userLabel);

      merged.slice(0, 8).forEach((p) => {
        box.appendChild(buildSearchProfileItem(p, box));
      });

      box.classList.add('open');
    }

    rebuildBox([]);

    // --- Relay queries for broad Nostr search ---
    _searchDebounceTimer = setTimeout(async () => {
      if (!state.pool) return;

      const extraProfiles = [];
      const relayResults = new Map(); // pubkey -> event

      // 1. If looks like npub â†’ decode + fetch by pubkey
      const npubMatch = term.match(/^npub1[023456789acdefghjklmnpqrstuvwxyz]{6,}/i);
      if (npubMatch) {
        try {
          const tools = await ensureNostrTools();
          const dec = tools.nip19.decode(npubMatch[0].toLowerCase());
          if (dec && dec.type === 'npub') {
            const subId = state.pool.subscribe([{ kinds: [KIND_PROFILE], authors: [dec.data], limit: 1 }], {
              event(ev) {
                const p = parseProfile(ev);
                state.profilesByPubkey.set(p.pubkey, p);
                relayResults.set(p.pubkey, p);
                rebuildBox(Array.from(relayResults.values()));
              },
              eose() {}
            });
            _searchRelaySubId = subId;
          }
        } catch (_) {}
        return;
      }

      // 2. If looks like nip-05 (contains @) â†’ resolve via .well-known
      if (term.includes('@') && term.split('@').length === 2) {
        const [localPart, domain] = term.split('@');
        if (localPart && domain && domain.includes('.')) {
          try {
            const resp = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(localPart)}`);
            const data = await resp.json();
            const pubkey = data.names && (data.names[localPart] || data.names[localPart.toLowerCase()]);
            if (pubkey && /^[0-9a-f]{64}$/i.test(pubkey)) {
              const subId = state.pool.subscribe([{ kinds: [KIND_PROFILE], authors: [pubkey], limit: 1 }], {
                event(ev) {
                  const p = parseProfile(ev);
                  state.profilesByPubkey.set(p.pubkey, p);
                  relayResults.set(p.pubkey, p);
                  rebuildBox(Array.from(relayResults.values()));
                },
                eose() {}
              });
              _searchRelaySubId = subId;
            }
          } catch (_) {}
          return;
        }
      }

      // 3. General text search â€” use NIP-50 search filter (supported by many relays)
      //    Also fetch recent kind:0 events and filter locally
      const filters = [];
      if (term.length >= 2) {
        filters.push({ kinds: [KIND_PROFILE], search: term, limit: 20 });
      }

      if (filters.length) {
        const subId = state.pool.subscribe(filters, {
          event(ev) {
            if (relayResults.has(ev.pubkey)) {
              if ((relayResults.get(ev.pubkey).created_at || 0) >= (ev.created_at || 0)) return;
            }
            const p = parseProfile(ev);
            state.profilesByPubkey.set(p.pubkey, p);
            const t = term.toLowerCase();
            const matches = (p.name || '').toLowerCase().includes(t) ||
                            (p.display_name || '').toLowerCase().includes(t) ||
                            (p.username || '').toLowerCase().includes(t) ||
                            (p.nip05 || '').toLowerCase().includes(t) ||
                            (p.pubkey || '').toLowerCase().startsWith(t);
            if (matches) {
              relayResults.set(p.pubkey, p);
              rebuildBox(Array.from(relayResults.values()));
            }
          },
          eose() {}
        });
        _searchRelaySubId = subId;
      }
    }, 350);
  }

  /* =====================================================================
     NIP-21 CONTENT RENDERING â€” nostr:npub / nprofile / nevent / note
     Parses inline nostr: entities per NIP-21 and renders them as:
     - npub1 / nprofile1 â†’ clickable @mention pill (fetches profile)
     - nevent1 / note1   â†’ embedded quoted note card (fetches event + author)
     ===================================================================== */

  function _decodeNostrEntity(entity) {
    if (!window.NostrTools || !window.NostrTools.nip19) return null;
    try {
      const dec = window.NostrTools.nip19.decode(entity);
      if (!dec) return null;
      if (dec.type === 'npub')    return { type: 'npub',    pubkey: dec.data };
      if (dec.type === 'nprofile') return { type: 'nprofile', pubkey: dec.data.pubkey };
      if (dec.type === 'nevent')  return { type: 'nevent',  eventId: dec.data.id };
      if (dec.type === 'note')    return { type: 'note',    eventId: dec.data };
      return null;
    } catch (_) { return null; }
  }

  function _fetchEventById(eventId) {
    return new Promise((resolve) => {
      if (!eventId || !/^[0-9a-f]{64}$/i.test(eventId)) { resolve(null); return; }
      let done = false;
      const finish = (val) => {
        if (done) return; done = true;
        try { state.pool.unsubscribe(sub); } catch (_) {}
        clearTimeout(timer);
        resolve(val);
      };
      const timer = setTimeout(() => finish(null), 6000);
      const sub = state.pool.subscribe(
        [{ ids: [eventId], limit: 1 }],
        {
          event: (ev) => { if (ev.id === eventId) finish(ev); },
          eose: () => finish(null)
        }
      );
    });
  }

  function _buildMentionPill(pubkey) {
    const pill = document.createElement('span');
    pill.className = 'nostr-mention-pill';
    const known = state.profilesByPubkey.has(pubkey);
    const p = profileFor(pubkey);
    pill.textContent = '@' + (known ? p.name : shortHex(pubkey));
    pill.style.cursor = 'pointer';
    pill.onclick = (e) => { e.stopPropagation(); showProfileByPubkey(pubkey); };
    if (!known) {
      fetchProfileIfNeeded(pubkey).then(() => {
        const fresh = profileFor(pubkey);
        pill.textContent = '@' + (fresh.name || shortHex(pubkey));
      }).catch(() => {});
    }
    return pill;
  }

  function _buildNeventCard(entity) {
    const card = document.createElement('div');
    card.className = 'nevent-embed-card';
    card.textContent = 'Loading quoted noteâ€¦';

    const doLoad = () => {
      const decoded = _decodeNostrEntity(entity);
      if (!decoded || !decoded.eventId) { card.textContent = '[could not parse note reference]'; return; }
      _fetchEventById(decoded.eventId).then((ev) => {
        if (!ev) { card.textContent = '[note not found on connected relays]'; return; }
        return fetchProfileIfNeeded(ev.pubkey).then(() => {
          const p = profileFor(ev.pubkey);
          card.innerHTML = '';

          const header = document.createElement('div');
          header.className = 'nevent-embed-header';
          const av = document.createElement('div');
          av.className = 'nevent-embed-av';
          setAvatarEl(av, p.picture || '', pickAvatar(ev.pubkey));
          const nameSpan = document.createElement('span');
          nameSpan.className = 'nevent-embed-name';
          nameSpan.textContent = p.name || shortHex(ev.pubkey);
          nameSpan.onclick = (e) => { e.stopPropagation(); showProfileByPubkey(ev.pubkey); };
          const timeSpan = document.createElement('span');
          timeSpan.className = 'nevent-embed-time';
          timeSpan.textContent = formatTimeAgo(ev.created_at) + ' ago';
          header.appendChild(av);
          header.appendChild(nameSpan);
          header.appendChild(timeSpan);

          const body = document.createElement('div');
          body.className = 'nevent-embed-body';
          const mediaUrls = extractMediaUrlsFromEvent(ev);
          const previewText = stripMediaUrlsFromText(ev.content || '', mediaUrls);
          body.textContent = previewText.slice(0, 280) + (previewText.length > 280 ? 'â€¦' : '');

          card.appendChild(header);
          card.appendChild(body);
          card.onclick = () => showProfileByPubkey(ev.pubkey);
        });
      }).catch(() => { card.textContent = '[error loading note]'; });
    };

    // If NostrTools isn't ready yet, wait for it
    if (window.NostrTools && window.NostrTools.nip19) {
      doLoad();
    } else {
      ensureNostrTools().then(doLoad).catch(() => { card.textContent = '[error loading note]'; });
    }
    return card;
  }

  // Main content renderer â€” returns a DocumentFragment safe for appending to DOM
  function renderNostrContent(text) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;

    // NIP-21: nostr:<bech32entity>
    const RE = /nostr:(npub1[a-zA-Z0-9]+|nprofile1[a-zA-Z0-9]+|nevent1[a-zA-Z0-9]+|note1[a-zA-Z0-9]+)/g;
    let last = 0;
    let m;
    while ((m = RE.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const entity = m[1];
      if (entity.startsWith('npub1') || entity.startsWith('nprofile1')) {
        // Decode immediately if NostrTools ready, else async placeholder
        if (window.NostrTools && window.NostrTools.nip19) {
          const decoded = _decodeNostrEntity(entity);
          frag.appendChild(decoded ? _buildMentionPill(decoded.pubkey) : document.createTextNode(m[0]));
        } else {
          const pill = document.createElement('span');
          pill.className = 'nostr-mention-pill';
          pill.textContent = '@' + entity.slice(0, 12) + 'â€¦';
          frag.appendChild(pill);
          ensureNostrTools().then(() => {
            const decoded = _decodeNostrEntity(entity);
            if (decoded && decoded.pubkey) {
              pill.textContent = '@' + (profileFor(decoded.pubkey).name || shortHex(decoded.pubkey));
              pill.onclick = (e) => { e.stopPropagation(); showProfileByPubkey(decoded.pubkey); };
              fetchProfileIfNeeded(decoded.pubkey).then(() => {
                pill.textContent = '@' + (profileFor(decoded.pubkey).name || shortHex(decoded.pubkey));
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      } else if (entity.startsWith('nevent1') || entity.startsWith('note1')) {
        frag.appendChild(_buildNeventCard(entity));
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = RE.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  /* ===================================================================== */

  function firstTagValue(tags, key) {
    const found = (tags || []).find((t) => Array.isArray(t) && t[0] === key && t[1]);
    return found ? String(found[1]) : '';
  }

  function allTagValues(tags, key) {
    return (tags || [])
      .filter((t) => Array.isArray(t) && t[0] === key && t[1])
      .map((t) => String(t[1]));
  }

  function formatChatTimestamp(ts) {
    const val = Number(ts || 0);
    if (!val) return '--:--';
    try {
      return new Date(val * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '--:--';
    }
  }

  function chatReactionKey(messageId, pubkey) {
    return `${messageId}:${pubkey}`;
  }

  function applyChatLikeReaction(messageId, pubkey, reactionEventId) {
    if (!messageId || !pubkey) return;
    if (!state.chatLikePubkeysByMessageId.has(messageId)) {
      state.chatLikePubkeysByMessageId.set(messageId, new Set());
    }
    state.chatLikePubkeysByMessageId.get(messageId).add(pubkey);

    const key = chatReactionKey(messageId, pubkey);
    const prevReactionId = state.chatReactionIdByMessageAndPubkey && state.chatReactionIdByMessageAndPubkey.get(key);
    if (prevReactionId && prevReactionId !== reactionEventId) {
      state.chatReactionEventById.delete(prevReactionId);
    }
    if (!state.chatReactionIdByMessageAndPubkey) state.chatReactionIdByMessageAndPubkey = new Map();
    if (reactionEventId) {
      state.chatReactionIdByMessageAndPubkey.set(key, reactionEventId);
      state.chatReactionEventById.set(reactionEventId, { messageId, pubkey });
    }

    if (state.user && normalizePubkeyHex(state.user.pubkey) === normalizePubkeyHex(pubkey)) {
      if (reactionEventId) state.chatOwnLikeEventByMessageId.set(messageId, reactionEventId);
      else {
        const ownKnown = state.chatReactionIdByMessageAndPubkey.get(key);
        if (ownKnown) state.chatOwnLikeEventByMessageId.set(messageId, ownKnown);
      }
    }
  }

  function applyChatUnlikeByReactionId(reactionEventId) {
    if (!reactionEventId) return;
    const meta = state.chatReactionEventById.get(reactionEventId);
    if (!meta) return;
    state.chatReactionEventById.delete(reactionEventId);
    if (!state.chatReactionIdByMessageAndPubkey) state.chatReactionIdByMessageAndPubkey = new Map();
    const key = chatReactionKey(meta.messageId, meta.pubkey);
    if (state.chatReactionIdByMessageAndPubkey.get(key) === reactionEventId) {
      state.chatReactionIdByMessageAndPubkey.delete(key);
    }

    const set = state.chatLikePubkeysByMessageId.get(meta.messageId);
    if (set) {
      set.delete(meta.pubkey);
      if (!set.size) state.chatLikePubkeysByMessageId.delete(meta.messageId);
    }

    if (state.user && normalizePubkeyHex(state.user.pubkey) === normalizePubkeyHex(meta.pubkey)) {
      const ownReactionId = state.chatOwnLikeEventByMessageId.get(meta.messageId);
      if (ownReactionId === reactionEventId) state.chatOwnLikeEventByMessageId.delete(meta.messageId);
    }
  }

  function updateChatLikeUi(messageId) {
    if (!messageId) return;
    const rows = qsa(`.cmsg[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!rows.length) return;

    const likedBy = state.chatLikePubkeysByMessageId.get(messageId) || new Set();
    const count = likedBy.size;
    const userPubkey = state.user ? normalizePubkeyHex(state.user.pubkey) : '';
    const isLiked = !!(userPubkey && likedBy.has(userPubkey));

    rows.forEach((row) => {
      const btn = qs('.chat-like-btn', row);
      const countEl = qs('.chat-like-count', row);
      if (countEl) countEl.textContent = `${count}`;
      if (btn) {
        btn.classList.toggle('active', isLiked);
        btn.title = isLiked ? 'Unlike' : 'Like';
      }
    });
  }

  function normalizeReactionContentKey(content) {
    const raw = String(content == null ? '' : content).trim();
    if (!raw) return '+';
    const low = raw.toLowerCase();
    if (low === '+' || low === 'like' || raw === '❤' || raw === '❤️') return '+';
    if (low === '-') return '-';
    return raw;
  }

  function parseReactionMeta(content, tags) {
    const key = normalizeReactionContentKey(content);
    if (!key || key === '-') return null;
    if (key === '+') return { key: '+', label: '❤', imageUrl: '', shortcode: '' };

    let imageUrl = '';
    let shortcode = '';
    const match = key.match(/^:([a-z0-9_+\-]{1,64}):$/i);
    if (match) {
      shortcode = match[1];
      const emojiTag = (tags || []).find((t) =>
        Array.isArray(t) &&
        String(t[0] || '').toLowerCase() === 'emoji' &&
        String(t[1] || '').toLowerCase() === shortcode.toLowerCase() &&
        isLikelyUrl(String(t[2] || ''))
      );
      if (emojiTag) imageUrl = String(emojiTag[2] || '').trim();
    }

    return { key, label: key, imageUrl, shortcode };
  }

  function streamReactionUserKey(reactionKey, pubkey) {
    return `${encodeURIComponent(reactionKey || '')}:${normalizePubkeyHex(pubkey || '')}`;
  }

  function ensureStreamReactionSet(reactionKey) {
    if (!state.streamReactionPubkeysByKey.has(reactionKey)) {
      state.streamReactionPubkeysByKey.set(reactionKey, new Set());
    }
    return state.streamReactionPubkeysByKey.get(reactionKey);
  }

  function streamReactionCount(reactionKey) {
    const set = state.streamReactionPubkeysByKey.get(reactionKey);
    return set ? set.size : 0;
  }

  function applyStreamReaction(reactionMeta, pubkey, reactionEventId) {
    if (!reactionMeta || !reactionMeta.key || !pubkey) return;
    const normalizedPubkey = normalizePubkeyHex(pubkey);
    if (!normalizedPubkey) return;

    const key = reactionMeta.key;
    const set = ensureStreamReactionSet(key);
    set.add(normalizedPubkey);

    if (key !== '+' && (reactionMeta.label || reactionMeta.imageUrl)) {
      state.streamReactionMetaByKey.set(key, {
        label: reactionMeta.label || key,
        imageUrl: reactionMeta.imageUrl || '',
        shortcode: reactionMeta.shortcode || ''
      });
    }

    const userKey = streamReactionUserKey(key, normalizedPubkey);
    const prevReactionId = state.streamReactionIdByKeyAndPubkey.get(userKey);
    if (prevReactionId && prevReactionId !== reactionEventId) {
      state.streamReactionEventById.delete(prevReactionId);
    }

    if (reactionEventId) {
      state.streamReactionIdByKeyAndPubkey.set(userKey, reactionEventId);
      state.streamReactionEventById.set(reactionEventId, { reactionKey: key, pubkey: normalizedPubkey });
    }

    const own = state.user ? normalizePubkeyHex(state.user.pubkey) : '';
    const currentAddress = state.selectedStreamAddress;
    if (own && own === normalizedPubkey) {
      if (reactionEventId) state.streamOwnReactionIdByKey.set(key, reactionEventId);
      if (key === '+' && currentAddress) {
        state.likedStreamAddresses.add(currentAddress);
        if (reactionEventId) state.streamLikeEventIdByAddress.set(currentAddress, reactionEventId);
      }
    }
  }

  function removeOwnStreamReactionByKey(reactionKey) {
    const own = state.user ? normalizePubkeyHex(state.user.pubkey) : '';
    if (!own || !reactionKey) return;
    const userKey = streamReactionUserKey(reactionKey, own);
    const reactionId = state.streamReactionIdByKeyAndPubkey.get(userKey);
    if (reactionId) state.streamReactionEventById.delete(reactionId);
    state.streamReactionIdByKeyAndPubkey.delete(userKey);
    state.streamOwnReactionIdByKey.delete(reactionKey);

    const set = state.streamReactionPubkeysByKey.get(reactionKey);
    if (set) {
      set.delete(own);
      if (!set.size) {
        state.streamReactionPubkeysByKey.delete(reactionKey);
        if (reactionKey !== '+') state.streamReactionMetaByKey.delete(reactionKey);
      }
    }

    if (reactionKey === '+') {
      const currentAddress = state.selectedStreamAddress;
      if (currentAddress) {
        state.likedStreamAddresses.delete(currentAddress);
        state.streamLikeEventIdByAddress.delete(currentAddress);
      }
    }
  }

  function removeStreamReactionById(reactionEventId) {
    if (!reactionEventId) return;
    const meta = state.streamReactionEventById.get(reactionEventId);
    if (!meta) return;

    state.streamReactionEventById.delete(reactionEventId);
    const userKey = streamReactionUserKey(meta.reactionKey, meta.pubkey);
    if (state.streamReactionIdByKeyAndPubkey.get(userKey) === reactionEventId) {
      state.streamReactionIdByKeyAndPubkey.delete(userKey);
    }

    const set = state.streamReactionPubkeysByKey.get(meta.reactionKey);
    if (set) {
      set.delete(meta.pubkey);
      if (!set.size) {
        state.streamReactionPubkeysByKey.delete(meta.reactionKey);
        if (meta.reactionKey !== '+') state.streamReactionMetaByKey.delete(meta.reactionKey);
      }
    }

    const own = state.user ? normalizePubkeyHex(state.user.pubkey) : '';
    if (own && own === normalizePubkeyHex(meta.pubkey)) {
      if (state.streamOwnReactionIdByKey.get(meta.reactionKey) === reactionEventId) {
        state.streamOwnReactionIdByKey.delete(meta.reactionKey);
      }
      if (meta.reactionKey === '+') {
        const currentAddress = state.selectedStreamAddress;
        if (currentAddress) {
          state.likedStreamAddresses.delete(currentAddress);
          state.streamLikeEventIdByAddress.delete(currentAddress);
        }
      }
    }
  }

  function renderStreamReactionsUi(stream) {
    const list = qs('#streamEmojiList');
    const likeCounter = qs('#streamLikeCounter');
    const likeBtn = qs('#likeBtn');
    const current = stream || state.streamsByAddress.get(state.selectedStreamAddress);

    if (!current) {
      if (list) list.innerHTML = '';
      if (likeCounter) likeCounter.textContent = '0 likes';
      if (likeBtn) likeBtn.classList.remove('liked');
      return;
    }

    const own = state.user ? normalizePubkeyHex(state.user.pubkey) : '';
    const likeSet = state.streamReactionPubkeysByKey.get('+') || new Set();
    const isLiked = !!(own && likeSet.has(own));
    const likeTotal = likeSet.size;
    if (likeCounter) likeCounter.textContent = `${likeTotal} like${likeTotal === 1 ? '' : 's'}`;
    if (likeBtn) likeBtn.classList.toggle('liked', isLiked || state.likedStreamAddresses.has(current.address));

    if (own && isLiked) state.likedStreamAddresses.add(current.address);

    if (!list) return;
    list.innerHTML = '';
    const entries = Array.from(state.streamReactionPubkeysByKey.entries())
      .filter(([key, set]) => key !== '+' && set && set.size)
      .map(([key, set]) => ({
        key,
        count: set.size,
        active: !!(own && set.has(own)),
        meta: state.streamReactionMetaByKey.get(key) || { label: key, imageUrl: '', shortcode: '' }
      }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.key.localeCompare(b.key);
      });

    entries.forEach((entry) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'stream-emoji-chip' + (entry.active ? ' active' : '');
      chip.title = `${entry.meta.label || entry.key} (${entry.count})`;
      chip.addEventListener('click', () => window.toggleStreamEmojiReaction(entry.key));

      const countEl = document.createElement('span');
      countEl.className = 'stream-emoji-count';
      countEl.textContent = `${entry.count}`;
      chip.appendChild(countEl);

      if (entry.meta.imageUrl) {
        const img = document.createElement('img');
        img.src = entry.meta.imageUrl;
        img.alt = entry.meta.label || entry.key;
        img.loading = 'lazy';
        chip.appendChild(img);
      } else {
        const txt = document.createElement('span');
        txt.textContent = String(entry.meta.label || entry.key).slice(0, 18);
        chip.appendChild(txt);
      }
      list.appendChild(chip);
    });
  }

  async function findOwnStreamReactionIdByKey(stream, reactionKey) {
    if (!state.user || !stream || !state.pool) return '';
    const own = normalizePubkeyHex(state.user.pubkey);
    if (!own) return '';
    const wantedKey = normalizeReactionContentKey(reactionKey);
    if (!wantedKey || wantedKey === '-') return '';

    return new Promise((resolve) => {
      const reactions = new Map();
      const deletedIds = new Set();
      let done = false;
      let subId = null;
      const finish = (id = '') => {
        if (done) return;
        done = true;
        if (subId) {
          try { state.pool.unsubscribe(subId); } catch (_) {}
        }
        resolve(id || '');
      };

      subId = state.pool.subscribe(
        [
          { kinds: [KIND_REACTION], authors: [own], '#e': [stream.id], limit: 120, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30 },
          { kinds: [KIND_REACTION], authors: [own], '#a': [stream.address], limit: 120, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30 },
          { kinds: [KIND_DELETION], authors: [own], limit: 120, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30 }
        ],
        {
          event: (ev) => {
            if (ev.kind === KIND_REACTION) {
              const reaction = parseReactionMeta(ev.content, ev.tags);
              if (!reaction || reaction.key !== wantedKey) return;
              const aTag = firstTagValue(ev.tags, 'a');
              if (aTag && aTag !== stream.address) return;
              const eTag = firstTagValue(ev.tags, 'e');
              if (eTag && eTag !== stream.id) return;
              reactions.set(ev.id, ev);
              return;
            }
            if (ev.kind === KIND_DELETION) {
              allTagValues(ev.tags, 'e').forEach((id) => {
                if (/^[0-9a-f]{64}$/i.test(id)) deletedIds.add(id);
              });
            }
          },
          eose: () => {}
        }
      );

      setTimeout(() => {
        const active = Array.from(reactions.values())
          .filter((ev) => !deletedIds.has(ev.id))
          .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
        finish(active.length ? active[0].id : '');
      }, 4500);
    });
  }

  async function findOwnStreamLikeReactionId(stream) {
    return findOwnStreamReactionIdByKey(stream, '+');
  }

  async function findOwnChatLikeReactionId(messageId, stream) {
    if (!state.user || !state.pool || !messageId || !stream) return '';
    const own = normalizePubkeyHex(state.user.pubkey);
    if (!own) return '';

    return new Promise((resolve) => {
      const reactions = new Map();
      const deletedIds = new Set();
      let done = false;
      let subId = null;
      const finish = (id = '') => {
        if (done) return;
        done = true;
        if (subId) {
          try { state.pool.unsubscribe(subId); } catch (_) {}
        }
        resolve(id || '');
      };

      subId = state.pool.subscribe(
        [
          { kinds: [KIND_REACTION], authors: [own], '#e': [messageId], limit: 100, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30 },
          { kinds: [KIND_DELETION], authors: [own], limit: 120, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30 }
        ],
        {
          event: (ev) => {
            if (ev.kind === KIND_REACTION) {
              const content = (ev.content || '').trim();
              if (content !== '+') return;
              const aTag = firstTagValue(ev.tags, 'a');
              if (aTag && aTag !== stream.address) return;
              reactions.set(ev.id, ev);
              return;
            }
            if (ev.kind === KIND_DELETION) {
              allTagValues(ev.tags, 'e').forEach((id) => {
                if (/^[0-9a-f]{64}$/i.test(id)) deletedIds.add(id);
              });
            }
          },
          eose: () => {}
        }
      );

      setTimeout(() => {
        const active = Array.from(reactions.values())
          .filter((ev) => !deletedIds.has(ev.id))
          .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
        finish(active.length ? active[0].id : '');
      }, 4500);
    });
  }

  function postReactionPendingKey(noteId, reactionKey) {
    return `${noteId}:${encodeURIComponent(reactionKey || '')}`;
  }

  async function findOwnPostReactionId(noteId, reactionKey) {
    if (!state.user || !state.pool || !noteId) return '';
    const own = normalizePubkeyHex(state.user.pubkey);
    if (!own) return '';
    const wantedKey = normalizeReactionContentKey(reactionKey);
    if (!wantedKey || wantedKey === '-') return '';

    return new Promise((resolve) => {
      const reactions = new Map();
      const deletedIds = new Set();
      let done = false;
      let subId = null;
      const finish = (id = '') => {
        if (done) return;
        done = true;
        if (subId) {
          try { state.pool.unsubscribe(subId); } catch (_) {}
        }
        resolve(id || '');
      };

      subId = state.pool.subscribe(
        [
          { kinds: [KIND_REACTION], authors: [own], '#e': [noteId], limit: 100, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 90 },
          { kinds: [KIND_DELETION], authors: [own], limit: 120, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 90 }
        ],
        {
          event: (ev) => {
            if (ev.kind === KIND_REACTION) {
              const reaction = parseReactionMeta(ev.content, ev.tags);
              if (!reaction || reaction.key !== wantedKey) return;
              const eTag = firstTagValue(ev.tags, 'e');
              if (eTag && eTag !== noteId) return;
              reactions.set(ev.id, ev);
              return;
            }
            if (ev.kind === KIND_DELETION) {
              allTagValues(ev.tags, 'e').forEach((id) => {
                if (/^[0-9a-f]{64}$/i.test(id)) deletedIds.add(id);
              });
            }
          },
          eose: () => {}
        }
      );

      setTimeout(() => {
        const active = Array.from(reactions.values())
          .filter((ev) => !deletedIds.has(ev.id))
          .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
        finish(active.length ? active[0].id : '');
      }, 4500);
    });
  }

  function reactionMetaFromPicker(codeInput, urlInput = '') {
    const code = String(codeInput || '').trim();
    if (!code) return null;
    const url = String(urlInput || '').trim();
    const tagList = [];
    const shortMatch = code.match(/^:([a-z0-9_+\-]{1,64}):$/i);
    if (shortMatch && isLikelyUrl(url)) {
      tagList.push(['emoji', shortMatch[1], url]);
    }
    const meta = parseReactionMeta(code, tagList);
    if (!meta) return null;
    if (shortMatch && isLikelyUrl(url)) {
      meta.shortcode = shortMatch[1];
      meta.imageUrl = url;
    }
    return meta;
  }

  function defaultReactionPickerOptions() {
    const out = [];
    const seen = new Set();
    ['❤', '🔥', '👏', '⚡', '😂', '😮', '🚀', '🤙'].forEach((val) => {
      const meta = reactionMetaFromPicker(val, '');
      if (!meta || seen.has(meta.key)) return;
      seen.add(meta.key);
      out.push(meta);
    });
    state.streamReactionMetaByKey.forEach((meta, key) => {
      if (!key || key === '+' || seen.has(key)) return;
      seen.add(key);
      out.push({
        key,
        label: meta && meta.label ? meta.label : key,
        imageUrl: meta && meta.imageUrl ? meta.imageUrl : '',
        shortcode: meta && meta.shortcode ? meta.shortcode : ''
      });
    });
    return out.slice(0, 30);
  }

  async function toggleStreamReactionByMeta(reactionMeta) {
    const stream = state.streamsByAddress.get(state.selectedStreamAddress);
    if (!stream || !reactionMeta || !reactionMeta.key) return;
    if (!state.user) { window.openLogin(); return; }
    const own = normalizePubkeyHex(state.user.pubkey);
    if (!own) return;

    const reactionKey = reactionMeta.key;
    if (state.streamReactionPublishPendingByKey.has(reactionKey)) return;
    state.streamReactionPublishPendingByKey.add(reactionKey);

    const userKey = streamReactionUserKey(reactionKey, own);
    const activeSet = state.streamReactionPubkeysByKey.get(reactionKey) || new Set();
    const wasActive = activeSet.has(own);
    let knownReactionId = state.streamReactionIdByKeyAndPubkey.get(userKey) || state.streamOwnReactionIdByKey.get(reactionKey) || '';

    try {
      if (wasActive) {
        if (!knownReactionId) {
          knownReactionId = await findOwnStreamReactionIdByKey(stream, reactionKey);
        }

        removeOwnStreamReactionByKey(reactionKey);
        renderStreamReactionsUi(stream);

        if (knownReactionId) {
          await signAndPublish(KIND_DELETION, 'removed stream reaction', [['e', knownReactionId], ['k', String(KIND_REACTION)], ['a', stream.address]]);
          removeStreamReactionById(knownReactionId);
        } else if (reactionKey === '+') {
          await signAndPublish(KIND_REACTION, '-', [['e', stream.id], ['p', stream.pubkey], ['a', stream.address]]);
        } else {
          throw new Error('Could not find your existing reaction to remove yet. Try again.');
        }
      } else {
        const tags = [['e', stream.id], ['p', stream.pubkey], ['a', stream.address]];
        if (reactionMeta.shortcode && reactionMeta.imageUrl) {
          tags.push(['emoji', reactionMeta.shortcode, reactionMeta.imageUrl]);
        }
        const signed = await signAndPublish(KIND_REACTION, reactionKey, tags);
        applyStreamReaction(reactionMeta, own, signed && signed.id ? signed.id : '');
      }
      renderStreamReactionsUi(stream);
    } catch (err) {
      if (wasActive) {
        applyStreamReaction(reactionMeta, own, knownReactionId || '');
      } else {
        removeOwnStreamReactionByKey(reactionKey);
      }
      renderStreamReactionsUi(stream);
      alert(err && err.message ? err.message : 'Failed to update reaction.');
    } finally {
      state.streamReactionPublishPendingByKey.delete(reactionKey);
    }
  }

  async function togglePostReactionByMeta(noteId, notePubkey, profilePubkey, reactionMeta) {
    if (!noteId || !reactionMeta || !reactionMeta.key) return;
    if (!state.user) { window.openLogin(); return; }
    const pendingKey = postReactionPendingKey(noteId, reactionMeta.key);
    if (state.postReactionPublishPendingByNoteAndKey.has(pendingKey)) return;
    state.postReactionPublishPendingByNoteAndKey.add(pendingKey);

    try {
      const existingReactionId = await findOwnPostReactionId(noteId, reactionMeta.key);
      const map = state.profileNotesByPubkey.get(profilePubkey) || new Map();

      if (existingReactionId) {
        const delTags = [['e', existingReactionId], ['k', String(KIND_REACTION)], ['p', notePubkey]];
        const deletion = await signAndPublish(KIND_DELETION, 'removed post reaction', delTags);
        if (deletion && deletion.id) map.set(deletion.id, deletion);
      } else {
        const tags = [['e', noteId], ['p', notePubkey]];
        if (reactionMeta.shortcode && reactionMeta.imageUrl) {
          tags.push(['emoji', reactionMeta.shortcode, reactionMeta.imageUrl]);
        }
        const signed = await signAndPublish(KIND_REACTION, reactionMeta.key, tags);
        if (signed && signed.id) map.set(signed.id, signed);
      }

      state.profileNotesByPubkey.set(profilePubkey, map);
      renderProfileFeed(profilePubkey);
    } catch (err) {
      alert(err && err.message ? err.message : 'Failed to update post reaction.');
    } finally {
      state.postReactionPublishPendingByNoteAndKey.delete(pendingKey);
    }
  }

  function renderChatInlineMedia(container, mediaUrls) {
    if (!container || !Array.isArray(mediaUrls) || !mediaUrls.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'chat-media-wrap';
    if (mediaUrls.length === 1) wrap.classList.add('single');
    mediaUrls.slice(0, 4).forEach((url) => {
      const a = document.createElement('a');
      a.className = 'chat-media-item' + (mediaUrls.length === 1 ? ' single' : '');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Chat image';
      img.loading = 'lazy';
      img.addEventListener('error', () => { a.remove(); });
      a.appendChild(img);
      wrap.appendChild(a);
    });
    if (wrap.children.length) container.appendChild(wrap);
  }

  function renderChatMessage(ev) {
    const sc = qs('#chatScroll');
    if (!sc) return;
    state.chatMessageEventsById.set(ev.id, ev);
    const p = profileFor(ev.pubkey);
    const row = document.createElement('div');
    row.className = 'cmsg';
    row.dataset.pubkey = ev.pubkey;
    row.dataset.msgId = ev.id;
    row.innerHTML = `<div class="c-av"></div><div class="c-body"><div class="c-name-row"><span class="c-name"></span><span class="c-time"></span></div><div class="c-text"></div></div><div class="chat-msg-actions"><button class="cma-btn like-cma chat-like-btn" title="Like">❤ <span class="chat-like-count">0</span></button></div>`;
    const avEl = qs('.c-av', row);
    setAvatarEl(avEl, p.picture || '', pickAvatar(ev.pubkey));
    const chatNip05 = getVerifiedNip05ForPubkey(ev.pubkey, p.nip05 || '');
    if (chatNip05) avEl.classList.add('nip05-square');
    else if (normalizeNip05Value(p.nip05 || '')) ensureNip05Verification(ev.pubkey, p.nip05 || '').catch(() => {});
    avEl.onclick = () => showProfileByPubkey(ev.pubkey);
    const nameEl = qs('.c-name', row);
    nameEl.textContent = state.profilesByPubkey.has(ev.pubkey) ? p.name : shortHex(ev.pubkey);
    nameEl.onclick = () => showProfileByPubkey(ev.pubkey);
    const timeEl = qs('.c-time', row);
    if (timeEl) {
      timeEl.textContent = formatChatTimestamp(ev.created_at);
      try { timeEl.title = new Date(Number(ev.created_at || 0) * 1000).toLocaleString(); } catch (_) {}
    }
    const ctext = qs('.c-text', row);
    const rawText = String(ev.content || '');
    const mediaUrls = Array.from(new Set(
      extractHttpUrls(rawText)
        .map((u) => sanitizeMediaUrl(u))
        .filter((u) => classifyMediaUrl(u) === 'photo')
    ));
    const renderText = mediaUrls.length ? stripMediaUrlsFromText(rawText, mediaUrls) : rawText;
    if (renderText) ctext.appendChild(renderNostrContent(renderText));
    renderChatInlineMedia(ctext, mediaUrls);
    const likeBtn = qs('.chat-like-btn', row);
    if (likeBtn) likeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.toggleChatLikeMessage(ev.id);
    });
    sc.appendChild(row);
    updateChatLikeUi(ev.id);
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
      renderFollowingCount();
      updateGoLiveButtonState();
      return;
    }
    setLoggedInUi(true);
    const p = state.user.profile || { name: shortHex(state.user.pubkey), nip05: '' };
    const claimedNip05 = normalizeNip05Value(p.nip05 || '');
    const verifiedNip05 = getVerifiedNip05ForPubkey(state.user.pubkey, claimedNip05);
    if (claimedNip05 && !verifiedNip05) ensureNip05Verification(state.user.pubkey, claimedNip05).catch(() => {});
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
    if (pdSub) {
      const base = verifiedNip05 || (claimedNip05 ? `${claimedNip05} (unverified)` : shortHex(state.user.pubkey));
      pdSub.textContent = state.authMode === 'local' ? `${base} (local key)` : base;
    }
    if (navBadge) navBadge.style.display = verifiedNip05 ? 'inline' : 'none';
    if (pdBadge) pdBadge.style.display = verifiedNip05 ? 'inline' : 'none';

    // Apply NIP-05 square glow to nav/dropdown avatars
    if (navAvatar) navAvatar.classList.toggle('nip05-square', !!verifiedNip05);
    if (pdAv) pdAv.classList.toggle('nip05-square', !!verifiedNip05);

    // Load user's contact list + NIP-51 people lists for the filter dropdown
    subscribeUserLists(state.user.pubkey);
    renderFollowingCount();
    updateGoLiveButtonState();
  }

  function subscribeProfiles(pubkeys) {
    // Always include the logged-in user so their profile isn't lost when other fetches fire
    const allKeys = [...pubkeys];
    if (state.user && state.user.pubkey && !allKeys.includes(state.user.pubkey)) {
      allKeys.unshift(state.user.pubkey);
    }
    const unique = [...new Set(allKeys)];
    if (!unique.length) return;
    if (state.profileSubId) state.pool.unsubscribe(state.profileSubId);
    state.profileSubId = state.pool.subscribe(
      [{ kinds: [KIND_PROFILE], authors: unique, limit: unique.length * 2 }],
      {
        event: (ev) => {
          if (ev.kind !== KIND_PROFILE) return;
          const parsed = parseProfile(ev);
          state.profilesByPubkey.set(ev.pubkey, parsed);
          ensureNip05Verification(ev.pubkey, parsed.nip05 || '').catch(() => {});
          if (state.user && state.user.pubkey === ev.pubkey) {
            state.user.profile = state.profilesByPubkey.get(ev.pubkey);
            setUserUi();
          }
          renderLiveGrid();
          const sel = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
          if (sel) renderVideo(sel);
          if (state.selectedProfilePubkey === ev.pubkey) {
            renderProfilePage(ev.pubkey);
            syncProfileRoute(ev.pubkey, 'replace');
          }
        }
      }
    );
  }

  // Fetch a single profile on demand (commenters, repost authors, etc.)
  function fetchProfileIfNeeded(pubkey) {
    if (!pubkey) return Promise.resolve();
    const existing = state.profilesByPubkey.get(pubkey);
    if (existing && (existing.name || existing.display_name || existing.picture)) return Promise.resolve();
    return new Promise((resolve) => {
      const sub = state.pool.subscribe(
        [{ kinds: [KIND_PROFILE], authors: [pubkey], limit: 1 }],
        {
          event: (ev) => {
            if (ev.kind !== KIND_PROFILE || ev.pubkey !== pubkey) return;
            const parsed = parseProfile(ev);
            state.profilesByPubkey.set(pubkey, parsed);
            ensureNip05Verification(pubkey, parsed.nip05 || '').catch(() => {});
          },
          eose: () => { try { state.pool.unsubscribe(sub); } catch (_) {} resolve(); }
        }
      );
    });
  }

  function subscribeLive() {
    if (state.liveSubId) state.pool.unsubscribe(state.liveSubId);

    let liveGridTimer = null;
    const debouncedRenderGrid = () => {
      clearTimeout(liveGridTimer);
      liveGridTimer = setTimeout(renderLiveGrid, 300);
    };

    state.liveSubId = state.pool.subscribe(
      [{ kinds: [KIND_LIVE_EVENT], limit: 200, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7 }],
      {
        event: (ev) => {
          const stream = parseLiveEvent(ev);
          upsertStream(stream);
          if (state.pendingRouteAddress && stream.address === state.pendingRouteAddress) {
            tryOpenPendingRouteStream();
          }
          debouncedRenderGrid();
        },
        eose: () => {
          renderLiveGrid();
          tryOpenPendingRouteStream();
          if (!state.featuredCycleTimer) startHeroCycle();
          const streams = sortedLiveStreams();
          // Fetch profiles for both the event publisher AND actual streamer
          const pubSet = new Set();
          streams.forEach((s) => { pubSet.add(s.pubkey); if (s.hostPubkey) pubSet.add(s.hostPubkey); });
          subscribeProfiles(Array.from(pubSet));
          if (state.selectedProfilePubkey) renderProfilePage(state.selectedProfilePubkey);
        }
      }
    );
  }

  function subscribeChat(stream) {
    if (!stream) return;
    if (state.chatSubId) state.pool.unsubscribe(state.chatSubId);
    if (state.chatReactionSubId) { try { state.pool.unsubscribe(state.chatReactionSubId); } catch (_) {} state.chatReactionSubId = null; }
    if (state._chatProfileSubId) { try { state.pool.unsubscribe(state._chatProfileSubId); } catch (_) {} state._chatProfileSubId = null; }
    const sc = qs('#chatScroll');
    if (sc) sc.innerHTML = '';
    state.chatLikePubkeysByMessageId = new Map();
    state.chatReactionIdByMessageAndPubkey = new Map();
    state.chatReactionEventById = new Map();
    state.chatOwnLikeEventByMessageId = new Map();
    state.chatMessageEventsById = new Map();
    state.chatLikePublishPendingByMessageId = new Set();
    state.streamReactionPubkeysByKey = new Map();
    state.streamReactionMetaByKey = new Map();
    state.streamReactionIdByKeyAndPubkey = new Map();
    state.streamReactionEventById = new Map();
    state.streamOwnReactionIdByKey = new Map();
    state.streamReactionPublishPendingByKey = new Set();
    renderStreamReactionsUi(stream);

    const seenIds = new Set();
    const unknownPubkeys = new Set(); // pubkeys seen in chat but not yet in profile cache

    // Called after EOSE and also for each new real-time message
    function fetchMissingChatProfiles() {
      if (!unknownPubkeys.size) return;
      const toFetch = Array.from(unknownPubkeys).filter((pk) => !state.profilesByPubkey.has(pk));
      unknownPubkeys.clear();
      if (!toFetch.length) return;

      if (state._chatProfileSubId) { try { state.pool.unsubscribe(state._chatProfileSubId); } catch (_) {} }
      state._chatProfileSubId = state.pool.subscribe(
        [{ kinds: [KIND_PROFILE], authors: toFetch, limit: toFetch.length * 2 }],
        {
          event: (profileEv) => {
            if (profileEv.kind !== KIND_PROFILE) return;
            const p = parseProfile(profileEv);
            state.profilesByPubkey.set(profileEv.pubkey, p);
            ensureNip05Verification(profileEv.pubkey, p.nip05 || '').catch(() => {});
            // Update all chat rows for this pubkey
            const chatEl = qs('#chatScroll');
            if (!chatEl) return;
            chatEl.querySelectorAll(`.cmsg[data-pubkey="${CSS.escape(profileEv.pubkey)}"]`).forEach((row) => {
              const avEl = row.querySelector('.c-av');
              const nameEl = row.querySelector('.c-name');
              if (avEl) {
                setAvatarEl(avEl, p.picture || '', pickAvatar(profileEv.pubkey));
                const verified = !!getVerifiedNip05ForPubkey(profileEv.pubkey, p.nip05 || '');
                avEl.classList.toggle('nip05-square', verified);
              }
              if (nameEl) nameEl.textContent = p.name || shortHex(profileEv.pubkey);
            });
          },
          eose: () => { try { state.pool.unsubscribe(state._chatProfileSubId); } catch (_) {} state._chatProfileSubId = null; }
        }
      );
    }

    const filters = [{
      kinds: [KIND_LIVE_CHAT],
      '#a': [stream.address],
      limit: 200,
      since: Math.floor(Date.now() / 1000) - 60 * 60 * 8
    }];

    state.chatSubId = state.pool.subscribe(filters, {
      event: (ev) => {
        if (!ev || !ev.id) return;
        if (seenIds.has(ev.id)) return;
        seenIds.add(ev.id);
        renderChatMessage(ev);
        // Queue profile fetch for unknown sender
        if (!state.profilesByPubkey.has(ev.pubkey)) unknownPubkeys.add(ev.pubkey);
      },
      eose: () => {
        // Batch-fetch all profiles we saw during history replay
        fetchMissingChatProfiles();
      }
    });

    state.chatReactionSubId = state.pool.subscribe(
      [{ kinds: [KIND_REACTION, KIND_DELETION], '#a': [stream.address], limit: 1200, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 }],
      {
        event: (ev) => {
          if (!ev || !ev.id) return;

          if (ev.kind === KIND_REACTION) {
            const targetId = firstTagValue(ev.tags, 'e');
            if (!/^[0-9a-f]{64}$/i.test(targetId || '')) return;
            if (targetId === stream.id) {
              const reactionMeta = parseReactionMeta(ev.content, ev.tags);
              if (!reactionMeta) return;
              applyStreamReaction(reactionMeta, normalizePubkeyHex(ev.pubkey), ev.id);
              renderStreamReactionsUi(stream);
              return;
            }
            const kTag = firstTagValue(ev.tags, 'k');
            if (kTag && kTag !== String(KIND_LIVE_CHAT)) return;
            const reactionContent = (ev.content || '').trim();
            if (!reactionContent || reactionContent === '-') return;
            applyChatLikeReaction(targetId, normalizePubkeyHex(ev.pubkey), ev.id);
            updateChatLikeUi(targetId);
            return;
          }

          if (ev.kind === KIND_DELETION) {
            const deletedIds = allTagValues(ev.tags, 'e').filter((id) => /^[0-9a-f]{64}$/i.test(id));
            deletedIds.forEach((rid) => {
              const streamReactionMeta = state.streamReactionEventById.get(rid);
              if (streamReactionMeta) {
                removeStreamReactionById(rid);
                renderStreamReactionsUi(stream);
              }
              const meta = state.chatReactionEventById.get(rid);
              applyChatUnlikeByReactionId(rid);
              if (meta && meta.messageId) updateChatLikeUi(meta.messageId);
            });
          }
        }
      }
    );
  }

  function openStream(address, opts = {}) {
    const routeMode = opts.routeMode || 'push';
    const stream = state.streamsByAddress.get(address);
    if (!stream) return;
    state.pendingRouteAddress = '';
    state.pendingRouteNaddr = '';
    state.selectedStreamAddress = address;
    if (routeMode !== 'skip') syncTheaterRoute(stream, routeMode);
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
      .filter((s) => (s.pubkey === pubkey || s.hostPubkey === pubkey) && s.status === 'live')
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
    const likePubkeysByPost = new Map();
    const emojiByPost = new Map();

    posts.forEach((post) => {
      statsByPost.set(post.id, { likes: 0, emoji: 0, boosts: 0, zaps: 0 });
      commentsByPost.set(post.id, []);
      likePubkeysByPost.set(post.id, new Set());
      emojiByPost.set(post.id, new Map());
    });

    const deletedIds = new Set();
    map.forEach((ev) => {
      if (!ev || ev.kind !== KIND_DELETION) return;
      allTagValues(ev.tags, 'e').forEach((id) => {
        if (/^[0-9a-f]{64}$/i.test(id)) deletedIds.add(id);
      });
    });

    map.forEach((ev) => {
      if (!ev || !ev.id) return;
      if (deletedIds.has(ev.id)) return;
      const ref = pickReferencedPostId(ev, postIdSet);
      if (!ref) return;

      const stats = statsByPost.get(ref);
      if (!stats) return;

      if (ev.kind === 6) {
        stats.boosts += 1;
        return;
      }

      if (ev.kind === KIND_REACTION) {
        const reaction = parseReactionMeta(ev.content, ev.tags);
        if (!reaction) return;
        if (reaction.key === '+') {
          likePubkeysByPost.get(ref).add(ev.pubkey);
        } else {
          const perPost = emojiByPost.get(ref);
          if (!perPost.has(reaction.key)) {
            perPost.set(reaction.key, {
              key: reaction.key,
              label: reaction.label || reaction.key,
              imageUrl: reaction.imageUrl || '',
              shortcode: reaction.shortcode || '',
              pubkeys: new Set()
            });
          }
          const row = perPost.get(reaction.key);
          row.pubkeys.add(ev.pubkey);
          if (!row.imageUrl && reaction.imageUrl) row.imageUrl = reaction.imageUrl;
        }
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

    posts.forEach((post) => {
      const stats = statsByPost.get(post.id);
      if (!stats) return;
      const likeSet = likePubkeysByPost.get(post.id) || new Set();
      stats.likes = likeSet.size;
      const emojiMap = emojiByPost.get(post.id) || new Map();
      let emojiTotal = 0;
      emojiMap.forEach((entry) => { emojiTotal += entry.pubkeys.size; });
      stats.emoji = emojiTotal;
    });

    return { statsByPost, commentsByPost, likePubkeysByPost, emojiByPost };
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

    const photos = mediaItems.filter((m) => m.kind === 'photo');
    const videos = mediaItems.filter((m) => m.kind === 'video');

    // Single photo: span full width; multiple: 3-col square grid (CSS handles it)
    if (photos.length === 1 && videos.length === 0) container.classList.add('one');

    // Photos â€” square aspect-ratio 1:1 via CSS .profile-feed-photo
    photos.slice(0, 6).forEach((m) => {
      const link = document.createElement('a');
      link.className = 'profile-feed-photo';
      link.href = m.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = m.url;
      img.alt = 'Post image';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        link.classList.add('broken');
        link.innerHTML = '<span>Open image</span>';
      });
      link.appendChild(img);
      container.appendChild(link);
    });

    // Videos â€” 16:9 YouTube-style, spans full grid row via CSS grid-column:1/-1
    videos.slice(0, 2).forEach((m) => {
      const frame = document.createElement('div');
      frame.className = 'profile-feed-video';
      const isHls = /\.m3u8($|\?)/i.test(m.url);
      if (isHls) {
        const v = document.createElement('video');
        v.controls = true; v.playsInline = true; v.preload = 'metadata';
        v.style.cssText = 'width:100%;height:100%;max-height:320px;object-fit:contain;display:block;background:#000;';
        frame.appendChild(v);
        (async () => {
          if (v.canPlayType('application/vnd.apple.mpegurl')) {
            v.src = m.url;
          } else {
            try {
              const Hls = await ensureHlsJs();
              if (Hls.isSupported()) {
                const hls = new Hls({ enableWorker: true });
                hls.loadSource(m.url); hls.attachMedia(v);
                hls.on(Hls.Events.ERROR, (_e, data) => {
                  if (data && data.fatal) {
                    hls.destroy();
                    const a = document.createElement('a');
                    a.href = m.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
                    a.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;min-height:80px;color:var(--zap);font-size:.74rem;font-weight:600;text-decoration:none;padding:.75rem;';
                    a.textContent = '▶ Open HLS stream';
                    if (v.parentNode) v.parentNode.replaceChild(a, v);
                  }
                });
              }
            } catch (_) {}
          }
        })();
      } else {
        const v = document.createElement('video');
        v.controls = true; v.playsInline = true; v.preload = 'metadata';
        v.style.cssText = 'width:100%;height:100%;max-height:320px;object-fit:contain;display:block;background:#000;';
        v.src = m.url;
        v.addEventListener('error', () => {
          const fallback = document.createElement('a');
          fallback.href = m.url; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer';
          fallback.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;min-height:80px;color:var(--zap);font-size:.74rem;font-weight:600;text-decoration:none;padding:.75rem;';
          fallback.textContent = '▶ Open Video';
          if (v.parentNode) v.parentNode.replaceChild(fallback, v);
        });
        frame.appendChild(v);
      }
      container.appendChild(frame);
    });
  }
  function renderProfileFeedInto(listEl, notes, profile, pubkey, aggregates) {
    if (!listEl) return;

    // Infinite scroll: honour per-element limit stored in data attribute
    const limit = parseInt(listEl.dataset.feedLimit || '15', 10);

    if (!notes.length) {
      listEl.innerHTML = '<div class="profile-feed-empty">No notes found yet for this profile.</div>';
      return;
    }

    listEl.innerHTML = '';
    notes.slice(0, limit).forEach((note) => {
      const isRepost = note.kind === 6;
      const item = document.createElement('div');
      item.className = 'profile-feed-item';

      // For reposts, try to parse the original note from content (NIP-18)
      let originalNote = null;
      let originalPubkey = null;
      if (isRepost) {
        try {
          if (note.content && note.content.trim().startsWith('{')) {
            originalNote = JSON.parse(note.content);
            originalPubkey = originalNote.pubkey;
          }
        } catch (_) {}
        if (!originalPubkey) {
          const pTag = (note.tags || []).find(t => t[0] === 'p');
          if (pTag) originalPubkey = pTag[1];
        }
      }

      const originalProfile = (isRepost && originalPubkey) ? profileFor(originalPubkey) : null;
      const boostBanner = isRepost
        ? `<div class="pf-boost-banner"><span class="pf-boost-icon">🔁</span><span class="pf-boost-label">${profile.display_name || profile.name || 'User'} boosted</span></div>`
        : '';

      item.innerHTML = `${boostBanner}
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
          <span class="pfs pfs-comments"><strong>0</strong> Comments</span>
          <button class="pfs pfs-btn profile-post-like-btn" type="button"><strong>0</strong> Likes</button>
          <span class="pfs pfs-zaps"><strong>0</strong> Zaps</span>
          <span class="pfs pfs-boosts"><strong>0</strong> Boosts</span>
          <button class="pfs pfs-btn pfs-plus profile-post-emoji-btn" type="button" title="React with custom emoji">+</button>
        </div>
        <div class="profile-feed-emoji-bar"></div>
        <div class="profile-feed-comments"></div>
        <div class="profile-comment-form">
          <textarea class="profile-comment-input" rows="1" placeholder="Write a comment..."></textarea>
          <button class="profile-comment-btn">Comment</button>
        </div>`;

      // For reposts show original author; for regular posts show profile author
      const displayProfile = (isRepost && originalProfile) ? originalProfile : profile;
      const displayNote = (isRepost && originalNote) ? originalNote : note;
      const displayPubkey = (isRepost && originalPubkey) ? originalPubkey : note.pubkey;

      const avEl = qs('.profile-feed-av', item);
      setAvatarEl(avEl, displayProfile.picture || '', pickAvatar(displayPubkey));
      const displayVerifiedNip05 = getVerifiedNip05ForPubkey(displayPubkey, displayProfile.nip05 || '');
      if (avEl && displayVerifiedNip05) avEl.classList.add('nip05-square');
      else if (normalizeNip05Value(displayProfile.nip05 || '')) ensureNip05Verification(displayPubkey, displayProfile.nip05 || '').catch(() => {});
      if (avEl) { avEl.style.cursor = 'pointer'; avEl.onclick = (e) => { e.stopPropagation(); showProfileByPubkey(displayPubkey); }; }
      const nameEl = qs('.profile-feed-name', item);
      if (nameEl) {
        nameEl.textContent = displayProfile.name || shortHex(displayPubkey);
        nameEl.style.cursor = 'pointer';
        nameEl.onclick = (e) => { e.stopPropagation(); showProfileByPubkey(displayPubkey); };
      }
      const timeEl = qs('.profile-feed-time', item);
      if (timeEl) timeEl.textContent = `${formatTimeAgo(note.created_at)} ago`;

      // Fetch and display profile if not cached yet
      if (!state.profilesByPubkey.has(displayPubkey)) {
        fetchProfileIfNeeded(displayPubkey).then(() => {
          const fresh = profileFor(displayPubkey);
          if (nameEl) { nameEl.textContent = fresh.name || shortHex(displayPubkey); nameEl.style.cursor = 'pointer'; }
          if (avEl) {
            setAvatarEl(avEl, fresh.picture || '', pickAvatar(displayPubkey));
            avEl.classList.toggle('nip05-square', !!getVerifiedNip05ForPubkey(displayPubkey, fresh.nip05 || ''));
          }
        }).catch(() => {});
      }

      const mediaUrls = extractMediaUrlsFromEvent(displayNote);
      const mediaItems = mediaUrls
        .map((url) => ({ url, kind: classifyMediaUrl(url) }))
        .filter((m) => m.kind && isLikelyUrl(m.url));
      const text = stripMediaUrlsFromText(displayNote.content || '', mediaUrls);
      const textEl = qs('.profile-feed-text', item);
      if (textEl) {
        textEl.innerHTML = '';
        if (text) {
          textEl.appendChild(renderNostrContent(text));
          textEl.style.display = 'block';
        } else {
          textEl.textContent = mediaItems.length ? '' : (isRepost ? '[Reposted content]' : '[empty note]');
          textEl.style.display = !mediaItems.length ? 'block' : 'none';
        }
      }

      const mediaWrap = qs('.profile-feed-media-wrap', item);
      if (mediaWrap) {
        if (mediaItems.length) renderPostMedia(mediaWrap, mediaItems);
        else mediaWrap.style.display = 'none';
      }

      const stats = (aggregates && aggregates.statsByPost.get(note.id)) || { likes: 0, emoji: 0, boosts: 0, zaps: 0 };
      const comments = (aggregates && aggregates.commentsByPost.get(note.id)) || [];
      const likeSet = (aggregates && aggregates.likePubkeysByPost && aggregates.likePubkeysByPost.get(note.id)) || new Set();
      const emojiMap = (aggregates && aggregates.emojiByPost && aggregates.emojiByPost.get(note.id)) || new Map();
      const commentsCount = qs('.pfs-comments strong', item);
      const likesCount = qs('.profile-post-like-btn strong', item);
      const zapsCount = qs('.pfs-zaps strong', item);
      const boostsCount = qs('.pfs-boosts strong', item);
      if (commentsCount) commentsCount.textContent = `${comments.length}`;
      if (likesCount) likesCount.textContent = `${stats.likes}`;
      if (zapsCount) zapsCount.textContent = `${stats.zaps}`;
      if (boostsCount) boostsCount.textContent = `${stats.boosts}`;

      const own = state.user ? normalizePubkeyHex(state.user.pubkey) : '';
      const likeBtn = qs('.profile-post-like-btn', item);
      if (likeBtn) {
        likeBtn.classList.toggle('active', !!(own && likeSet.has(own)));
        likeBtn.addEventListener('click', () => window.toggleProfilePostLike(note.id, note.pubkey, pubkey));
      }

      const emojiPlusBtn = qs('.profile-post-emoji-btn', item);
      if (emojiPlusBtn) {
        emojiPlusBtn.addEventListener('click', () => window.openReactionPickerForPost(note.id, note.pubkey, pubkey));
      }

      const emojiBar = qs('.profile-feed-emoji-bar', item);
      if (emojiBar) {
        emojiBar.innerHTML = '';
        const entries = Array.from(emojiMap.values())
          .filter((entry) => entry && entry.pubkeys && entry.pubkeys.size)
          .sort((a, b) => {
            if (b.pubkeys.size !== a.pubkeys.size) return b.pubkeys.size - a.pubkeys.size;
            return String(a.key || '').localeCompare(String(b.key || ''));
          });

        if (!entries.length) {
          emojiBar.style.display = 'none';
        } else {
          emojiBar.style.display = 'flex';
          entries.forEach((entry) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'stream-emoji-chip' + (own && entry.pubkeys.has(own) ? ' active' : '');
            chip.title = `${entry.label || entry.key} (${entry.pubkeys.size})`;
            chip.addEventListener('click', () => {
              window.toggleProfilePostEmoji(note.id, note.pubkey, pubkey, entry.key, entry.imageUrl || '', entry.shortcode || '');
            });

            const countEl = document.createElement('span');
            countEl.className = 'stream-emoji-count';
            countEl.textContent = `${entry.pubkeys.size}`;
            chip.appendChild(countEl);

            if (entry.imageUrl) {
              const img = document.createElement('img');
              img.src = entry.imageUrl;
              img.alt = entry.label || entry.key;
              img.loading = 'lazy';
              chip.appendChild(img);
            } else {
              const txt = document.createElement('span');
              txt.textContent = String(entry.label || entry.key).slice(0, 18);
              chip.appendChild(txt);
            }
            emojiBar.appendChild(chip);
          });
        }
      }

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
          const cAvEl = qs('.profile-comment-av', row);
          setAvatarEl(cAvEl, cp.picture || '', pickAvatar(comment.pubkey));
          const commentVerifiedNip05 = getVerifiedNip05ForPubkey(comment.pubkey, cp.nip05 || '');
          if (cAvEl && commentVerifiedNip05) cAvEl.classList.add('nip05-square');
          else if (normalizeNip05Value(cp.nip05 || '')) ensureNip05Verification(comment.pubkey, cp.nip05 || '').catch(() => {});
          if (cAvEl) { cAvEl.style.cursor = 'pointer'; cAvEl.onclick = (e) => { e.stopPropagation(); showProfileByPubkey(comment.pubkey); }; }
          const n = qs('.profile-comment-meta .n', row);
          if (n) {
            n.textContent = cp.display_name || cp.name || shortHex(comment.pubkey);
            n.style.cursor = 'pointer';
            n.onclick = (e) => { e.stopPropagation(); showProfileByPubkey(comment.pubkey); };
          }
          const t = qs('.profile-comment-meta .t', row);
          if (t) t.textContent = `${formatTimeAgo(comment.created_at)} ago`;
          const ct = qs('.profile-comment-text', row);
          if (ct) {
            const commentText = (comment.content || '').trim();
            ct.innerHTML = '';
            if (commentText) { ct.appendChild(renderNostrContent(commentText)); }
            else { ct.textContent = '[empty comment]'; }
          }

          // If profile not cached yet, fetch and update row
          if (!state.profilesByPubkey.has(comment.pubkey)) {
            fetchProfileIfNeeded(comment.pubkey).then(() => {
              const fresh = profileFor(comment.pubkey);
              if (n) n.textContent = fresh.display_name || fresh.name || shortHex(comment.pubkey);
              if (cAvEl) {
                setAvatarEl(cAvEl, fresh.picture || '', pickAvatar(comment.pubkey));
                cAvEl.classList.toggle('nip05-square', !!getVerifiedNip05ForPubkey(comment.pubkey, fresh.nip05 || ''));
              }
            }).catch(() => {});
          }

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
          if (!state.user) { window.openLogin(); return; }
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

    // Infinite scroll sentinel â€” appear if more posts exist beyond current limit
    if (notes.length > limit) {
      const sentinel = document.createElement('div');
      sentinel.className = 'feed-sentinel';
      sentinel.innerHTML = '<span class="feed-sentinel-label">Loading more postsâ€¦</span>';
      listEl.appendChild(sentinel);

      const obs = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        const newLimit = limit + 15;
        listEl.dataset.feedLimit = String(newLimit);
        // Re-render with higher limit using current data
        const map = state.profileNotesByPubkey.get(pubkey) || new Map();
        const freshNotes = Array.from(map.values())
          .filter((ev) => {
            if (!ev || ev.pubkey !== pubkey) return false;
            if (ev.kind === 6) return true;
            return isTopLevelProfilePost(ev, pubkey);
          })
          .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        const freshAgg = buildProfilePostAggregates(pubkey, freshNotes);
        renderProfileFeedInto(listEl, freshNotes, profileFor(pubkey), pubkey, freshAgg);
      }, { rootMargin: '180px' });
      obs.observe(sentinel);
    }
  }
  function renderProfileFeed(pubkey) {
    const leftList = qs('#profileFeedList');
    const tabList = qs('#profileFeedListSide');
    const count = qs('#profileFeedCount');

    const map = state.profileNotesByPubkey.get(pubkey) || new Map();
    // Include top-level kind:1 posts AND kind:6 reposts authored by this pubkey (NIP-18)
    const notes = Array.from(map.values())
      .filter((ev) => {
        if (!ev || ev.pubkey !== pubkey) return false;
        if (ev.kind === 6) return true;
        return isTopLevelProfilePost(ev, pubkey);
      })
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    if (count) count.textContent = `${notes.length} notes`;

    const aggregates = buildProfilePostAggregates(pubkey, notes);
    const profile = profileFor(pubkey);
    renderProfileFeedInto(leftList, notes, profile, pubkey, aggregates);
    renderProfileFeedInto(tabList, notes, profile, pubkey, aggregates);
  }

  function extractHttpUrls(text) {
    const raw = (text || '').match(/https?:\/\/\S+/gi) || [];
    return raw.map((url) =>
      String(url || '')
        .replace(/[)\],.;!?'"`>]+$/g, '')
        .replace(/^[("'`<]+/g, '')
    );
  }

  function classifyMediaUrl(url) {
    const base = (url || '').split('#')[0].split('?')[0].toLowerCase();
    if (/\.(mp4|webm|mov|m4v|mkv|m3u8)$/.test(base)) return 'video';
    if (/\.(jpg|jpeg|png|gif|webp|avif)$/.test(base)) return 'photo';
    return '';
  }

  function extractMediaUrlsFromEvent(ev) {
    const urls = extractHttpUrls(ev && ev.content ? ev.content : '').map((u) => sanitizeMediaUrl(u)).filter(Boolean);
    const tags = (ev && Array.isArray(ev.tags)) ? ev.tags : [];
    tags.forEach((tag) => {
      if (!Array.isArray(tag) || tag.length < 2) return;
      const key = String(tag[0] || '').toLowerCase();
      const value = sanitizeMediaUrl(tag[1] || '');
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
        if (kind === 'video' && !seenVideo.has(url) && videos.length < 200) {
          videos.push({ url, note, caption });
          seenVideo.add(url);
        }
        if (kind === 'photo' && !seenPhoto.has(url) && photos.length < 500) {
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
      .filter((stream) => (stream.pubkey === pubkey || stream.hostPubkey === pubkey) && stream.status !== 'live')
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

    const limit = parseInt(wrap.dataset.mediaLimit || '9', 10);

    wrap.innerHTML = '';
    media.videos.slice(0, limit).forEach((item) => {
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
        video.controls = true;
        video.autoplay = false;
        video.loop = false;
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        // Use <source> for better cross-origin/MIME support
        const src = document.createElement('source');
        src.src = item.url;
        const ext = item.url.split('?')[0].toLowerCase().split('.').pop();
        const mimes = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/mp4', m4v: 'video/mp4' };
        if (mimes[ext]) src.type = mimes[ext];
        video.appendChild(src);
        // Fallback link on error
        video.addEventListener('error', () => {
          const fb = document.createElement('div');
          fb.className = 'profile-video-fallback';
      fb.innerHTML = `<a href="${item.url}" target="_blank" rel="noopener noreferrer" style="color:var(--zap)">▶ Open Video</a>`;
          frame.replaceChild(fb, video);
        });
        frame.appendChild(video);
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

    // Infinite scroll sentinel for videos
    if (media.videos.length > limit) {
      const sentinel = document.createElement('div');
      sentinel.className = 'feed-sentinel media-sentinel';
      sentinel.style.gridColumn = '1/-1';
      sentinel.innerHTML = '<span class="feed-sentinel-label">Loading more videosâ€¦</span>';
      wrap.appendChild(sentinel);

      const obs = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        wrap.dataset.mediaLimit = String(limit + 9);
        renderProfileVideos(media);
      }, { rootMargin: '180px' });
      obs.observe(sentinel);
    }
  }

  function renderProfilePhotos(media) {
    const wrap = qs('#profilePhotosList');
    if (!wrap) return;

    if (!media.photos.length) {
      wrap.innerHTML = '<div class="profile-feed-empty">No photo posts detected in recent notes.</div>';
      return;
    }

    const limit = parseInt(wrap.dataset.mediaLimit || '18', 10);

    wrap.innerHTML = '';
    media.photos.slice(0, limit).forEach((item) => {
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

    // Infinite scroll sentinel for photos
    if (media.photos.length > limit) {
      const sentinel = document.createElement('div');
      sentinel.className = 'feed-sentinel media-sentinel';
      sentinel.style.gridColumn = '1/-1';
      sentinel.innerHTML = '<span class="feed-sentinel-label">Loading more photosâ€¦</span>';
      wrap.appendChild(sentinel);

      const obs = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        wrap.dataset.mediaLimit = String(limit + 18);
        renderProfilePhotos(media);
      }, { rootMargin: '180px' });
      obs.observe(sentinel);
    }
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
      media: 'Media'
    };
    const postsBtn = qs('#profileTabBtnPosts');
    const postsAllowed = !!(postsBtn && postsBtn.style.display !== 'none');
    let tab = tabName;
    if (tab === 'videos' || tab === 'photos') tab = 'media';
    if (!Object.prototype.hasOwnProperty.call(tabMap, tab)) tab = 'streams';
    if (tab === 'posts' && !postsAllowed) tab = 'streams';
    state.profileTab = tab;
    Object.keys(tabMap).forEach((key) => {
      const btn = qs(`#profileTabBtn${tabMap[key]}`);
      if (btn) btn.classList.toggle('active', key === tab);
      const pane = qs(`#profileTab${tabMap[key]}`);
      if (pane) pane.classList.toggle('on', key === tab);
    });
  }

  /* =====================================================================
     NOSTR BADGES (NIP-58)
     kind:8  = Badge Award (issued to a pubkey)
     kind:30009 = Badge Definition (created by issuer)
     ===================================================================== */

  // badgesByPubkey: Map<pubkey, Map<badgeId, { award, definition }>>
  if (!state.badgesByPubkey) state.badgesByPubkey = new Map();
  if (!state.badgeSubId) state.badgeSubId = null;
  if (!state.badgeDefMap) state.badgeDefMap = new Map(); // Map<"pubkey:d", definition event>

  function parseBadgeAddressRef(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const parts = raw.split(':');
    if (parts.length < 3) return null;
    const kind = parts.shift();
    const pubkey = parts.shift();
    const d = parts.join(':');
    if (kind !== '30009' || !pubkey || !d) return null;
    return { pubkey, d, key: `${pubkey}:${d}` };
  }

  function badgeInfoFromEvents(award, definition) {
    const image = sanitizeMediaUrl(getBadgeDefTag(definition, 'image') || getBadgeDefTag(definition, 'thumb'));
    const awardATag = ((award && award.tags) || []).find((t) => Array.isArray(t) && t[0] === 'a' && t[1]);
    const ref = parseBadgeAddressRef(awardATag ? awardATag[1] : '');
    const badgeId = (getBadgeDefTag(definition, 'd') || (ref && ref.d) || '').trim();
    const displayName = (getBadgeDefTag(definition, 'name') || badgeId || '').trim();
    const fallbackName = displayName || (ref ? `Award ${shortHex(ref.pubkey)}` : 'Unknown award');
    const desc = getBadgeDefTag(definition, 'description') || '';
    const issuer = (getBadgeDefTag(definition, 'issuer') || (definition && definition.pubkey) || (ref && ref.pubkey) || '').trim();

    return {
      image,
      name: fallbackName,
      desc,
      id: badgeId,
      issuer
    };
  }

  function subscribeBadges(pubkey) {
    if (!pubkey) return;
    if (state.badgeSubId) { state.pool.unsubscribe(state.badgeSubId); state.badgeSubId = null; }

    if (!state.badgesByPubkey.has(pubkey)) state.badgesByPubkey.set(pubkey, new Map());

    // Fetch kind:8 badge awards where this pubkey is tagged
    state.badgeSubId = state.pool.subscribe(
      [{ kinds: [8], '#p': [pubkey], limit: 100 }],
      {
        event: (ev) => {
          if (ev.kind !== 8) return;
          // Each award references a badge definition via 'a' tag: "30009:creatorPubkey:d-tag"
          const aTags = (ev.tags || []).filter((t) => t[0] === 'a' && t[1]);
          aTags.forEach((aTag) => {
            const ref = parseBadgeAddressRef(aTag[1]);
            if (!ref) return;
            const awardMap = state.badgesByPubkey.get(pubkey);
            const existing = awardMap.get(ref.key);
            if (!existing || Number(existing.award && existing.award.created_at || 0) <= Number(ev.created_at || 0)) {
              awardMap.set(ref.key, { award: ev, definition: state.badgeDefMap.get(ref.key) || (existing && existing.definition) || null });
            }
            // Fetch definition if not cached
            if (!state.badgeDefMap.has(ref.key)) {
              fetchBadgeDefinition(ref.pubkey, ref.d);
            }
          });
          renderProfileBadges(pubkey);
        },
        eose: () => { renderProfileBadges(pubkey); }
      }
    );
  }

  function fetchBadgeDefinition(creatorPubkey, d) {
    const defKey = `${creatorPubkey}:${d}`;
    if (state.badgeDefMap.has(defKey)) return;
    const subId = state.pool.subscribe(
      [{ kinds: [30009], authors: [creatorPubkey], '#d': [d], limit: 1 }],
      {
        event: (ev) => {
          if (ev.kind !== 30009) return;
          state.badgeDefMap.set(defKey, ev);
          // Update any awaiting badge entries
          state.badgesByPubkey.forEach((awardMap, pubkey) => {
            if (awardMap.has(defKey)) {
              awardMap.get(defKey).definition = ev;
              if (state.selectedProfilePubkey === pubkey) renderProfileBadges(pubkey);
            }
          });
          state.pool.unsubscribe(subId);
        },
        eose: () => { state.pool.unsubscribe(subId); }
      }
    );
  }

  function getBadgeDefTag(ev, tagName) {
    if (!ev || !Array.isArray(ev.tags)) return '';
    const t = ev.tags.find((t) => t[0] === tagName);
    return t ? (t[1] || '') : '';
  }

  function renderProfileBadges(pubkey) {
    const panel = qs('#profileBadgesPanel');
    const grid = qs('#profileBadgesGrid');
    const bioGrid = qs('#profileBioGrid');
    if (!panel || !grid || !bioGrid) return;

    const awardMap = state.badgesByPubkey.get(pubkey);
    const badges = awardMap ? Array.from(awardMap.values()) : [];

    if (!badges.length) {
      panel.style.display = 'none';
      bioGrid.classList.remove('has-badges');
      return;
    }

    panel.style.display = 'block';
    bioGrid.classList.add('has-badges');
    grid.innerHTML = '';

    const MAX_SHOWN = 9; // 3x3 grid

    function makeBadgeChip(award, definition) {
      const chip = document.createElement('div');
      chip.className = 'profile-badge-chip';
      const info = badgeInfoFromEvents(award, definition);
      if (info.image && isLikelyUrl(info.image)) {
        const img = document.createElement('img');
        img.src = info.image; img.alt = info.name; img.loading = 'lazy';
        img.onerror = () => { chip.innerHTML = ''; };
        chip.appendChild(img);
      } else { chip.textContent = ''; }
      chip.title = info.name;
      chip.addEventListener('click', () => { openBadgePopup({ ...info, definition, award }); });
      return chip;
    }

    badges.slice(0, MAX_SHOWN).forEach(({ award, definition }) => {
      grid.appendChild(makeBadgeChip(award, definition));
    });

    if (badges.length > MAX_SHOWN) {
      const more = document.createElement('div');
      more.className = 'badge-see-more';
      more.textContent = `+${badges.length - MAX_SHOWN}`;
      more.title = 'See all badges';
      more.addEventListener('click', () => openAllBadgesPopup(badges));
      grid.appendChild(more);
    }
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
          // Refresh theater stat if this is the open stream's host
          const openStream = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
          if (openStream && openStream.pubkey === pubkey) {
            const el = qs('#theaterFollowers');
            if (el) el.textContent = formatCount(followerSet.size);
          }
        },
        eose: () => {
          state.profileStatsByPubkey.set(pubkey, {
            followers: followerSet.size,
            following: followingSet.size
          });
          if (state.selectedProfilePubkey === pubkey) renderProfilePage(pubkey);
          const openStream = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
          if (openStream && openStream.pubkey === pubkey) {
            const el = qs('#theaterFollowers');
            if (el) el.textContent = formatCount(followerSet.size);
          }
        }
      }
    );
  }

  function renderProfileFollowButton(pubkey) {
    const isOwn = !!(pubkey && state.user && state.user.pubkey === pubkey);
    const messageBtn = qs('#profileMessageBtn');
    const zapBtn = qs('#profileZapBtn');
    const editBtn = qs('#profileEditBtn');
    const btn = qs('#profileFollowBtn');

    if (messageBtn) messageBtn.style.display = isOwn ? 'none' : '';
    if (zapBtn) zapBtn.style.display = isOwn ? 'none' : '';
    if (btn) btn.style.display = isOwn ? 'none' : '';
    if (editBtn) editBtn.style.display = isOwn ? 'inline-flex' : 'none';
    if (!btn) return;

    btn.disabled = false;
    btn.classList.remove('following-active');

    if (!pubkey) {
      btn.textContent = 'Follow';
      return;
    }

    if (isOwn) return;

    const following = isFollowingPubkey(pubkey);
    btn.textContent = following ? 'Following' : 'Follow';
    btn.classList.toggle('following-active', following);
  }

  function updateOwnFollowingStat(delta) {
    if (!state.user) return;
    const ownPubkey = normalizePubkeyHex(state.user.pubkey);
    if (!ownPubkey) return;

    const current = state.profileStatsByPubkey.get(ownPubkey) || { followers: 0, following: 0 };
    const nextFollowing = Math.max(0, Number(current.following || 0) + Number(delta || 0));
    state.profileStatsByPubkey.set(ownPubkey, {
      followers: Number(current.followers || 0),
      following: nextFollowing
    });

    if (normalizePubkeyHex(state.selectedProfilePubkey) === ownPubkey) {
      const followingEl = qs('#profFollowing');
      if (followingEl) followingEl.textContent = formatCount(nextFollowing);
    }
  }

  function subscribeProfileFeed(pubkey) {
    if (!pubkey) return;
    if (state.profileFeedSubId) state.pool.unsubscribe(state.profileFeedSubId);

    const leftList = qs('#profileFeedList');
    const sideList = qs('#profileFeedListSide');
    if (leftList) { leftList.innerHTML = '<div class="profile-feed-empty">Loading notes from relays...</div>'; leftList.dataset.feedLimit = '15'; }
    if (sideList) { sideList.innerHTML = '<div class="profile-feed-empty">Loading notes from relays...</div>'; sideList.dataset.feedLimit = '15'; }

    // Reset media limits
    const videosEl = qs('#profileVideosList');
    const photosEl = qs('#profilePhotosList');
    if (videosEl) videosEl.dataset.mediaLimit = '9';
    if (photosEl) photosEl.dataset.mediaLimit = '18';

    const existing = state.profileNotesByPubkey.get(pubkey);
    if (!existing) state.profileNotesByPubkey.set(pubkey, new Map());

    state.profileFeedSubId = state.pool.subscribe(
      [
        { kinds: [1, 6, KIND_REACTION, KIND_DELETION, 20, 21, 22, 1063, KIND_ZAP_RECEIPT], authors: [pubkey], limit: 320, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 180 },
        { kinds: [1, 6, KIND_REACTION, KIND_DELETION, KIND_ZAP_RECEIPT], '#p': [pubkey], limit: 620, since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 180 }
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
    const claimedNip05 = normalizeNip05Value(p.nip05 || '');
    const verifiedNip05 = getVerifiedNip05ForPubkey(pubkey, claimedNip05);
    if (claimedNip05 && !verifiedNip05) ensureNip05Verification(pubkey, claimedNip05).catch(() => {});

    if (npubEl) npubEl.textContent = formatNpubForDisplay(pubkey);

    if (verifiedNip05) {
      if (nip05Main) { nip05Main.style.display = 'flex'; nip05Main.textContent = `NIP-05: ${verifiedNip05}`; }
      if (nip05Check) {
        nip05Check.style.display = 'inline';
        nip05Check.textContent = '\u2713';
        nip05Check.title = 'NIP-05 verified';
      }
    } else if (claimedNip05) {
      if (nip05Main) { nip05Main.style.display = 'flex'; nip05Main.textContent = `Claimed NIP-05: ${claimedNip05}`; }
      if (nip05Check) {
        nip05Check.style.display = 'inline';
        nip05Check.textContent = '\u2715';
        nip05Check.title = 'NIP-05 not verified';
      }
    } else {
      if (nip05Main) nip05Main.style.display = 'none';
      if (nip05Check) nip05Check.style.display = 'none';
    }
    if (npubEl) npubEl.style.display = 'block';
    setProfileVerificationStyle(verifiedNip05 ? 'verified' : (claimedNip05 ? 'invalid' : 'none'));

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

    const userStreams = Array.from(state.streamsByAddress.values()).filter((s) => s.pubkey === pubkey || s.hostPubkey === pubkey);
    const sinceEl = qs('#profNostrSince');
    const firstSeenTs = estimateProfileFirstSeen(pubkey, p);
    if (sinceEl) sinceEl.textContent = ''; // hidden via CSS; kept for Time on Nostr stat tile

    const followers = qs('#profFollowers');
    const following = qs('#profFollowing');
    const streams = qs('#profStreams');
    const sats = qs('#profSats');
    const postCountEl = qs('#profPostCount');
    const nostrAgeStatEl = qs('#profNostrAgeStat');
    const stats = state.profileStatsByPubkey.get(pubkey) || { followers: 0, following: 0 };

    if (followers) followers.textContent = formatCount(stats.followers || 0);
    if (following) following.textContent = formatCount(stats.following || 0);
    const noteMap = state.profileNotesByPubkey.get(pubkey) || new Map();
    const noteCount = Array.from(noteMap.values()).filter((ev) => ev.pubkey === pubkey && ev.kind === 1).length;
    if (postCountEl) postCountEl.textContent = formatCount(noteCount);
    if (streams) streams.textContent = `${userStreams.length}`;
    if (nostrAgeStatEl) nostrAgeStatEl.textContent = firstSeenTs ? formatNostrAge(firstSeenTs) : '-';
    if (sats) sats.textContent = formatCount(userStreams.length * 2100);

    // Show compose box only on own profile
    const composeBox = qs('#profileComposeBox');
    const composeAv = qs('#profileComposeAv');
    const isOwnProfile = !!(state.user && state.user.pubkey === pubkey);
    if (composeBox) composeBox.classList.toggle('hidden', !isOwnProfile);
    if (isOwnProfile && composeAv) {
      setAvatarEl(composeAv, p.picture || '', pickAvatar(pubkey));
    }

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
    renderProfileBadges(pubkey);
    setProfileTab(state.profileTab || 'streams');
  }

  function openStreamFromProfile() {
    if (!state.selectedProfileLiveAddress) return;
    openStream(state.selectedProfileLiveAddress);
  }

  function showProfileByPubkey(pubkey, opts = {}) {
    const routeMode = opts.routeMode || 'push';
    if (!pubkey) return;
    state.selectedProfilePubkey = pubkey;
    const p = profileFor(pubkey);
    const verifiedNip05 = getVerifiedNip05ForPubkey(pubkey, p.nip05 || '');
    if (!verifiedNip05 && normalizeNip05Value(p.nip05 || '')) ensureNip05Verification(pubkey, p.nip05 || '').catch(() => {});
    window.showProfile(p.name, pickAvatar(pubkey), formatNpubForDisplay(pubkey), verifiedNip05, pubkey, { routeMode });
    renderProfilePage(pubkey);
    subscribeProfileFeed(pubkey);
    subscribeProfileStats(pubkey);
    subscribeBadges(pubkey);
  }

  async function toggleFollowSelectedProfile() {
    const pubkey = normalizePubkeyHex(state.selectedProfilePubkey);
    if (!pubkey) return;
    if (!state.user) { window.openLogin(); return; }
    if (normalizePubkeyHex(state.user.pubkey) === pubkey) return;
    if (state.followPublishPending) return;
    state.followPublishPending = true;

    try {
      const wasFollowing = isFollowingPubkey(pubkey);
      const next = !wasFollowing;
      const current = state.profileStatsByPubkey.get(pubkey) || { followers: 0, following: 0 };
      const prevFollowers = Number(current.followers || 0);
      const nextFollowers = Math.max(0, prevFollowers + (next ? 1 : -1));

      state.profileStatsByPubkey.set(pubkey, {
        followers: nextFollowers,
        following: Number(current.following || 0)
      });

      setFollowingPubkey(pubkey, next);
      state.contactListPubkeys = new Set(state.followedPubkeys);
      updateOwnFollowingStat(next ? 1 : -1);
      renderProfileFollowButton(pubkey);
      updateTheaterFollowBtn(pubkey);
      renderLiveGrid();
      const followers = qs('#profFollowers');
      if (followers) followers.textContent = formatCount(nextFollowers);

      try {
        await publishFollowedPubkeysToNostr();
        state.contactListPubkeys = new Set(state.followedPubkeys);
        renderFollowingCount();
        renderLiveGrid();
      } catch (err) {
        setFollowingPubkey(pubkey, wasFollowing);
        state.contactListPubkeys = new Set(state.followedPubkeys);
        updateOwnFollowingStat(next ? -1 : 1);
        state.profileStatsByPubkey.set(pubkey, {
          followers: prevFollowers,
          following: Number(current.following || 0)
        });
        renderProfileFollowButton(pubkey);
        updateTheaterFollowBtn(pubkey);
        renderLiveGrid();
        if (followers) followers.textContent = formatCount(prevFollowers);
        alert(err.message || 'Failed to update follow list.');
      }
    } finally {
      state.followPublishPending = false;
    }
  }

  function setAuthenticatedUser(pubkey, authMode) {
    state.authMode = authMode;
    state.followPublishPending = false;
    state.streamLikePublishPending = false;
    state.goLiveSelectedAddress = '';
    state.goLiveHiddenEndedAddresses = loadHiddenEndedStreamsForPubkey(pubkey);
    state.boostedStreamAddresses = new Set();
    state.streamBoostEventIdByAddress = new Map();
    state.streamBoostCheckedByAddress = new Set();
    state.streamBoostCheckPendingByAddress = new Set();
    state.streamReactionPublishPendingByKey = new Set();
    state.postReactionPublishPendingByNoteAndKey = new Set();
    state.user = { pubkey, profile: state.profilesByPubkey.get(pubkey) || null };
    ensureNip05Verification(pubkey, state.user.profile && state.user.profile.nip05 || '').catch(() => {});
    setUserUi();
    renderStreamReactionsUi();
    const selected = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
    if (selected) {
      updateTheaterShareBtn(selected);
      refreshOwnStreamBoostState(selected);
    }
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
      display_name: profileData.display_name || profileData.name || shortHex(state.user.pubkey),
      about: profileData.about || '',
      picture: profileData.picture || '',
      banner: profileData.banner || '',
      website: profileData.website || '',
      lud16: profileData.lud16 || '',
      nip05: profileData.nip05 || ''
    };

    await signAndPublish(KIND_PROFILE, JSON.stringify(payload), []);

    const merged = {
      ...profileFor(state.user.pubkey),
      pubkey: state.user.pubkey,
      name: payload.name,
      display_name: payload.display_name,
      about: payload.about,
      picture: payload.picture,
      banner: payload.banner,
      website: payload.website,
      lud16: payload.lud16,
      nip05: payload.nip05
    };

    state.profilesByPubkey.set(state.user.pubkey, merged);
    state.user.profile = merged;
    setUserUi();

    if (state.selectedProfilePubkey === state.user.pubkey) {
      renderProfilePage(state.user.pubkey);
      syncProfileRoute(state.user.pubkey, 'replace');
    }
  }

  function openOnboarding(prefill = {}) {
    const modal = qs('#onboardingModal');
    if (!modal) return;

    // Populate nsec
    const nsecEl = qs('#onbNsecValue');
    if (nsecEl) {
      nsecEl.textContent = state.pendingOnboardingNsec || 'nsec1...';
      nsecEl.classList.remove('revealed');
    }

    // Reset reveal/copy buttons
    const revealBtn = qs('#onbRevealBtn');
    if (revealBtn) revealBtn.textContent = '👁 Reveal';
    const copyBtn = qs('#onbCopyBtn');
    if (copyBtn) { copyBtn.textContent = '📋 Copy'; copyBtn.classList.remove('copied'); }

    // Reset checkbox + continue button
    const check = qs('#onbSavedCheck');
    if (check) check.checked = false;
    const cont = qs('#onbContinueBtn');
    if (cont) cont.classList.remove('ready');

    // Pre-fill profile fields
    const set = (id, val) => { const el = qs(id); if (el) el.value = val || ''; };
    set('#onbDisplayName', prefill.name);
    set('#onbAvatar', prefill.picture);
    set('#onbBanner', prefill.banner || state.settings.banner);
    set('#onbBio', prefill.about);
    set('#onbWebsite', prefill.website || state.settings.website);
    set('#onbLud16', prefill.lud16 || state.settings.lud16);
    set('#onbNip05', prefill.nip05);

    // Reset to step 1
    onbSetStep(1);

    // Update avatar preview
    onbUpdatePreview();

    modal.classList.add('open');
    // Also close login modal if open
    const loginModal = qs('#loginModal');
    if (loginModal) loginModal.classList.remove('open');
  }

  function onbSetStep(n) {
    const s1 = qs('#onbStep1'), s2 = qs('#onbStep2');
    const d1 = qs('#onbDot1'), d2 = qs('#onbDot2');
    const line = qs('#onbStepLine');
    if (n === 1) {
      if (s1) s1.classList.add('active');
      if (s2) s2.classList.remove('active');
      if (d1) { d1.classList.add('active'); d1.classList.remove('done'); }
      if (d2) { d2.classList.remove('active', 'done'); }
      if (line) line.classList.remove('done');
    } else {
      if (s1) s1.classList.remove('active');
      if (s2) s2.classList.add('active');
      if (d1) { d1.classList.remove('active'); d1.classList.add('done'); }
      if (d2) { d2.classList.add('active'); d2.classList.remove('done'); }
      if (line) line.classList.add('done');
    }
  }

  function closeOnboarding() {
    const modal = qs('#onboardingModal');
    if (modal) modal.classList.remove('open');
  }

  // Called from HTML: reveal the blurred nsec
  function onbRevealNsec() {
    const el = qs('#onbNsecValue');
    const btn = qs('#onbRevealBtn');
    if (!el) return;
    const revealed = el.classList.toggle('revealed');
    if (btn) btn.textContent = revealed ? '🙈 Hide' : '👁 Reveal';
  }

  // Called from HTML: copy nsec to clipboard
  async function onbCopyNsec() {
    const value = state.pendingOnboardingNsec || (qs('#onbNsecValue') && qs('#onbNsecValue').textContent) || '';
    if (!value || value === 'nsec1...') return;
    try {
      await navigator.clipboard.writeText(value);
      const btn = qs('#onbCopyBtn');
      if (btn) {
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '📋 Copy'; btn.classList.remove('copied'); }, 2000);
      }
      // Also reveal so user can verify what was copied
      const el = qs('#onbNsecValue');
      if (el) { el.classList.add('revealed'); }
      const revBtn = qs('#onbRevealBtn');
      if (revBtn) revBtn.textContent = '🙈 Hide';
    } catch (_) {
      alert('Clipboard blocked. Please manually select and copy the key.');
    }
  }

  // Kept for backward compatibility (old HTML may call this)
  async function copyOnboardingNsec() { return onbCopyNsec(); }

  // Called when checkbox changes
  function onbCheckSaved() {
    const check = qs('#onbSavedCheck');
    const btn = qs('#onbContinueBtn');
    if (!btn) return;
    if (check && check.checked) {
      btn.classList.add('ready');
    } else {
      btn.classList.remove('ready');
    }
  }

  // Advance to profile step
  function onbGoToProfile() {
    const check = qs('#onbSavedCheck');
    if (!check || !check.checked) return;
    onbSetStep(2);
    onbUpdatePreview();
  }

  // Go back to key step
  function onbBackToKey() {
    onbSetStep(1);
  }

  // Live avatar preview update
  function onbUpdatePreview() {
    const circle = qs('#onbAvatarPreview');
    if (!circle) return;
    const url = (qs('#onbAvatar') && qs('#onbAvatar').value.trim()) || '';
    const name = (qs('#onbDisplayName') && qs('#onbDisplayName').value.trim()) || '';
    if (url) {
      circle.innerHTML = `<img src="${url}" alt="" onerror="this.parentElement.innerHTML='${name ? name[0].toUpperCase() : '?'}'">`;
    } else {
      circle.innerHTML = name ? name[0].toUpperCase() : '?';
    }
    if (url) circle.style.borderColor = 'var(--green)';
    else circle.style.borderColor = '';
  }

  async function completeOnboarding() {
    const saveBtn = qs('#onbSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Savingâ€¦'; }

    const profileData = {
      name: (qs('#onbDisplayName') && qs('#onbDisplayName').value.trim()) || shortHex(state.user ? state.user.pubkey : ''),
      picture: (qs('#onbAvatar') && qs('#onbAvatar').value.trim()) || '',
      banner: (qs('#onbBanner') && qs('#onbBanner').value.trim()) || '',
      about: (qs('#onbBio') && qs('#onbBio').value.trim()) || '',
      website: (qs('#onbWebsite') && qs('#onbWebsite').value.trim()) || '',
      lud16: (qs('#onbLud16') && qs('#onbLud16').value.trim()) || '',
      nip05: (qs('#onbNip05') && qs('#onbNip05').value.trim()) || ''
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
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✓ Save & Enter Sifaka Live'; }
      alert(err.message || 'Failed to publish profile. Please try again.');
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

    const preferredAddress = statusOverride
      ? state.selectedStreamAddress
      : (state.goLiveSelectedAddress || state.selectedStreamAddress);
    const currentEditAddress = (preferredAddress || '').trim();
    const current = currentEditAddress ? state.streamsByAddress.get(currentEditAddress) : null;
    const useCurrentFields = !!(statusOverride && current);

    const dTagVal = dTagInput ? dTagInput.value.trim() : '';
    const titleVal = titleInput ? titleInput.value.trim() : '';
    const summaryVal = summaryInput ? summaryInput.value.trim() : '';
    const streamUrlVal = streamUrlInput ? streamUrlInput.value.trim() : '';
    const thumbVal = thumbInput ? thumbInput.value.trim() : '';
    const startsRaw = startsInput ? startsInput.value : '';
    const startsParsed = toUnixSeconds(startsRaw);

    const dTag = useCurrentFields
      ? ((current && current.d) || `stream-${Date.now()}`)
      : (dTagVal || (current ? current.d : '') || `stream-${Date.now()}`);
    const title = useCurrentFields
      ? ((current && current.title) || 'Untitled stream')
      : (titleVal || (current ? current.title : '') || 'Untitled stream');
    const summary = useCurrentFields
      ? ((current && current.summary) || '')
      : (summaryInput ? summaryVal : ((current && current.summary) || ''));
    const streamUrl = useCurrentFields
      ? ((current && current.streaming) || '')
      : (streamUrlInput ? streamUrlVal : ((current && current.streaming) || ''));
    const thumb = useCurrentFields
      ? ((current && current.image) || '')
      : (thumbInput ? thumbVal : ((current && current.image) || ''));
    const starts = useCurrentFields
      ? ((current && current.starts) || null)
      : (startsInput ? (startsRaw ? startsParsed : null) : ((current && current.starts) || null));
    const rawStatus = statusOverride || (statusEl ? statusEl.textContent : ((current && current.status) || 'live'));
    const status = normalizeStreamStatus(rawStatus);

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
    if (status === 'ended') {
      state.goLiveHiddenEndedAddresses.add(stream.address);
      if (state.goLiveSelectedAddress === stream.address) state.goLiveSelectedAddress = '';
    } else {
      state.goLiveHiddenEndedAddresses.delete(stream.address);
      state.goLiveSelectedAddress = stream.address;
    }
    persistHiddenEndedStreamsForCurrentUser();
    state.isLive = status === 'live';
    updateGoLiveModalState();
    updateGoLiveButtonState();
    renderLiveGrid();
    // Refresh hero if this is the currently featured stream
    const featStreams = heroFeaturedStreams();
    if (featStreams.length) renderHero(featStreams[state.featuredIndex], state.featuredIndex, featStreams.length);
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
      await signAndPublish(KIND_LIVE_CHAT, text, tags);
      input.value = '';
    } catch (err) {
      alert(err.message || 'Failed to send chat message.');
    }
  }

  async function sendReaction() {
    const stream = state.streamsByAddress.get(state.selectedStreamAddress);
    if (!stream) return;
    if (!state.user) { window.openLogin(); return; }
    if (state.streamLikePublishPending) return;
    state.streamLikePublishPending = true;
    const ownPubkey = normalizePubkeyHex(state.user.pubkey);
    if (!ownPubkey) { state.streamLikePublishPending = false; return; }
    const alreadyLiked = state.likedStreamAddresses.has(stream.address);
    const likeMeta = { key: '+', label: '❤', imageUrl: '', shortcode: '' };

    try {
      if (alreadyLiked) {
        removeOwnStreamReactionByKey('+');
        renderStreamReactionsUi(stream);

        let reactionId = state.streamLikeEventIdByAddress.get(stream.address) || '';
        if (!reactionId) {
          reactionId = await findOwnStreamLikeReactionId(stream);
          if (reactionId) state.streamLikeEventIdByAddress.set(stream.address, reactionId);
        }

        if (reactionId) {
          await signAndPublish(KIND_DELETION, 'unliked stream', [['e', reactionId], ['k', String(KIND_REACTION)], ['a', stream.address]]);
          removeStreamReactionById(reactionId);
          state.streamLikeEventIdByAddress.delete(stream.address);
        } else {
          // Fallback for relays that cannot return our prior reaction quickly.
          await signAndPublish(KIND_REACTION, '-', [['e', stream.id], ['p', stream.pubkey], ['a', stream.address]]);
        }
      } else {
        applyStreamReaction(likeMeta, ownPubkey, '');
        renderStreamReactionsUi(stream);
        const likeEv = await signAndPublish(KIND_REACTION, '+', [['e', stream.id], ['p', stream.pubkey], ['a', stream.address]]);
        if (likeEv && likeEv.id) {
          state.streamLikeEventIdByAddress.set(stream.address, likeEv.id);
          applyStreamReaction(likeMeta, ownPubkey, likeEv.id);
        }
      }
      renderStreamReactionsUi(stream);
    } catch (err) {
      if (alreadyLiked) {
        applyStreamReaction(likeMeta, ownPubkey, state.streamLikeEventIdByAddress.get(stream.address) || '');
      } else {
        removeOwnStreamReactionByKey('+');
      }
      renderStreamReactionsUi(stream);
      alert(err.message || 'Failed to react.');
    } finally {
      state.streamLikePublishPending = false;
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

    /* ---- Master audio/playback stop ----
       Call with which player to KEEP playing ('hero' | 'theater' | 'profile' | null).
       All other active players are paused and their HLS instances destroyed.       */
    function stopAllAudio(keep) {
      // --- Hero ---
      if (keep !== 'hero') {
        // Pause any <video> inside the hero player
        const heroPlayer = qs('#heroPlayer');
        if (heroPlayer) {
          heroPlayer.querySelectorAll('video').forEach((v) => {
            try { v.pause(); v.src = ''; } catch (_) {}
          });
        }
        // Destroy HLS instance
        if (state.heroHlsInstance) {
          try { state.heroHlsInstance.destroy(); } catch (_) {}
          state.heroHlsInstance = null;
        }
        state.heroPlaybackToken++;
      }

      // --- Theater (video page) ---
      if (keep !== 'theater') {
        const playerBg = qs('.player-bg');
        if (playerBg) {
          playerBg.querySelectorAll('video').forEach((v) => {
            try { v.pause(); v.src = ''; } catch (_) {}
          });
        }
        if (state.hlsInstance) {
          try { state.hlsInstance.destroy(); } catch (_) {}
          state.hlsInstance = null;
        }
        state.playbackToken++;
        // Stop runtime ticker
        clearInterval(state._theaterRuntimeInterval);
        state._theaterRuntimeInterval = null;
      }

      // --- Profile mini-player ---
      if (keep !== 'profile') {
        const profilePlayer = qs('#profileLivePlayer');
        if (profilePlayer) {
          profilePlayer.querySelectorAll('video').forEach((v) => {
            try { v.pause(); v.src = ''; } catch (_) {}
          });
        }
        if (state.profileHlsInstance) {
          try { state.profileHlsInstance.destroy(); } catch (_) {}
          state.profileHlsInstance = null;
        }
        state.profilePlaybackToken++;
      }
    }

    window.showPage = function (p, opts = {}) {
      const routeMode = opts.routeMode || 'push';
      const home = qs('#homePage');
      const video = qs('#videoPage');
      const profile = qs('#profilePage');
      if (p !== 'video') setActiveViewerAddress('');
      if (p === 'home' && routeMode !== 'skip') syncHomeRoute(routeMode);
      if (home) home.classList.toggle('active', p === 'home');
      if (video) video.style.display = 'none';
      if (profile) profile.style.display = 'none';
      // Stop all other audio. On home: fully restart the hero cycle so no stale timer fires.
      stopAllAudio('hero');
      if (p === 'home') {
        stopHeroCycle(); // clear any stale timer first
        const streams = heroFeaturedStreams();
        if (streams.length) startHeroCycle();
      }
      if (state.settings.miniPlayer && state.selectedStreamAddress) window.showMini();
      else window.hideMini();
      window.scrollTo(0, 0);
    };

    window.showVideoPage = function (opts = {}) {
      const routeMode = opts.routeMode || 'replace';
      const home = qs('#homePage');
      const video = qs('#videoPage');
      const profile = qs('#profilePage');
      const selected = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
      setActiveViewerAddress(selected ? selected.address : '');
      if (selected && routeMode !== 'skip') syncTheaterRoute(selected, routeMode);
      if (home) home.classList.remove('active');
      if (video) video.style.display = 'block';
      if (profile) profile.style.display = 'none';
      // Kill the hero cycle timer completely â€” prevents it firing and starting audio behind theater
      stopHeroCycle();
      stopAllAudio('theater');
      if (window.renderRecoStreams) window.renderRecoStreams(); // populate "Also Live Now"
      if (state.settings.miniPlayer && state.selectedStreamAddress) window.showMini();
      else window.hideMini();
      window.scrollTo(0, 0);
    };

    window.showProfile = function (name, av, npub, nip05, rawPubkey, opts = {}) {
      const routeMode = opts.routeMode || 'push';
      const home = qs('#homePage');
      const video = qs('#videoPage');
      const profile = qs('#profilePage');
      setActiveViewerAddress('');
      if (home) home.classList.remove('active');
      if (video) video.style.display = 'none';
      if (profile) profile.style.display = 'block';
      // Kill the hero cycle timer completely â€” prevents audio starting behind profile
      stopHeroCycle();
      stopAllAudio('profile');

      setAvatarEl(qs('#profAv'), '', av || 'U');
      if (qs('#profName')) qs('#profName').textContent = name || 'user';
      if (qs('#profNpub')) qs('#profNpub').textContent = formatNpubForDisplay(npub || rawPubkey || '');
      const normalizedRawPubkey = normalizePubkeyHex(rawPubkey || '') || parseNpubMaybe(npub || '');
      const claimedNip05 = normalizeNip05Value(nip05 || '');
      const verifiedNip05 = normalizedRawPubkey ? getVerifiedNip05ForPubkey(normalizedRawPubkey, claimedNip05) : '';
      if (claimedNip05 && normalizedRawPubkey && !verifiedNip05) ensureNip05Verification(normalizedRawPubkey, claimedNip05).catch(() => {});
      setProfileVerificationStyle(verifiedNip05 ? 'verified' : (claimedNip05 ? 'invalid' : 'none'));

      const n05 = qs('#profNip05');
      const n05c = qs('#profNip05Check');
      if (verifiedNip05) {
        if (n05) {
          n05.style.display = 'flex';
          n05.textContent = `NIP-05: ${verifiedNip05}`;
        }
        if (n05c) {
          n05c.style.display = 'inline';
          n05c.textContent = '\u2713';
          n05c.title = 'NIP-05 verified';
        }
      } else if (claimedNip05) {
        if (n05) {
          n05.style.display = 'flex';
          n05.textContent = `Claimed NIP-05: ${claimedNip05}`;
        }
        if (n05c) {
          n05c.style.display = 'inline';
          n05c.textContent = '\u2715';
          n05c.title = 'NIP-05 not verified';
        }
      } else {
        if (n05) n05.style.display = 'none';
        if (n05c) n05c.style.display = 'none';
      }
      if (qs('#profNpub')) qs('#profNpub').style.display = 'block';

      if (qs('#profBio') && !qs('#profBio').textContent.trim()) {
        qs('#profBio').textContent = 'No bio yet.';
      }

      let inferredPubkey = normalizedRawPubkey;
      if (!inferredPubkey) {
        const wantedName = (name || '').trim().toLowerCase();
        const wantedNip05 = claimedNip05;
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
        if (routeMode !== 'skip') syncProfileRoute(inferredPubkey, routeMode);
        state.selectedProfilePubkey = inferredPubkey;
        renderProfilePage(inferredPubkey);
        subscribeProfileFeed(inferredPubkey);
        subscribeProfileStats(inferredPubkey);
      } else {
        if (routeMode !== 'skip') syncHomeRoute(routeMode);
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
        setProfileVerificationStyle(verifiedNip05 ? 'verified' : (claimedNip05 ? 'invalid' : 'none'));

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
        if (nostrSince) nostrSince.textContent = '';

        setProfileTab(state.profileTab || 'streams');
      }

      window.scrollTo(0, 0);
    };

    window.goBackFromProfile = function () {
      window.showPage('home');
    };

    window.heroNav = function (delta) {
      heroAdvance(delta);
      resetHeroCycle();
    };

    window.heroWatchCurrent = function () {
      const streams = heroFeaturedStreams();
      if (!streams.length) return;
      const idx = ((state.featuredIndex % streams.length) + streams.length) % streams.length;
      openStream(streams[idx].address);
    };

    /* ---- NIP-51 / Following Live filter globals ---- */
    window.toggleListFilterDD = function (e) {
      toggleListFilterDDInternal(e);
    };

    window.setListFilter = function (filterId, clickedBtn) {
      setListFilterInternal(filterId, clickedBtn);
    };

    window.lfAddInputChange = function (el) {
      lfAddInputChangeInternal(el);
    };

    window.lfAddList = function () {
      lfAddListInternal();
    };

    // Close list filter dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#listFilterWrap')) closeListFilterDD();
    });

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

    window.openProfileEditSettings = function () {
      window.openSettings();
      window.switchSettingsTab('profile');
    };

    // ---- Add-to-List dropdown (NIP-51) ----
    function renderAtlDropdown() {
      const itemsEl = qs('#atlListItems');
      if (!itemsEl) return;
      itemsEl.innerHTML = '';

      const lists = Array.from(state.nip51Lists.values());
      if (!lists.length) {
        itemsEl.innerHTML = '<div class="atl-empty">No lists yet - create one below.</div>';
        return;
      }

      const pubkey = state.selectedProfilePubkey;
      lists.forEach((list) => {
        const btn = document.createElement('button');
        btn.className = 'atl-item';
        const inList = !!(pubkey && list.pubkeys.includes(pubkey));
        if (inList) {
          btn.textContent = '✓ ' + (list.name || 'Unnamed List');
          btn.classList.add('atl-saved');
          btn.title = 'Click to remove from this list';
        } else {
          btn.textContent = (list.name || 'Unnamed List');
          btn.title = 'Click to add to this list';
        }
        btn.addEventListener('click', async () => {
          if (!pubkey) return;
          if (!state.user) { window.openLogin(); return; }
          try {
            const tags = [];
            if (inList) {
              // Remove: republish list without this pubkey
              list.pubkeys.filter((pk) => pk !== pubkey).forEach((pk) => tags.push(['p', pk]));
            } else {
              // Add: republish list with this pubkey appended
              list.pubkeys.forEach((pk) => tags.push(['p', pk]));
              tags.push(['p', pubkey]);
            }
            tags.push(['d', list.d]);
            if (list.name) tags.push(['name', list.name]);
            await signAndPublish(30000, '', tags);
            // Optimistically update local state
            if (inList) {
              list.pubkeys = list.pubkeys.filter((pk) => pk !== pubkey);
            } else {
              list.pubkeys.push(pubkey);
            }
            renderAtlDropdown();
            renderListFilterDD();
          } catch (err) {
            alert(err.message || 'Failed to update list.');
          }
        });
        itemsEl.appendChild(btn);
      });
    }

    window.toggleAtlDropdown = function (e) {
      if (e) e.stopPropagation();
      const dd = qs('#atlDropdown');
      if (!dd) return;
      if (dd.classList.contains('open')) {
        dd.classList.remove('open');
      } else {
        renderAtlDropdown();
        dd.classList.add('open');
        // Hide create row when reopening
        const nr = qs('#atlNewRow');
        if (nr) nr.style.display = 'none';
      }
    };

    window.atlShowCreateRow = function () {
      const nr = qs('#atlNewRow');
      if (nr) { nr.style.display = 'flex'; qs('#atlNewInput') && qs('#atlNewInput').focus(); }
    };

    window.atlCreateList = async function () {
      const inp = qs('#atlNewInput');
      const name = inp ? inp.value.trim() : '';
      if (!name) return;
      if (!state.user) { window.openLogin(); return; }

      const d = `list-${Date.now()}`;
      const pubkey = state.selectedProfilePubkey;
      const tags = [['d', d], ['name', name]];
      if (pubkey) tags.push(['p', pubkey]);

      try {
        const signed = await signAndPublish(30000, '', tags);
        const list = { id: `30000:${state.user.pubkey}:${d}`, name, pubkeys: pubkey ? [pubkey] : [], kind: 30000, d, pubkey: state.user.pubkey };
        state.nip51Lists.set(list.id, list);
        if (inp) inp.value = '';
        const nr = qs('#atlNewRow');
        if (nr) nr.style.display = 'none';
        renderAtlDropdown();
        renderListFilterDD();
      } catch (err) {
        alert(err.message || 'Failed to create list.');
      }
    };

    // Close ATL dropdown when clicking outside
    document.addEventListener('click', (e) => {
      const wrap = qs('#atlWrap');
      const dd = qs('#atlDropdown');
      if (dd && dd.classList.contains('open') && wrap && !wrap.contains(e.target)) {
        dd.classList.remove('open');
      }
    });

    window.addProfileToList = window.toggleAtlDropdown;

    window.shareProfile = async function () {
      const pubkey = state.selectedProfilePubkey;
      if (!pubkey) return;

      syncProfileRoute(pubkey, 'replace');
      const npub = formatNpubForDisplay(pubkey);
      const fallbackUrl = npub.startsWith('npub1') ? `${window.location.origin}/${npub}` : window.location.href;
      const text = isHomePath(window.location.pathname) ? fallbackUrl : window.location.href;
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
    window.returnToStream = function () { window.showVideoPage({ routeMode: 'push' }); };

    window.openGoLive = function () {
      if (!state.user) {
        window.openLogin();
        return;
      }
      if (!state.goLiveSelectedAddress && state.selectedStreamAddress) {
        state.goLiveSelectedAddress = state.selectedStreamAddress;
      }
      updateGoLiveModalState();
      const modal = qs('#goLiveModal');
      const form = qs('#mForm');
      const success = qs('#mSuccess');
      if (modal) modal.classList.add('open');
      if (form) form.style.display = 'block';
      if (success) success.className = 'msuccess';
    };

    window.closeGoLive = function () { qs('#goLiveModal').classList.remove('open'); };

    window.selectGoLiveStream = function (address) {
      state.goLiveSelectedAddress = (address || '').trim();
      updateGoLiveModalState();
    };

    window.removeGoLiveStreamFromList = function () {
      const address = (state.goLiveSelectedAddress || '').trim();
      if (!address) return;
      const stream = state.streamsByAddress.get(address);
      if (stream && normalizeStreamStatus(stream.status) !== 'ended') {
        alert('Only ended streams can be removed from this list.');
        return;
      }
      state.goLiveHiddenEndedAddresses.add(address);
      if (state.goLiveSelectedAddress === address) state.goLiveSelectedAddress = '';
      persistHiddenEndedStreamsForCurrentUser();
      updateGoLiveModalState();
    };

    window.publishStream = async function () {
      try {
        const stream = await publishCurrentStream();
        const status = normalizeStreamStatus(stream.status);
        const form = qs('#mForm');
        const success = qs('#mSuccess');
        const succTitle = success ? qs('.succ-title', success) : null;
        const succText = success ? qs('.succ-text', success) : null;
        if (form) form.style.display = 'none';
        if (success) success.classList.add('on');
        if (succTitle) succTitle.textContent = status === 'ended'
          ? 'Stream Ended'
          : (status === 'planned' ? 'Stream Updated' : "You're Live on Nostr!");
        if (succText) succText.textContent = status === 'ended'
          ? 'Your ended status has been published and removed from the edit list.'
          : (status === 'planned'
            ? 'Your stream details were updated with planned status.'
            : 'Your NIP-53 event is live on your relays.');
      } catch (err) {
        alert(err.message || 'Failed to publish stream.');
      }
    };

    window.goToMyStream = function () {
      const address = state.goLiveSelectedAddress || state.selectedStreamAddress;
      if (address) openStream(address);
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
      const selected = state.selectedStreamAddress && state.streamsByAddress.get(state.selectedStreamAddress);
      if (selected && normalizeStreamStatus(selected.status) === 'ended') {
        renderVideo(selected);
        window.showVideoPage({ routeMode: 'replace' });
      } else {
        window.showPage('home');
      }
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

    window.openSettings = function () {
      populateSettingsModal();
      qs('#settingsModal').classList.add('open');
      // Reset to profile tab each time
      window.switchSettingsTab('profile');
    };

    window.closeSettings = function () {
      qs('#settingsModal').classList.remove('open');
    };

    window.switchSettingsTab = function (tab) {
      ['profile','relays','app'].forEach(t => {
        const btn = qs(`#smTab-${t}`);
        const panel = qs(`#smPanel${t.charAt(0).toUpperCase()+t.slice(1)}`);
        if (btn) btn.classList.toggle('active', t === tab);
        if (panel) panel.classList.toggle('active', t === tab);
      });
    };

    window.previewSettingsAvatar = function (url) {
      const preview = qs('#smAvatarPreview');
      if (!preview) return;
      if (url && url.trim()) {
        preview.innerHTML = `<img src="${url.trim()}" alt="avatar" onerror="this.parentElement.innerHTML='?'">`;
      } else {
        preview.innerHTML = '?';
      }
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

    // Save just the Nostr profile (NIP-01 kind:0)
    window.saveProfileSettings = async function () {
      try {
        if (!state.user) { alert('Please sign in first.'); return; }
        const displayName = (qs('#settingsDisplayName') || {}).value || '';
        const username = (qs('#settingsUsername') || {}).value || '';
        const about = (qs('#settingsAbout') || {}).value || '';
        const picture = (qs('#settingsAvatarUrl') || {}).value || '';
        const banner = (qs('#settingsBannerInput') || {}).value || '';
        const website = (qs('#settingsWebsiteInput') || {}).value || '';
        const lud16 = (qs('#settingsLud16Input') || {}).value || '';
        const nip05 = (qs('#settingsNip05Input') || {}).value || '';

        await publishUserProfile({ name: username || displayName, display_name: displayName, about, picture, banner, website, lud16, nip05 });

        state.settings.lud16 = lud16;
        state.settings.website = website;
        state.settings.banner = banner;
        persistSettings();
        window.closeSettings();
      } catch (err) {
        alert(err.message || 'Failed to save profile.');
      }
    };

    // Save relay settings only
    window.saveRelaySettings = function () {
      try {
        const next = { ...state.settings, relays: [...state.settings.relays] };
        applySettings(next, { reconnect: true });
        window.closeSettings();
      } catch (err) {
        alert(err.message || 'Failed to save relays.');
      }
    };

    // Save app/interface settings only
    window.saveAppSettings = function () {
      try {
        const next = collectSettingsFromModal();
        applySettings(next, { reconnect: false });
        window.closeSettings();
      } catch (err) {
        alert(err.message || 'Failed to save settings.');
      }
    };

    // Legacy save â€” kept for external references
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
    window.onbRevealNsec = onbRevealNsec;
    window.onbCopyNsec = onbCopyNsec;
    window.onbCheckSaved = onbCheckSaved;
    window.onbGoToProfile = onbGoToProfile;
    window.onbBackToKey = onbBackToKey;
    window.onbUpdatePreview = onbUpdatePreview;
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

    window.toggleStreamEmojiReaction = async function (reactionKey) {
      const knownMeta = state.streamReactionMetaByKey.get(reactionKey) || {};
      const reactionMeta = {
        key: normalizeReactionContentKey(reactionKey),
        label: knownMeta.label || reactionKey,
        imageUrl: knownMeta.imageUrl || '',
        shortcode: knownMeta.shortcode || ''
      };
      await toggleStreamReactionByMeta(reactionMeta);
    };

    window.toggleProfilePostLike = async function (noteId, notePubkey, profilePubkey) {
      await togglePostReactionByMeta(noteId, notePubkey, profilePubkey, { key: '+', label: '❤', imageUrl: '', shortcode: '' });
    };

    window.toggleProfilePostEmoji = async function (noteId, notePubkey, profilePubkey, reactionKey, imageUrl = '', shortcode = '') {
      const knownMeta = state.streamReactionMetaByKey.get(reactionKey) || {};
      const reactionMeta = {
        key: normalizeReactionContentKey(reactionKey),
        label: knownMeta.label || reactionKey,
        imageUrl: imageUrl || knownMeta.imageUrl || '',
        shortcode: shortcode || knownMeta.shortcode || ''
      };
      await togglePostReactionByMeta(noteId, notePubkey, profilePubkey, reactionMeta);
    };

    const renderReactionPickerGrid = () => {
      const grid = qs('#reactionPickerGrid');
      if (!grid) return;
      grid.innerHTML = '';
      defaultReactionPickerOptions().forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'reaction-opt-btn';
        btn.title = opt.label || opt.key;
        btn.addEventListener('click', async () => {
          const target = state.reactionPickerTarget;
          if (!target) return;
          if (target.type === 'stream') {
            await toggleStreamReactionByMeta(opt);
          } else if (target.type === 'post') {
            await togglePostReactionByMeta(target.noteId, target.notePubkey, target.profilePubkey, opt);
          }
          window.closeReactionPicker();
        });

        if (opt.imageUrl) {
          const img = document.createElement('img');
          img.src = opt.imageUrl;
          img.alt = opt.label || opt.key;
          img.loading = 'lazy';
          btn.appendChild(img);
        } else {
          btn.textContent = opt.label || opt.key;
        }
        grid.appendChild(btn);
      });
    };

    window.openReactionPickerForStream = function () {
      const stream = state.streamsByAddress.get(state.selectedStreamAddress);
      if (!stream) return;
      state.reactionPickerTarget = { type: 'stream' };
      renderReactionPickerGrid();
      const code = qs('#reactionPickerCode');
      const url = qs('#reactionPickerUrl');
      if (code) code.value = '';
      if (url) url.value = '';
      const ov = qs('#reactionPickerModal');
      if (ov) ov.classList.add('open');
      if (code) code.focus();
    };

    window.openReactionPickerForPost = function (noteId, notePubkey, profilePubkey) {
      if (!noteId || !notePubkey || !profilePubkey) return;
      state.reactionPickerTarget = { type: 'post', noteId, notePubkey, profilePubkey };
      renderReactionPickerGrid();
      const code = qs('#reactionPickerCode');
      const url = qs('#reactionPickerUrl');
      if (code) code.value = '';
      if (url) url.value = '';
      const ov = qs('#reactionPickerModal');
      if (ov) ov.classList.add('open');
      if (code) code.focus();
    };

    window.closeReactionPicker = function (e) {
      const ov = qs('#reactionPickerModal');
      if (!ov) return;
      if (e && e.target !== ov) return;
      ov.classList.remove('open');
      state.reactionPickerTarget = null;
      const code = qs('#reactionPickerCode');
      const url = qs('#reactionPickerUrl');
      if (code) code.value = '';
      if (url) url.value = '';
    };

    window.submitCustomReactionPicker = async function () {
      const target = state.reactionPickerTarget;
      if (!target) return;
      const code = (qs('#reactionPickerCode') && qs('#reactionPickerCode').value || '').trim();
      const url = (qs('#reactionPickerUrl') && qs('#reactionPickerUrl').value || '').trim();
      const reactionMeta = reactionMetaFromPicker(code, url);
      if (!reactionMeta) {
        alert('Enter an emoji or :shortcode: first.');
        return;
      }
      if (target.type === 'stream') {
        await toggleStreamReactionByMeta(reactionMeta);
      } else if (target.type === 'post') {
        await togglePostReactionByMeta(target.noteId, target.notePubkey, target.profilePubkey, reactionMeta);
      }
      window.closeReactionPicker();
    };

    window.toggleChatLikeMessage = async function (messageId) {
      const messageEvent = state.chatMessageEventsById.get(messageId);
      const stream = state.streamsByAddress.get(state.selectedStreamAddress);
      if (!messageEvent || !stream || !/^[0-9a-f]{64}$/i.test(messageId || '')) return;
      if (!state.user) { window.openLogin(); return; }
      if (state.chatLikePublishPendingByMessageId.has(messageId)) return;

      const userPubkey = normalizePubkeyHex(state.user.pubkey);
      if (!userPubkey) return;
      state.chatLikePublishPendingByMessageId.add(messageId);

      const likedSet = state.chatLikePubkeysByMessageId.get(messageId) || new Set();
      const wasLiked = likedSet.has(userPubkey);
      const previousOwnReactionId = state.chatOwnLikeEventByMessageId.get(messageId) || '';

      try {
        if (wasLiked) {
          if (state.chatLikePubkeysByMessageId.has(messageId)) {
            state.chatLikePubkeysByMessageId.get(messageId).delete(userPubkey);
            if (!state.chatLikePubkeysByMessageId.get(messageId).size) state.chatLikePubkeysByMessageId.delete(messageId);
          }
          state.chatOwnLikeEventByMessageId.delete(messageId);
          updateChatLikeUi(messageId);

          let reactionId = previousOwnReactionId;
          if (!reactionId) {
            reactionId = await findOwnChatLikeReactionId(messageId, stream);
          }

          if (reactionId) {
            await signAndPublish(KIND_DELETION, 'unliked chat message', [['e', reactionId], ['k', String(KIND_REACTION)], ['a', stream.address]]);
            applyChatUnlikeByReactionId(reactionId);
          } else {
            await signAndPublish(KIND_REACTION, '-', [['e', messageId], ['p', messageEvent.pubkey], ['a', stream.address]]);
          }
          updateChatLikeUi(messageId);
        } else {
          applyChatLikeReaction(messageId, userPubkey, '');
          updateChatLikeUi(messageId);

          const likeEv = await signAndPublish(KIND_REACTION, '+', [['e', messageId], ['p', messageEvent.pubkey], ['a', stream.address]]);
          if (likeEv && likeEv.id) applyChatLikeReaction(messageId, userPubkey, likeEv.id);
          updateChatLikeUi(messageId);
        }
      } catch (err) {
        if (wasLiked) {
          applyChatLikeReaction(messageId, userPubkey, previousOwnReactionId);
        } else {
          const set = state.chatLikePubkeysByMessageId.get(messageId);
          if (set) {
            set.delete(userPubkey);
            if (!set.size) state.chatLikePubkeysByMessageId.delete(messageId);
          }
          state.chatOwnLikeEventByMessageId.delete(messageId);
        }
        updateChatLikeUi(messageId);
        alert(err.message || 'Failed to update chat like.');
      } finally {
        state.chatLikePublishPendingByMessageId.delete(messageId);
      }
    };

    window.toggleTheaterFollow = async function () {
      const stream = state.streamsByAddress.get(state.selectedStreamAddress);
      if (!stream) return;
      if (!state.user) { window.openLogin(); return; }
      const pubkey = normalizePubkeyHex(stream.hostPubkey);
      if (!pubkey) return;
      if (state.followPublishPending) return;
      state.followPublishPending = true;

      try {
        const wasFollowing = isFollowingPubkey(pubkey);
        const next = !wasFollowing;
        setFollowingPubkey(pubkey, next);
        state.contactListPubkeys = new Set(state.followedPubkeys);
        updateOwnFollowingStat(next ? 1 : -1);
        updateTheaterFollowBtn(pubkey);
        renderLiveGrid();

        // Keep profile page in sync if it's open for the same person
        if (normalizePubkeyHex(state.selectedProfilePubkey) === pubkey) renderProfileFollowButton(pubkey);

        try {
          await publishFollowedPubkeysToNostr();
          state.contactListPubkeys = new Set(state.followedPubkeys);
          renderFollowingCount();
          renderLiveGrid();
        } catch (err) {
          setFollowingPubkey(pubkey, wasFollowing);
          state.contactListPubkeys = new Set(state.followedPubkeys);
          updateOwnFollowingStat(next ? -1 : 1);
          updateTheaterFollowBtn(pubkey);
          if (normalizePubkeyHex(state.selectedProfilePubkey) === pubkey) renderProfileFollowButton(pubkey);
          renderLiveGrid();
          alert(err.message || 'Failed to update follow list.');
        }
      } finally {
        state.followPublishPending = false;
      }
    };

    // ---- "Also Live Now" reco panel ----
    window.renderRecoStreams = function () {
      const list = qs('#recoList');
      if (!list) return;
      const current = state.selectedStreamAddress;
      const thumbClasses = ['t1','t2','t3','t4','t5','t6','t7','t8'];
      const others = sortedLiveStreams()
        .filter((s) => s.address !== current && s.status === 'live')
        .slice(0, 6);
      list.innerHTML = '';
      if (!others.length) {
        list.innerHTML = '<div style="font-size:.74rem;color:var(--muted);padding:.25rem .45rem;">No other live streams right now.</div>';
        return;
      }
      others.forEach((s, i) => {
        const p = profileFor(s.hostPubkey);
        const viewerCount = effectiveParticipants(s);
        const item = document.createElement('div');
        item.className = 'reco-item';
        item.innerHTML = `
          <div class="reco-thumb"><div class="tc ${thumbClasses[i % thumbClasses.length]}" style="height:100%;display:flex;align-items:center;justify-content:center;font-size:1.2rem;"></div></div>
          <div class="reco-text"><div class="rt"></div><div class="rs"></div></div>`;
        qs('.rt', item).textContent = s.title || 'Untitled stream';
        qs('.rs', item).innerHTML = `${p.name || shortHex(s.hostPubkey)} - <span style="color:var(--live)">${viewerCount > 0 ? viewerCount.toLocaleString() + ' live' : 'live'}</span>`;
        if (s.image) {
          const thumb = qs('.reco-thumb', item);
          thumb.innerHTML = `<img src="${s.image}" style="width:100%;height:100%;object-fit:cover;" loading="lazy">`;
        }
        item.addEventListener('click', () => openStream(s.address));
        list.appendChild(item);
      });
    };

    // ---- Compose / post note on own profile ----
    window.profileComposeInput = function (el) {
      const max = 4096;
      const rem = max - (el.value || '').length;
      const chars = qs('#profileComposeChars');
      if (chars) {
        chars.textContent = `${rem}`;
        chars.style.color = rem < 50 ? 'var(--live)' : '';
      }
    };

    window.publishProfileNote = async function () {
      if (!state.user) { window.openLogin(); return; }
      const textarea = qs('#profileComposeText');
      const btn = qs('#profileComposeBtn');
      const text = (textarea && textarea.value || '').trim();
      if (!text) return;

      if (btn) { btn.disabled = true; btn.textContent = 'Postingâ€¦'; }
      try {
        await signAndPublish(1, text, []);
        if (textarea) textarea.value = '';
        window.profileComposeInput(textarea || { value: '' });
        // Refresh feed
        if (state.selectedProfilePubkey) {
          subscribeProfileFeed(state.selectedProfilePubkey);
        }
      } catch (err) {
        alert(err.message || 'Failed to post note.');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Post Note'; }
      }
    };

    // ---- Theater Zap ----
    window.theaterZap = async function () {
      const stream = state.streamsByAddress.get(state.selectedStreamAddress);
      if (!stream) return;
      if (!state.user) { window.openLogin(); return; }
      const p = profileFor(stream.hostPubkey);
      const lud16 = (p.lud16 || '').trim();
      if (!lud16) { alert('This streamer has no Lightning address (lud16) set on their Nostr profile.'); return; }
      if (window.webln) {
        try {
          await window.webln.enable();
          const zapAmountMsats = 21000;
          const zapTags = [['relays', ...state.relays], ['amount', String(zapAmountMsats)], ['p', stream.pubkey], ['e', stream.id]];
          const zapRequest = await signAndPublish(9734, '⚡ zapping from Sifaka Live', zapTags);
          const [user, domain] = lud16.split('@');
          const meta = await fetch(`https://${domain}/.well-known/lnurlp/${user}`).then((r) => r.json());
          if (!meta.callback) throw new Error('Invalid LNURL response.');
          const invoiceData = await fetch(`${meta.callback}?amount=${zapAmountMsats}&nostr=${encodeURIComponent(JSON.stringify(zapRequest))}`).then((r) => r.json());
          if (!invoiceData.pr) throw new Error('No payment request returned.');
          await window.webln.sendPayment(invoiceData.pr);
          const zapBtn = qs('#theaterZapBtn');
          if (zapBtn) { const o = zapBtn.innerHTML; zapBtn.textContent = '⚡ Zapped!'; setTimeout(() => { zapBtn.innerHTML = o; }, 2000); }
          return;
        } catch (err) { console.warn('WebLN zap failed:', err.message); }
      }
      window.open(`lightning:${lud16}`, '_blank');
    };

    // ---- Share stream ----
    window.closeShareModal = function (e) {
      const ov = qs('#shareModal');
      if (!ov) return;
      if (e && e.target !== ov) return;
      ov.classList.remove('open');
      state.shareModalStreamAddress = '';
    };

    window.copyShareField = async function (fieldId) {
      const input = qs(`#${fieldId}`);
      const val = input ? String(input.value || '').trim() : '';
      if (!val) return;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(val);
          return;
        }
      } catch (_) {}
      window.prompt('Copy value:', val);
    };

    window.shareStreamAction = async function (mode) {
      const stream = state.streamsByAddress.get(state.shareModalStreamAddress || state.selectedStreamAddress);
      if (!stream) return;
      syncTheaterRoute(stream, 'replace');

      const url = (qs('#shareWebUrl') && qs('#shareWebUrl').value) || window.location.href;
      const text = stream.title ? `Watching "${stream.title}" live on Nostr` : 'Live stream on Nostr';
      const shareBody = `${text}\n${url}`;

      try {
        if (mode === 'boost') {
          if (!state.user) { window.openLogin(); return; }
          const repostTags = [['e', stream.id], ['p', stream.pubkey], ['a', stream.address]];
          const repostContent = stream.raw && stream.raw.id ? JSON.stringify(stream.raw) : '';
          const repostEv = await signAndPublish(6, repostContent, repostTags);
          state.boostedStreamAddresses.add(stream.address);
          if (repostEv && repostEv.id) state.streamBoostEventIdByAddress.set(stream.address, repostEv.id);
          state.streamBoostCheckedByAddress.add(stream.address);
          updateTheaterShareBtn(stream);
          window.closeShareModal();
          return;
        }

        if (mode === 'copy') {
          await window.copyShareField('shareWebUrl');
          return;
        }

        if (mode === 'app') {
          if (navigator.share) {
            await navigator.share({ title: text, text: shareBody, url });
            return;
          }
          window.open(`sms:?&body=${encodeURIComponent(shareBody)}`, '_blank');
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        alert(err && err.message ? err.message : 'Share failed.');
      }
    };

    window.shareStream = async function () {
      const stream = state.streamsByAddress.get(state.selectedStreamAddress);
      if (!stream) return;

      syncTheaterRoute(stream, 'replace');
      state.shareModalStreamAddress = stream.address;

      const webUrl = window.location.href;
      const naddrInput = qs('#shareNaddr');
      const webInput = qs('#shareWebUrl');
      if (webInput) webInput.value = webUrl;

      const initialNaddr = encodeStreamNaddr(stream);
      if (naddrInput) naddrInput.value = initialNaddr || '';
      if (!initialNaddr) {
        ensureNostrTools().then(() => {
          const next = encodeStreamNaddr(stream);
          if (naddrInput) naddrInput.value = next || '';
        }).catch(() => {});
      }

      const ov = qs('#shareModal');
      if (ov) ov.classList.add('open');
    };

    const shareOv = qs('#shareModal');
    if (shareOv && !shareOv.dataset.boundOutsideClose) {
      shareOv.dataset.boundOutsideClose = '1';
      shareOv.addEventListener('click', (e) => {
        if (e.target === shareOv) window.closeShareModal(e);
      });
    }
    const reactionOv = qs('#reactionPickerModal');
    if (reactionOv && !reactionOv.dataset.boundOutsideClose) {
      reactionOv.dataset.boundOutsideClose = '1';
      reactionOv.addEventListener('click', (e) => {
        if (e.target === reactionOv) window.closeReactionPicker(e);
      });
    }

    // ---- Badge popup ----
    window.openBadgePopup = function ({ name, desc, image, id, issuer, definition, award }) {
      const ov = qs('#badgePopupOv');
      if (!ov) return;

      const imgWrap = qs('#badgePopupImgWrap');
      const nameEl = qs('#badgePopupName');
      const descEl = qs('#badgePopupDesc');
      const metaEl = qs('#badgePopupMeta');

      const info = badgeInfoFromEvents(award, definition);
      const finalName = (name || info.name || '').trim();
      const finalDesc = desc || info.desc || '';
      const finalId = (id || info.id || '').trim();
      const finalIssuer = (issuer || info.issuer || '').trim();

      if (nameEl) nameEl.textContent = finalName || 'Award';
      if (descEl) descEl.textContent = finalDesc;

      if (imgWrap) {
        imgWrap.innerHTML = '';
        const imageUrl = sanitizeMediaUrl(image || info.image || '');
        if (imageUrl && isLikelyUrl(imageUrl)) {
          const img = document.createElement('img');
          img.src = imageUrl;
          img.alt = finalName || 'Award';
          img.onerror = () => { imgWrap.textContent = ''; };
          imgWrap.appendChild(img);
        } else {
          imgWrap.textContent = '';
        }
      }

      if (metaEl) {
        metaEl.innerHTML = '';
        const rows = [];
        if (finalIssuer) rows.push({ lbl: 'Issued by', val: finalIssuer });
        if (finalId) rows.push({ lbl: 'Badge ID', val: finalId });
        if (definition) {
          if (definition.created_at) {
            rows.push({ lbl: 'Created', val: new Date(definition.created_at * 1000).toLocaleDateString() });
          }
        }
        if (award && award.created_at) {
          rows.push({ lbl: 'Awarded', val: new Date(award.created_at * 1000).toLocaleDateString() });
        }
        rows.forEach(({ lbl, val }) => {
          const row = document.createElement('div');
          row.className = 'badge-popup-meta-row';
          row.innerHTML = `<span class="badge-popup-meta-lbl">${lbl}</span><span class="badge-popup-meta-val"></span>`;
          qs('.badge-popup-meta-val', row).textContent = val;
          metaEl.appendChild(row);
        });
      }

      ov.classList.add('open');
    };

    window.closeBadgePopup = function (e) {
      if (e && e.target !== qs('#badgePopupOv')) return;
      const ov = qs('#badgePopupOv');
      if (ov) ov.classList.remove('open');
    };

    // ---- All Badges popup ----
    window.openAllBadgesPopup = function (badges) {
      const ov = qs('#allBadgesPopupOv');
      const grid = qs('#allBadgesGrid');
      if (!ov || !grid) return;
      grid.innerHTML = '';
      badges.forEach(({ award, definition }) => {
        const chip = document.createElement('div');
        chip.className = 'profile-badge-chip';
        const info = badgeInfoFromEvents(award, definition);
        if (info.image && isLikelyUrl(info.image)) {
          const img = document.createElement('img');
          img.src = info.image; img.alt = info.name; img.loading = 'lazy';
          img.onerror = () => { chip.innerHTML = ''; };
          chip.appendChild(img);
        } else { chip.textContent = ''; }
        chip.title = info.name;
        chip.addEventListener('click', () => { openBadgePopup({ ...info, definition, award }); });
        grid.appendChild(chip);
      });
      ov.classList.add('open');
    };

    window.closeAllBadgesPopup = function (e) {
      if (e && e.target !== qs('#allBadgesPopupOv')) return;
      const ov = qs('#allBadgesPopupOv');
      if (ov) ov.classList.remove('open');
    };

    // ---- Sign out: clear all data, go home ----
    window.signOut = function () {
      try { localStorage.clear(); } catch (_) {}
      state.user = null; state.authMode = 'readonly'; state.localSecretKey = null;
      state.pendingOnboardingNsec = ''; state.selectedStreamAddress = null;
      state.selectedProfilePubkey = null; state.selectedProfileLiveAddress = null;
      state.followedPubkeys = new Set(); state.contactListPubkeys = new Set();
      state.contactsLatestCreatedAt = 0; state.contactsContent = '';
      state.contactsPTagByPubkey = new Map(); state.contactsOtherTags = [];
      state.followPublishPending = false;
      state.nip51Lists = new Map(); state.savedExternalLists = [];
      state.likedStreamAddresses = new Set();
      state.streamLikeEventIdByAddress = new Map();
      state.streamLikePublishPending = false;
      state.boostedStreamAddresses = new Set();
      state.streamBoostEventIdByAddress = new Map();
      state.streamBoostCheckedByAddress = new Set();
      state.streamBoostCheckPendingByAddress = new Set();
      state.streamReactionPubkeysByKey = new Map();
      state.streamReactionMetaByKey = new Map();
      state.streamReactionIdByKeyAndPubkey = new Map();
      state.streamReactionEventById = new Map();
      state.streamOwnReactionIdByKey = new Map();
      state.streamReactionPublishPendingByKey = new Set();
      state.chatLikePubkeysByMessageId = new Map();
      state.chatReactionIdByMessageAndPubkey = new Map();
      state.chatReactionEventById = new Map();
      state.chatOwnLikeEventByMessageId = new Map();
      state.chatMessageEventsById = new Map();
      state.chatLikePublishPendingByMessageId = new Set();
      state.postReactionPublishPendingByNoteAndKey = new Set();
      state.reactionPickerTarget = null;
      state.shareModalStreamAddress = '';
      state.goLiveSelectedAddress = '';
      state.goLiveHiddenEndedAddresses = new Set();
      state.nip05VerificationByPubkey = new Map();
      state.nip05VerificationPendingByPubkey = new Set();
      state.nip05LookupCacheByNip05 = new Map();
      window.closeAllDD();
      ['goLiveModal','endModal','loginModal','settingsModal','faqModal','shareModal','reactionPickerModal'].forEach((id) => {
        const el = qs('#' + id); if (el) el.classList.remove('open');
      });
      setUserUi();
      stopAllAudio(null);
      setActiveViewerAddress('');
      window.showPage('home');
    };
  }

  function initEmojiPicker() {
    const emojis = [':)', ':D', '<3', ':fire:', ':zap:', ':rocket:', ':100:', ':wave:', ':music:', ':clap:'];
    const grid = qs('#epGrid');
    if (grid) {
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
    }

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.chat-acts')) window.closeEmoji();
      if (!e.target.closest('.logo-wrap') && !e.target.closest('.nav-profile')) window.closeAllDD();
    });

    ['goLiveModal', 'endModal', 'loginModal', 'faqModal'].forEach((id) => {
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
    loadSavedExternalLists();
    applySettingsToDocument();

    bindLegacyGlobals();
    initEmojiPicker();
    wireEvents();
    window.addEventListener('popstate', () => {
      syncViewFromLocation({ fallbackMode: 'skip' });
    });

    const logoBtn = qs('#logoBtn');
    if (logoBtn) logoBtn.addEventListener('click', (e) => { e.stopPropagation(); window.toggleDD('logo'); });
    const pill = qs('#navUserPill');
    if (pill) pill.addEventListener('click', (e) => { e.stopPropagation(); window.toggleDD('profile'); });

    initRelay();
    await tryRestoreLocalLogin();
    setUserUi();
    syncViewFromLocation({ fallbackMode: 'replace' });

    // Render saved external lists immediately (they come from localStorage)
    renderListFilterDD();
    renderLiveGrid();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

