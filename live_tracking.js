/* ==========================================================================
   live_tracking.js - TrekSOS group rooms + live location tracking (client)

   Loaded AFTER the main script in index.html / sos2.html. It reuses what is
   already there (map, memberLayers, members, locateUserLive, updateGpsPosition,
   showToast, triggerSOS ...) and replaces the demo-only room code and the
   simulated squad with real data from the Flask API in live_rooms.py.

   Flow
     create / join (4-digit key)  ->  watchPosition  ->  POST /location every ~3 s
     poll GET /members every 3 s  ->  markers, trails, roster, warnings
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------ settings ------------------------------ */
  const API = location.protocol === 'file:' ? 'http://localhost:5000' : '';
  const POLL_MS = 3000;
  const POLL_HIDDEN_MS = 10000;
  const PUSH_MIN_MS = 3000;          // never send GPS fixes faster than this
  const HEARTBEAT_MS = 6000;         // re-send last fix so a stationary trekker stays "online"
  const STRAGGLER_M = 300;           // warn when a member is this far from the leader
  const TRAIL_MAX_POINTS = 60;
  const STORE_KEY = 'treksos_live_room';
  const NAME_KEY = 'treksos_live_name';

  /* ------------------------------- state -------------------------------- */
  const S = {
    room: null,            // { code, memberId, token, name, role }
    members: [],           // latest list from the server
    markers: {},           // memberId -> L.Marker
    markerKey: {},         // memberId -> string (to avoid redundant setIcon)
    trails: {},            // memberId -> L.Polyline
    prevStatus: {},        // memberId -> last status (for toasts)
    prevSos: {},
    prevFar: {},
    myPos: null,           // { lat, lng, accuracy }
    battery: null,
    lastPush: 0,
    pollTimer: null,
    heartbeat: null,
    banner: null,
    demo: null,
    busy: false,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // showToast() in index.html renders HTML, and our messages contain teammate names, so escape them.
  const toast = (msg, ms) => { try { showToast(esc(msg), ms || 3500); } catch (e) { console.log(msg); } };

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180;
    const dp = (lat2 - lat1) * rad, dl = (lng2 - lng1) * rad;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const fmtDist = (m) => (m == null ? '' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
  function ago(sec) {
    if (sec == null) return '';
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    return `${Math.round(sec / 3600)}h`;
  }

  async function api(path, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(API + path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
      });
      let data = {};
      try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
      if (!res.ok || data.status === 'error') {
        const err = new Error(data.message || `Server error ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') { e.message = 'Server did not respond in time.'; }
      else if (e instanceof TypeError) { e.message = 'Cannot reach the TrekSOS server. Is server.py running?'; }
      throw e;
    } finally { clearTimeout(t); }
  }

  /* ----------------------------- identity ------------------------------- */
  function myName(preferred) {
    let n = (preferred || '').trim();
    if (!n && typeof currentUser !== 'undefined' && currentUser && currentUser.fullName) n = currentUser.fullName;
    if (!n) { try { n = localStorage.getItem(NAME_KEY) || ''; } catch (e) { /* private mode */ } }
    if (!n) n = (window.prompt('Your name for the squad (shown to teammates):', '') || '').trim();
    n = (n || 'Trekker').slice(0, 40);
    try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* ignore */ }
    return n;
  }
  const saveRoom = () => { try { S.room ? localStorage.setItem(STORE_KEY, JSON.stringify(S.room)) : localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } };
  const loadRoom = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; } };

  /* ------------------------------- styles ------------------------------- */
  function injectStyles() {
    const css = `
      .lt-pin{display:flex;align-items:center;gap:6px;white-space:nowrap}
      .lt-dot{width:28px;height:28px;border-radius:50%;background:var(--c);border:3px solid #fff;
        box-shadow:0 0 10px var(--c);display:flex;align-items:center;justify-content:center;
        font:800 12px 'Outfit',sans-serif;color:#000}
      .lt-name{background:rgba(15,23,42,.88);color:#fff;font:700 11px 'Outfit',sans-serif;padding:2px 7px;border-radius:6px}
      .lt-sos .lt-dot{background:#ef4444;color:#fff;animation:ltPulse .8s infinite}
      @keyframes ltPulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.9)}100%{box-shadow:0 0 0 16px rgba(239,68,68,0)}}
      .lt-banner{background:rgba(15,23,42,.92);color:#fff;border:1px solid #334155;border-radius:10px;
        padding:8px 10px;font:600 12px 'Outfit',sans-serif;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .lt-banner b{letter-spacing:2px;font-family:monospace;font-size:14px}
      .lt-banner button{background:#334155;color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;font:700 11px 'Outfit',sans-serif}
      .lt-banner button:hover{background:#475569}
      .lt-row{cursor:pointer}
      .lt-form{margin-bottom:12px}
      .lt-form label{font-size:12px;font-weight:700;color:#111827;display:block;margin-bottom:4px}
      .lt-form input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d1d5db;border-radius:8px;font-size:13px}
      .lt-actions{display:flex;gap:8px;margin-top:12px}
      .lt-actions .action-btn{flex:1}
      .lt-note{font-size:11px;color:#6b7280;margin-top:6px;line-height:1.4}
    `;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ---------------------- room modal: inject extras ---------------------- */
  function patchRoomModal() {
    // empty the demo PIN digits and placeholder key so nothing looks "already joined"
    ['pin1', 'pin2', 'pin3', 'pin4', 'wPin1', 'wPin2', 'wPin3', 'wPin4'].forEach((id) => {
      const el = $(id);
      if (el) { el.value = ''; el.setAttribute('inputmode', 'numeric'); el.setAttribute('pattern', '[0-9]'); }
    });
    ['pin1', 'pin2', 'pin3', 'wPin1', 'wPin2', 'wPin3'].forEach((id, i, arr) => {
      const el = $(id);
      const next = $(id.replace(/\d$/, (d) => String(+d + 1)));
      if (el && next) el.addEventListener('input', () => { if (el.value) next.focus(); });
    });
    const gen = $('generatedKeyDisplay');
    if (gen) gen.textContent = '----';

    const join = $('joinRoomSection');
    if (join && !$('ltJoinName')) {
      const f = document.createElement('div');
      f.className = 'lt-form';
      f.innerHTML = '<label for="ltJoinName">Your name (shown to the squad)</label><input id="ltJoinName" maxlength="40" placeholder="e.g. Tapabrata">';
      join.insertBefore(f, join.querySelector('.pin-entry-container'));
    }
    const create = $('createRoomSection');
    if (create && !$('ltCreateName')) {
      const f = document.createElement('div');
      f.className = 'lt-form';
      f.innerHTML = '<label for="ltCreateName">Your name (shown to the squad)</label><input id="ltCreateName" maxlength="40" placeholder="e.g. Tapabrata">';
      create.insertBefore(f, create.querySelector('.form-group'));
    }
    const closeBtn = document.querySelector('#roomModal > .window-content > .action-btn.secondary:last-of-type');
    if (closeBtn && !$('ltExtraActions')) {
      const box = document.createElement('div');
      box.id = 'ltExtraActions';
      box.innerHTML = `
        <div class="lt-actions">
          <button class="action-btn secondary" id="ltDemoBtn" type="button">Add 2 demo teammates</button>
          <button class="action-btn secondary" id="ltLeaveBtn" type="button" style="display:none">Leave room</button>
        </div>
        <div class="lt-note">Demo teammates are simulated trekkers walking near you. Use them to test or present live tracking on one device.</div>`;
      closeBtn.parentNode.insertBefore(box, closeBtn);
      $('ltDemoBtn').addEventListener('click', startDemo);
      $('ltLeaveBtn').addEventListener('click', () => leaveRoom(true));
    }
    const wizMsg = $('wizardSquadStatusMsg');
    if (wizMsg) { wizMsg.style.color = '#92400e'; wizMsg.textContent = 'Not connected yet. Enter a 4-digit key or generate a new one.'; }
  }

  function readPin(prefix) {
    return [1, 2, 3, 4].map((i) => ($(`${prefix}${i}`) || {}).value || '').join('').trim();
  }
  function writePin(prefix, code) {
    [1, 2, 3, 4].forEach((i) => { const el = $(`${prefix}${i}`); if (el) el.value = code[i - 1] || ''; });
  }

  /* ----------------------------- room actions ---------------------------- */
  async function createRoom(opts) {
    if (S.busy) return null;
    S.busy = true;
    try {
      if (S.room) await leaveRoom(false);
      const res = await api('/api/rooms/create', {
        user: opts.name, role: opts.role || 'Expedition Leader', room_name: opts.roomName || 'TrekSOS Squad',
      });
      enterRoom(res, opts.name, opts.role || 'Expedition Leader');
      toast(`Room ${res.code} created. Share this 4-digit key with your squad.`, 4500);
      return res.code;
    } catch (e) { toast(`Could not create room: ${e.message}`, 5000); return null; }
    finally { S.busy = false; }
  }

  async function joinRoom(code, name, role) {
    if (S.busy) return false;
    if (!/^\d{4}$/.test(code)) { toast('Enter all 4 digits of the squad key.', 3500); return false; }
    S.busy = true;
    try {
      const saved = loadRoom();
      const same = saved && saved.code === code;
      if (S.room && S.room.code !== code) await leaveRoom(false);
      const res = await api('/api/rooms/join', {
        code, user: name, role: role || 'Explorer',
        member_id: same ? saved.memberId : undefined, token: same ? saved.token : undefined,
      });
      enterRoom(res, name, role || 'Explorer');
      toast(`Joined room ${code} with ${res.room.members.length} member(s).`, 3500);
      return true;
    } catch (e) { toast(`Could not join: ${e.message}`, 5000); return false; }
    finally { S.busy = false; }
  }

  function enterRoom(res, name, role) {
    S.room = { code: res.code, memberId: res.member_id, token: res.token, name, role };
    saveRoom();
    try { expeditionRoomCode = res.code; } catch (e) { /* ignore */ }
    const disp = $('currentRoomKeyDisplay'); if (disp) disp.textContent = res.code;
    const gen = $('generatedKeyDisplay'); if (gen) gen.textContent = res.code;
    writePin('pin', res.code); writePin('wPin', res.code);
    const wm = $('wizardSquadStatusMsg');
    if (wm) { wm.style.color = '#059669'; wm.innerHTML = `Connected to room <b>${esc(res.code)}</b> (${res.room.members.length} member(s)). Live tracking is on.`; }
    const lb = $('ltLeaveBtn'); if (lb) lb.style.display = '';

    hideSimulatedSquad();
    addBanner();
    applyRoom(res.room);
    startGps();
    scheduleHeartbeat();
    schedulePoll(POLL_MS);
  }

  async function leaveRoom(announce) {
    stopDemo();
    const r = S.room;
    S.room = null;
    saveRoom();
    clearTimeout(S.pollTimer); S.pollTimer = null;
    clearInterval(S.heartbeat); S.heartbeat = null;
    if (r) { try { await api(`/api/rooms/${r.code}/leave`, { member_id: r.memberId, token: r.token }); } catch (e) { /* offline: fine */ } }
    Object.values(S.markers).forEach((m) => map.removeLayer(m));
    Object.values(S.trails).forEach((t) => map.removeLayer(t));
    S.markers = {}; S.markerKey = {}; S.trails = {}; S.prevStatus = {}; S.prevSos = {}; S.prevFar = {}; S.members = [];
    if (S.banner) { map.removeControl(S.banner); S.banner = null; }
    showSimulatedSquad();
    const lb = $('ltLeaveBtn'); if (lb) lb.style.display = 'none';
    renderRoster(); window.renderSquadList();
    if (announce) toast('You left the squad room.', 3000);
  }

  /* --------------------- simulated demo squad (old code) ------------------ */
  function hideSimulatedSquad() {
    try { members.forEach((m) => m.marker && memberLayers.removeLayer(m.marker)); } catch (e) { /* ignore */ }
  }
  function showSimulatedSquad() {
    try { members.forEach((m) => m.marker && memberLayers.addLayer(m.marker)); } catch (e) { /* ignore */ }
  }

  /* -------------------------------- GPS ---------------------------------- */
  function startGps() {
    if (!window.isSecureContext && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      toast('This browser blocks GPS on plain http:// pages (except localhost). Open the app via https or localhost to share your location.', 7000);
    }
    try { navigator.getBattery && navigator.getBattery().then((b) => { S.battery = Math.round(b.level * 100); }); } catch (e) { /* ignore */ }
    try { locateUserLive(false); } catch (e) { console.warn(e); }
  }

  // called from the wrapped updateGpsPosition() on every real GPS fix
  function onMyPosition(pos) {
    S.myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
    if (S.room && Date.now() - S.lastPush >= PUSH_MIN_MS) pushLocation();
  }

  async function pushLocation() {
    const r = S.room;
    if (!r || !S.myPos) return;
    S.lastPush = Date.now();
    try {
      const res = await api(`/api/rooms/${r.code}/location`, {
        member_id: r.memberId, token: r.token,
        lat: S.myPos.lat, lng: S.myPos.lng, accuracy: S.myPos.accuracy, battery: S.battery,
      });
      if (S.room === r) applyRoom(res.room);
    } catch (e) { handleSessionError(e); }
  }

  function scheduleHeartbeat() {
    clearInterval(S.heartbeat);
    S.heartbeat = setInterval(() => {
      if (S.room && S.myPos && Date.now() - S.lastPush >= HEARTBEAT_MS - 1000) pushLocation();
    }, HEARTBEAT_MS);
  }

  /* ------------------------------- polling -------------------------------- */
  function schedulePoll(ms) {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(poll, ms);
  }
  async function poll() {
    const r = S.room;
    if (!r) return;
    try {
      const res = await api(`/api/rooms/${r.code}/members`);
      if (S.room === r) applyRoom(res.room);
    } catch (e) { handleSessionError(e); }
    if (S.room === r) schedulePoll(document.hidden ? POLL_HIDDEN_MS : POLL_MS);
  }
  function handleSessionError(e) {
    if (e.status === 404 || e.status === 403) {
      toast('This squad room has ended or expired. Create or join a room again.', 5000);
      leaveRoom(false);
    } else if (!S.warnedOffline) {
      S.warnedOffline = true;
      toast(`Live tracking paused: ${e.message}`, 4000);
      setTimeout(() => { S.warnedOffline = false; }, 30000);
    }
  }

  /* ------------------------ render room on the map ------------------------ */
  function statusText(m) {
    if (m.sos) return '🚨 SOS ACTIVE';
    if (m.status === 'online') return '🟢 Online';
    if (m.status === 'stale') return `🟡 Weak signal · last fix ${ago(m.seconds_since_fix)} ago`;
    if (m.status === 'offline') return `🔴 Offline · last seen ${ago(m.seconds_since_fix)} ago`;
    return '⚪ Waiting for GPS';
  }

  function iconFor(m) {
    const initial = esc((m.name || '?').trim().charAt(0).toUpperCase());
    return L.divIcon({
      className: '',
      html: `<div class="lt-pin ${m.sos ? 'lt-sos' : ''}" style="--c:${esc(m.color)}"><span class="lt-dot">${initial}</span><span class="lt-name">${esc(m.name)}${m.is_leader ? ' ★' : ''}</span></div>`,
      iconSize: null, iconAnchor: [14, 14],
    });
  }

  function popupFor(m, isMe) {
    const lines = [`<b>${esc(m.name)}</b>${isMe ? ' (You)' : ''} · ${esc(m.role)}${m.is_leader ? ' ★ Leader' : ''}`, statusText(m)];
    if (!isMe && S.myPos && m.lat != null) lines.push(`${fmtDist(haversine(S.myPos.lat, S.myPos.lng, m.lat, m.lng))} from you`);
    if (m.distance_to_leader_m != null) lines.push(`${fmtDist(m.distance_to_leader_m)} from leader`);
    if (m.battery != null) lines.push(`🔋 ${m.battery}%`);
    if (m.accuracy != null) lines.push(`Accuracy ±${Math.round(m.accuracy)} m`);
    return `<div style="font-family:'Outfit',sans-serif;font-size:12px;line-height:1.5">${lines.join('<br>')}</div>`;
  }

  function applyRoom(room) {
    if (!S.room || room.code !== S.room.code) return;
    S.members = room.members;
    const seen = new Set();
    room.members.forEach((m) => {
      seen.add(m.id);
      const isMe = m.id === S.room.memberId;
      notifyChanges(m, isMe);
      if (isMe || m.lat == null) return;               // my own dot is the blue GPS beacon

      const pos = [m.lat, m.lng];
      const key = `${m.status}|${m.sos}|${m.name}|${m.is_leader}`;
      let mk = S.markers[m.id];
      if (!mk) {
        mk = L.marker(pos, { icon: iconFor(m), zIndexOffset: 2000 }).addTo(map);
        mk.bindPopup(() => popupFor(m, false));
        S.markers[m.id] = mk;
        S.markerKey[m.id] = key;
      } else {
        mk.setLatLng(pos);
        if (S.markerKey[m.id] !== key) { mk.setIcon(iconFor(m)); S.markerKey[m.id] = key; }
        mk.getPopup().setContent(popupFor(m, false));
      }
      mk.setOpacity(m.status === 'offline' ? 0.45 : m.status === 'stale' ? 0.75 : 1);
      mk._ltMember = m;

      // breadcrumb trail (client side only)
      let tr = S.trails[m.id];
      if (!tr) { tr = L.polyline([pos], { color: m.color, weight: 3, opacity: 0.7, dashArray: '2 6' }).addTo(map); S.trails[m.id] = tr; }
      const pts = tr.getLatLngs();
      const last = pts[pts.length - 1];
      if (!last || haversine(last.lat, last.lng, pos[0], pos[1]) > 3) {
        pts.push(L.latLng(pos));
        if (pts.length > TRAIL_MAX_POINTS) pts.shift();
        tr.setLatLngs(pts);
      }
    });
    // members who left the room
    Object.keys(S.markers).forEach((id) => {
      if (!seen.has(id)) {
        map.removeLayer(S.markers[id]); delete S.markers[id]; delete S.markerKey[id];
        if (S.trails[id]) { map.removeLayer(S.trails[id]); delete S.trails[id]; }
      }
    });
    renderRoster(); window.renderSquadList(); updateBanner();
  }

  function notifyChanges(m, isMe) {
    const prev = S.prevStatus[m.id];
    S.prevStatus[m.id] = m.status;
    if (isMe) return;
    if (prev === undefined) { if (S.members.length > 1) toast(`${m.name} is in the squad.`, 2500); }
    else if (prev !== 'offline' && m.status === 'offline') toast(`${m.name} went offline (last seen ${ago(m.seconds_since_fix)} ago).`, 5000);
    else if (prev === 'offline' && m.status === 'online') toast(`${m.name} is back online.`, 3000);

    if (m.sos && !S.prevSos[m.id]) {
      toast(`🚨 ${m.name} triggered SOS! Check the map.`, 8000);
      if (S.markers[m.id]) { map.flyTo(S.markers[m.id].getLatLng(), Math.max(map.getZoom(), 15)); S.markers[m.id].openPopup(); }
    }
    S.prevSos[m.id] = m.sos;

    const far = m.distance_to_leader_m != null && m.distance_to_leader_m > STRAGGLER_M;
    if (far && !S.prevFar[m.id]) toast(`⚠️ ${m.name} is ${fmtDist(m.distance_to_leader_m)} behind the leader.`, 5000);
    S.prevFar[m.id] = far;
  }

  /* ------------------------------- banner --------------------------------- */
  function addBanner() {
    if (S.banner) return;
    const c = L.control({ position: 'bottomright' });
    c.onAdd = () => {
      const div = L.DomUtil.create('div', 'lt-banner');
      div.id = 'ltBanner';
      div.innerHTML = '<span>Room <b id="ltBannerCode"></b></span><span id="ltBannerCount"></span>' +
        '<button type="button" id="ltFitBtn">Fit squad</button><button type="button" id="ltLeaveMapBtn">Leave</button>';
      L.DomEvent.disableClickPropagation(div);
      div.querySelector('#ltFitBtn').addEventListener('click', fitSquad);
      div.querySelector('#ltLeaveMapBtn').addEventListener('click', () => leaveRoom(true));
      return div;
    };
    c.addTo(map);
    S.banner = c;
  }
  function updateBanner() {
    if (!S.room) return;
    const code = $('ltBannerCode'), cnt = $('ltBannerCount');
    if (code) code.textContent = S.room.code;
    if (cnt) cnt.textContent = `${S.members.filter((m) => m.status === 'online').length}/${S.members.length} online`;
  }
  function fitSquad() {
    const pts = Object.values(S.markers).map((m) => m.getLatLng());
    if (S.myPos) pts.push(L.latLng(S.myPos.lat, S.myPos.lng));
    if (!pts.length) { toast('No teammate positions yet.', 2500); return; }
    if (pts.length === 1) map.flyTo(pts[0], 15); else map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
  }

  /* --------------------------- roster / sidebar --------------------------- */
  function memberRowHtml(m, isMe, forModal) {
    const initial = esc((m.name || '?').trim().charAt(0).toUpperCase());
    const extra = [];
    if (m.distance_to_leader_m != null) extra.push(`${fmtDist(m.distance_to_leader_m)} from leader`);
    if (m.battery != null) extra.push(`🔋${m.battery}%`);
    const sub = `${statusText(m)}${extra.length ? ' · ' + extra.join(' · ') : ''}`;
    if (forModal) {
      return `<div class="member-roster-row"><div class="roster-avatar" style="background:${esc(m.color)}">${initial}</div>
        <div><div class="roster-name">${esc(m.name)}${isMe ? ' (You)' : ''} <span class="badge-role">${esc(m.role)}${m.is_leader ? ' ★' : ''}</span></div>
        <div class="roster-status">${esc(sub)}</div></div></div>`;
    }
    return `<div class="member-row lt-row" data-mid="${esc(m.id)}">
      <div class="member-avatar" style="background:${esc(m.color)}">${initial}</div>
      <div style="flex:1;"><div style="font-weight:700;font-size:13px;color:#fff;">${esc(m.name)}${isMe ? ' <span style="color:var(--color-blue);font-size:11px;">(You)</span>' : ''}${m.is_leader ? ' ★' : ''}</div>
      <div style="font-size:11px;color:var(--text-secondary);">${esc(sub)} · ${esc(m.role)}</div></div></div>`;
  }

  function renderRoster() {
    const box = $('joinedTeamRoster');
    if (!box) return;
    if (!S.room) {
      box.innerHTML = '<div style="font-size:12px;color:#64748b;">You are not in a room yet. Enter a 4-digit key, or create a new team.</div>';
      return;
    }
    box.innerHTML = `<div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;margin-bottom:8px;">Squad Members (Key: <span id="currentRoomKeyDisplay">${esc(S.room.code)}</span>)</div>` +
      S.members.map((m) => memberRowHtml(m, m.id === S.room.memberId, true)).join('');
  }

  const origRenderSquadList = window.renderSquadList;
  window.renderSquadList = function () {
    if (!S.room) { if (origRenderSquadList) origRenderSquadList(); return; }
    const c = $('squadMembersList');
    if (!c) return;
    c.innerHTML = S.members.map((m) => memberRowHtml(m, m.id === S.room.memberId, false)).join('') ||
      '<div style="font-size:12px;color:var(--text-secondary);padding:8px 0;">Waiting for teammates…</div>';
    c.querySelectorAll('.lt-row').forEach((row) => row.addEventListener('click', () => {
      const mk = S.markers[row.dataset.mid];
      if (mk) { map.flyTo(mk.getLatLng(), Math.max(map.getZoom(), 15)); mk.openPopup(); }
      else if (S.myPos && row.dataset.mid === S.room.memberId) map.flyTo([S.myPos.lat, S.myPos.lng], 15);
    }));
  };

  /* ------------------------- demo teammates (testing) --------------------- */
  async function startDemo() {
    if (!S.room) { toast('Create or join a room first, then add demo teammates.', 3500); return; }
    if (S.demo) { toast('Demo teammates are already walking.', 2500); return; }
    const r = S.room;
    const base = S.myPos ? [S.myPos.lat, S.myPos.lng] : [map.getCenter().lat, map.getCenter().lng];
    const bots = [
      { name: 'Demo Somdeb', role: 'Alpine Scout', lat: base[0] + 0.0004, lng: base[1] + 0.0003, heading: 40, step: 14, stopAfter: Infinity },
      { name: 'Demo Adrija', role: 'Rear Sweeper', lat: base[0] - 0.0006, lng: base[1] - 0.0004, heading: 220, step: 22, stopAfter: 75000 },
    ];
    try {
      for (const b of bots) {
        const res = await api('/api/rooms/join', { code: r.code, user: b.name, role: b.role });
        b.id = res.member_id; b.token = res.token;
      }
    } catch (e) { toast(`Could not add demo teammates: ${e.message}`, 4500); return; }
    const started = Date.now();
    const tick = () => {
      bots.forEach((b) => {
        if (Date.now() - started > b.stopAfter) return;          // goes "out of signal"
        b.heading += (Math.random() - 0.5) * 30;
        const rad = (b.heading * Math.PI) / 180;
        b.lat += (Math.cos(rad) * b.step) / 111320;
        b.lng += (Math.sin(rad) * b.step) / (111320 * Math.cos((b.lat * Math.PI) / 180));
        api(`/api/rooms/${r.code}/location`, {
          member_id: b.id, token: b.token, lat: b.lat, lng: b.lng, accuracy: 8, battery: 60 + Math.round(Math.random() * 30),
        }).catch(() => { });
      });
    };
    tick();
    S.demo = { bots, timer: setInterval(tick, 3000) };
    toast('2 demo teammates joined. Demo Adrija will go out of signal after ~75 s.', 5000);
    try { toggleMapModal(true); } catch (e) { /* ignore */ }
    try { closeWindow('roomModal'); } catch (e) { /* ignore */ }
  }
  function stopDemo() {
    if (!S.demo) return;
    clearInterval(S.demo.timer);
    const r = S.room;
    if (r) S.demo.bots.forEach((b) => api(`/api/rooms/${r.code}/leave`, { member_id: b.id, token: b.token }).catch(() => { }));
    S.demo = null;
  }

  /* ------------------ replace the old demo handlers ---------------------- */
  window.validatePinAuto = function () { /* joining happens on the button, not while typing */ };
  window.handleJoinSquadByPin = function () {
    const name = myName(($('ltJoinName') || {}).value);
    return joinRoom(readPin('pin'), name, 'Explorer');
  };
  window.handleCreateSquadRoom = function () {
    const name = myName(($('ltCreateName') || {}).value);
    const roleEl = $('newSquadRoleInput'), roomEl = $('newSquadNameInput');
    return createRoom({ name, role: roleEl ? roleEl.value : 'Expedition Leader', roomName: roomEl ? roomEl.value : '' });
  };
  window.wizardValidatePin = function () {
    return joinRoom(readPin('wPin'), myName(), 'Explorer');
  };
  window.wizardRollNewPin = function () {
    return createRoom({ name: myName(), role: 'Expedition Leader', roomName: currentExpeditionTrek ? `${currentExpeditionTrek.trekName} Squad` : 'TrekSOS Squad' });
  };

  // every real GPS fix -> also goes to the room
  const origUpdateGps = window.updateGpsPosition;
  window.updateGpsPosition = function (pos, fly) {
    origUpdateGps(pos, fly);
    onMyPosition(pos);
  };

  // SOS reaches the whole squad
  const origSOS = window.triggerSOS, origCancel = window.cancelSOS;
  window.triggerSOS = async function () {
    const out = await origSOS.apply(this, arguments);
    sendSos(true);
    return out;
  };
  window.cancelSOS = function () {
    const out = origCancel.apply(this, arguments);
    sendSos(false);
    return out;
  };
  async function sendSos(active) {
    const r = S.room;
    if (!r) return;
    try {
      const res = await api(`/api/rooms/${r.code}/sos`, {
        member_id: r.memberId, token: r.token, active,
        lat: S.myPos ? S.myPos.lat : undefined, lng: S.myPos ? S.myPos.lng : undefined,
      });
      applyRoom(res.room);
      if (active) toast('SOS sent to everyone in your squad room.', 4000);
    } catch (e) { handleSessionError(e); }
  }

  /* -------------------------------- boot ---------------------------------- */
  function boot() {
    injectStyles();
    patchRoomModal();
    renderRoster();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.room) schedulePoll(300); });
    // after a page refresh: silently rejoin the saved room
    const saved = loadRoom();
    if (saved && /^\d{4}$/.test(saved.code || '')) {
      api('/api/rooms/join', { code: saved.code, user: saved.name, role: saved.role, member_id: saved.memberId, token: saved.token })
        .then((res) => { enterRoom(res, saved.name, saved.role); toast(`Reconnected to room ${res.code}.`, 3000); })
        .catch(() => { try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.LiveTracking = { state: S, createRoom, joinRoom, leaveRoom, startDemo, fitSquad };
})();
