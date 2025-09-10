(function inject() {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('page_bridge.js');
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (e) { }
})();

const state = {
  enabled: false,
  mode: 'closed',
  plates: [],
  increment: 10,
  classicStep: 150,
  auctionId: null,
  endTime: null,
  bestBid: 0,
  bestBidTime: null,
  myBid: 0,
  bidTemplate: null,
  lastSeenJson: null,
  timer: null
};

// Centralized selectors for site DOM (easy to maintain)
const SELECTORS = {
  // Search page tab state
  searchTabActive: '[class*=SearchVehiclePanel_tabs-header__] [aria-selected="true"][role="tab"]',

  // Vehicle card structure
  cardFavouriteIcon: '[class*="VehicleCard_favouriteIcon__"]',
  cardUpper: '[class*="VehicleCard_upperCard__"]',
  cardPlate: '[class*="VehicleCard_licensePlate__"] [class*="VehicleCard_detailsLabel__"]',

  // Plate detection fallback on arbitrary pages
  plateDataAttr: '[data-plate]',

  // Login page (MUI-based)
  loginInputs: '.MuiFormControl-root input',
  loginStaySwitch: '.MuiSwitch-root',
  loginSubmitBtn: 'button[id=":r0:"]',

  // Builder for locale-specific login link presence on Favorites
  loginLink: (locale) => `[href="/${locale}/login"], [href="https://business.carbacar.it/${locale}/login"]`
};

function ui(p) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({ type: 'UI', ...p });
    }
  } catch (e) { /* ignore context invalidation */ }
}

function pickTimeField(obj) {
  const keys = Object.keys(obj || {});
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lk.includes('time') || lk.includes('date') || lk.includes('created') || lk === 'ts') {
      return obj[k];
    }
  }
  return null;
}

function scanJson(json) {
  if (!json) return;
  const d = json.data || json;
  let end = d?.newEndDate || d?.endTime || d?.end || d?.expiryDate || null;
  if (typeof end === 'string') state.endTime = end;
  if (d?._id) state.auctionId = d._id;
  if (d?.auctionId) state.auctionId = d.auctionId;
  const bids = d?.bids || d?.bets || d?.offers || d?.automaticBets || null;
  let maxPrice = state.bestBid;
  let maxTime = state.bestBidTime;
  if (Array.isArray(bids)) {
    for (const b of bids) {
      const p = +(b?.price ?? b?.amount ?? b?.bid ?? b?.assignedPrice ?? 0);
      if (p > maxPrice) {
        maxPrice = p;
        maxTime = pickTimeField(b);
      }
    }
  }
  if (typeof d?.assignedPrice === 'number' && d.assignedPrice > maxPrice) maxPrice = d.assignedPrice;
  if (maxPrice !== state.bestBid) {
    state.bestBid = maxPrice;
    ui({ bestBid: state.bestBid });
  }
  if (maxTime && maxTime !== state.bestBidTime) {
    state.bestBidTime = maxTime;
    try { ui({ bestBidTime: new Date(maxTime).toLocaleString() }); } catch { ui({ bestBidTime: String(maxTime) }); }
  }
  if (end) ui({ endTime: new Date(end).toLocaleString() });
  if (state.auctionId) ui({ auctionId: state.auctionId });
}

function maybeCaptureBid(url, method, bodyObj) {
  if (method !== 'POST') return;
  const u = url.toLowerCase();
  if (!(u.includes('bid') || u.includes('bet'))) return;
  let priceKey = null, auctionIdKey = null;
  if (bodyObj) {
    for (const k of Object.keys(bodyObj)) {
      const lk = k.toLowerCase();
      if (!priceKey && (lk.includes('price') || lk.includes('amount') || lk === 'value')) priceKey = k;
      if (!auctionIdKey && (lk.includes('auction') || lk.endsWith('id'))) auctionIdKey = k;
    }
  }
  if (priceKey && auctionIdKey) {
    state.bidTemplate = { url, bodyKeys: { priceKey, auctionIdKey }, sampleBody: bodyObj };
    ui({ status: 'Bid template captured' });
  }
}

// Helper: wait for an element to exist in the DOM
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const interval = 100;
    let elapsed = 0;

    const timer = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(timer);
        resolve(el);
      }
      elapsed += interval;
      if (elapsed >= timeout) {
        clearInterval(timer);
        reject(`Timeout waiting for ${selector}`);
      }
    }, interval);
  });
}

window.addEventListener("message", (ev) => {
  const d = ev.data || {};
  if (d.source !== "carbacar-bridge") return;

  if (d.name === "fetch" || d.name === "xhr") {
    const { url, json } = d.payload || {};
    state.lastSeenJson = json;

    try {
      if (typeof url === "string" && /getAuctionsByList/i.test(url)) {
        const { max, when } = highestBetFromAuctions(json);
        if (max !== null) {
          const mode = localStorage.getItem("carbacar_mode") || "closed";

          // callback-style storage read
          chrome.storage.sync.get(['classic_increament', 'closed_increament'], (store = {}) => {
            const classic_increament = Number(store.classic_increament ?? 150);
            const closed_increament  = Number(store.closed_increament  ?? 10);

            const increment = mode === "classic" ? classic_increament : closed_increament;
            const bidValue = max + increment;

            waitForElement("input.MuiInputBase-input", 5000)
              .then((input) => {
                setInputValue(input, bidValue);
                console.log(
                  `🔥 Mode: ${mode} | Highest bid ${max} + ${increment} = ${bidValue} filled into bid input`,
                  when ? `(at ${new Date(when).toLocaleString()})` : ""
                );
                localStorage.removeItem("carbacar_mode");
              })
              .catch(() => console.warn("⚠️ Bid input not found in time"));
          });
        } else {
          console.log("ℹ️ No bets found in getAuctionsByList response.");
        }
      }
    } catch (e) {
      console.warn("Failed to compute highest bid:", e);
    }
  }
});





function setInputValue(element, newValue) {
  if (!element) {
    console.warn("⚠️ No element provided to setInputValue");
    return;
  }

  // Focus element without scrolling
  element.focus({ preventScroll: true });

  // Select existing content and insert new value
  setTimeout(() => {
    document.execCommand("selectAll", false, undefined);

    setTimeout(() => {
      document.execCommand("insertText", false, String(newValue));

      // Fire React/MUI-friendly events
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    }, 250);
  }, 250);
}


function highestBetFromAuctions(resp) {
  const items = Array.isArray(resp?.data) ? resp.data : [];
  let max = -Infinity;
  let when = null;

  const pickNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (const item of items) {
    // regular bets
    for (const b of (item?.bets || [])) {
      const p = pickNum(b?.price);
      if (p !== null && p > max) {
        max = p;
        when = b?.timeStamp || null;
      }
    }

    // automatic bets
    for (const b of (item?.automaticBets || [])) {
      const p = pickNum(b?.price);
      if (p !== null && p > max) {
        max = p;
        when = b?.timeStamp || null;
      }
    }
  }

  return {
    max: (max === -Infinity) ? null : max,
    when
  };
}

function stop() {
  state.enabled = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  ui({ status: 'Stopped' });
}

async function start(cfg) {
  // Ensure login status once before starting any bidding logic
  try {
    if (!isLoginChecked()) {
      ui({ status: 'Ensuring login before start' });
      sessionStorage.setItem('carbacar_auto_login_flow', '1');
      const loc = detectLocale();
      location.href = buildUrl(loc, '/account/preferiti');
      return;
    }
  } catch { }
  Object.assign(state, cfg || {});
  // Plate gating: if user provided a list, ensure current page matches
  try {
    const pagePlate = detectPlate();
    if (Array.isArray(state.plates) && state.plates.length > 0) {
      if (!pagePlate) { ui({ status: 'No plate detected on page; idle' }); state.enabled = false; return; }
      const listed = state.plates.map(p => String(p).trim().toUpperCase());
      if (!listed.includes(pagePlate.toUpperCase())) { ui({ status: `Plate ${pagePlate} not in list; idle` }); state.enabled = false; return; }
    }
  } catch (e) { }
  state.enabled = true;
  ui({ status: `Running ${state.mode}` });
  loop();
}

function msUntilEnd() {
  if (!state.endTime) return null;
  const t = new Date(state.endTime).getTime();
  return t - Date.now();
}

function scheduleAt(msFromNow, fn) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(fn, Math.max(0, msFromNow));
}

function placeBid(targetPrice) {
  if (state.maxBid && targetPrice > state.maxBid) {
    ui({ status: `Max cap reached at ${state.maxBid}` });
    return;
  }
  if (!state.bidTemplate || !state.auctionId) {
    ui({ status: 'No bid template yet. Submit a test bid once.' });
    return;
  }
  const body = { ...state.bidTemplate.sampleBody };
  body[state.bidTemplate.bodyKeys.priceKey] = targetPrice;
  body[state.bidTemplate.bodyKeys.auctionIdKey] = state.auctionId;
  window.postMessage({ source: 'carbacar-extension', name: 'place-bid', payload: { url: state.bidTemplate.url, body } }, '*');
  state.myBid = targetPrice;
  ui({ myBid: state.myBid });
}

function loop() {
  if (!state.enabled) return;
  if (state.lastSeenJson) scanJson(state.lastSeenJson);
  const wait = +state.refresh || 1500;

  const ms = msUntilEnd();
  if (ms !== null) {
    if (state.mode === 'closed') {
      const offset = 2000; // 2 seconds
      const guard = 400;   // when to start precision scheduling
      const fudge = 50;    // fire ~50ms before target to account for latency
      if (ms > offset + guard) {
        scheduleAt(Math.min(wait, ms - (offset + guard)), loop);
        return;
      } else if (ms > fudge) {
        scheduleAt(Math.max(0, ms - offset + fudge), () => {
          const target = (state.bestBid || 0) + (state.increment || 10);
          placeBid(target);
          scheduleAt(800, loop);
        });
        return;
      }
    } else if (state.mode === 'classic') {
      const offset = 1000; // 1 second
      const guard = 400;
      const fudge = 50;
      if (ms > offset + guard) {
        scheduleAt(Math.min(wait, ms - (offset + guard)), loop);
        return;
      } else if (ms > fudge) {
        scheduleAt(Math.max(0, ms - offset + fudge), () => {
          const step = +state.classicStep || 150;
          const target = (state.bestBid || 0) + step;
          placeBid(target);
          scheduleAt(800, loop);
        });
        return;
      }
    }
  }
  scheduleAt(wait, loop);
}

function detectPlate() {
  try {
    const rx = /\b([A-Z]{2})\s?(\d{3})\s?([A-Z]{2})\b/; // e.g., EK128JW or EK 128 JW
    const txt = (document.querySelector(SELECTORS.plateDataAttr)?.textContent || document.body.innerText || '').toUpperCase();
    const m = txt.match(rx);
    if (m) return `${m[1]}${m[2]}${m[3]}`;
  } catch (e) { }
  return null;
}

async function autoLogin(creds) {
  try {
    // Persist creds if provided so the login page can read them
    if (creds && (creds.email || creds.password)) {
      try { await chrome.storage.sync.set({ email: creds.email || '', password: creds.password || '' }); } catch { }
    }
    // Arm the flow and start from Favorites page
    const loc = detectLocale();
    sessionStorage.setItem('carbacar_auto_login_flow', '1');
    location.href = buildUrl(loc, '/account/preferiti');
  } catch (e) { ui({ status: 'Auto-login init failed' }); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START') start(msg.config);
  if (msg.type === 'STOP') stop();
  if (msg.type === 'AUTO_LOGIN') autoLogin(msg.creds);
});

ui({ status: 'Content ready' });

// ===== Locale & login status helpers =====
function detectLocale() {
  try {
    const p = location.pathname || '/';
    if (p.startsWith('/it/')) return 'it';
    if (p.startsWith('/en/')) return 'en';
    const lang = (document.documentElement.lang || '').toLowerCase();
    if (lang.startsWith('it')) return 'it';
    if (lang.startsWith('en')) return 'en';
  } catch { }
  return 'en';
}
function buildUrl(locale, suffix) {
  const seg = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return `https://business.carbacar.it/${locale}/${seg}`;
}
function isLoginChecked() {
  try { return sessionStorage.getItem('carbacar_login_checked') === '1'; } catch { return false; }
}
function markLoginChecked() {
  try { sessionStorage.setItem('carbacar_login_checked', '1'); } catch { }
}

// ===== Auto Login Flow (per spec) =====
(function setupAutoLoginFlow() {
  const LOCALE = detectLocale();
  const FAVORITES_PATH = `/${LOCALE}/account/preferiti`;
  const LOGIN_URL = buildUrl(LOCALE, '/login');
  const FAVORITES_URL = buildUrl(LOCALE, '/account/preferiti');
  const SEARCH_URL = buildUrl(LOCALE, '/cerca');
  const FLOW_FLAG = 'carbacar_auto_login_flow';

  function onReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    }
  }

  function waitFor(selector, { timeout = 10000, interval = 100 } = {}) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - t0 > timeout) return reject(new Error('Timeout: ' + selector));
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  async function fillAndSubmitLogin() {
    try {
      const store = await chrome.storage.sync.get(['email', 'password']);
      const email = store.email || '';
      const password = store.password || '';
      if (!email || !password) {
        ui({ status: 'Missing email/password in extension settings' });
        return;
      }

      // Wait for MUI inputs, then fill using exact selectors
      await waitFor(SELECTORS.loginInputs);
      const inputs = document.querySelectorAll(SELECTORS.loginInputs);
      if (inputs[0]) {
        inputs[0].focus();
        inputs[0].value = email;
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (inputs[1]) {
        inputs[1].focus();
        inputs[1].value = password;
        inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Stay logged in switch
      try { document.querySelectorAll(SELECTORS.loginStaySwitch)[0]?.click(); } catch { }

      // Submit button using exact selector
      await waitFor(SELECTORS.loginSubmitBtn);
      const btn = document.querySelectorAll(SELECTORS.loginSubmitBtn)[0];
      if (btn) btn.click();

      // Wait 8 seconds to allow login to complete, then mark and go to search page
      setTimeout(() => {
        try { sessionStorage.removeItem(FLOW_FLAG); } catch { }
        markLoginChecked();
        location.href = SEARCH_URL;
      }, 8000);
      ui({ status: 'Login submitted; waiting 8s' });
    } catch (e) {
      ui({ status: 'Auto-login failed: ' + (e?.message || e) });
    }
  }

  function checkFavoritesForLogin() {
    // Look for element with href pointing to locale-specific login
    const link = document.querySelector(SELECTORS.loginLink(LOCALE));
    return !!link;
  }

  async function runAutoLoginIfArmed() {
    const armed = sessionStorage.getItem(FLOW_FLAG) === '1';
    if (!armed) return; // only run if initiated via popup

    // Normalize starting point: always go to Favorites first to check
    if (location.pathname !== FAVORITES_PATH && location.href !== LOGIN_URL) {
      location.href = FAVORITES_URL;
      return;
    }

    if (location.pathname === FAVORITES_PATH) {
      // Check if login is required by presence of href="/en/login"
      const start = Date.now();
      const tryCheck = () => {
        if (checkFavoritesForLogin()) {
          location.href = LOGIN_URL;
        } else if (Date.now() - start < 10000) {
          setTimeout(tryCheck, 300);
        } else {
          // No login link found; consider logged in
          sessionStorage.removeItem(FLOW_FLAG);
          markLoginChecked();
          ui({ status: 'Already logged in' });
          try { location.href = SEARCH_URL; } catch {}
        }
      };
      tryCheck();
      return;
    }

    if (location.href === LOGIN_URL) {
      fillAndSubmitLogin();
      return;
    }
  }

  onReady(() => {
    // Gate auto-login strictly by query param ?autoLogin=true
    const params = new URLSearchParams(location.search || '');
    const trigger = params.get('autoLogin') === 'true';

    if (trigger) {
      try { sessionStorage.setItem(FLOW_FLAG, '1'); } catch { }
      if (location.pathname !== FAVORITES_PATH && location.href !== LOGIN_URL) {
        location.href = FAVORITES_URL;
        return;
      }
    }
    // Only proceeds if FLOW_FLAG is set (either by the param above or via popup AUTO_LOGIN)
    runAutoLoginIfArmed();
  });
})();

// ===== Floating Menu on Search (/cerca) =====
(function setupFloatingMenu() {
  try {
    const path = location.pathname || '';
    // Show only on https://business.carbacar.it/{locale}/cerca
    const isSearch = /\/([a-z]{2})\/cerca$/.test(path) || path.endsWith('/cerca');
    if (!isSearch) return;

    const STYLES = `
      .ccb-float{position:fixed;bottom: 20px; width: 450px; left: 15.7%;transform:translateX(-50%);z-index:2147483000;background:#0f1220;color:#e6e9ff;border:1px solid #2d3358;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);font:14px/1.4 system-ui,Segoe UI,Roboto,Arial}
      .ccb-float header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #2d3358}
      .ccb-close{background:transparent;border:0;color:#9aa5ff;font-size:18px;cursor:pointer}
      .ccb-body{padding:10px 12px}
      .ccb-row{display:flex;gap:8px;align-items:center;margin:8px 0}
      .ccb-input{flex:1;padding:8px;border-radius:10px;border:1px solid #2d3358;background:#141832;color:#e6e9ff;outline:none}
      .ccb-btn{padding:10px 12px;border-radius:10px;border:1px solid #2d3358;background:#1a1f3d;color:#eef1ff;font-weight:700;cursor:pointer}
      .ccb-btn.primary{background:#2a3170;border-color:#4851c7}
      .ccb-btn.full{width:100%}
      .ccb-buttons{display:flex;flex-direction:column;gap:10px}
      .ccb-list{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
      .ccb-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 8px;border-radius:999px;background:#141832;border:1px solid #2d3358}
      .ccb-chip button{border:0;background:transparent;color:#9aa5ff;cursor:pointer}
      .ccb-accordion{margin-top:10px;border-top:1px solid #2d3358}
      .ccb-acc-header{display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:10px 0;color:#cbd5ff}
      .ccb-acc-header .arrow{transition:transform .2s ease}
      .ccb-acc-header.open .arrow{transform:rotate(90deg)}
      .ccb-acc-body{display:none;padding:10px 0;border-top:1px solid #2d3358}
      .ccb-acc-body.open{display:block}
      .ccb-section-title{margin:10px 0 6px;font-weight:700;color:#cbd5ff}
      /* automation button styling on cards */
      img.automation-btn{cursor:pointer; width:50px}
    `;

    function ensureStyle() {
      if (document.getElementById('ccb-float-style')) return;
      const st = document.createElement('style');
      st.id = 'ccb-float-style';
      st.textContent = STYLES;
      document.documentElement.appendChild(st);
    }

    const KEYS = { classic: 'classicPlates', envelope: 'envelopePlates' };

    async function getLists() {
      try { return await chrome.storage.sync.get([KEYS.classic, KEYS.envelope]); } catch { return {}; }
    }
    async function setList(kind, arr) {
      const key = KEYS[kind];
      const clean = (arr || []).map(s => String(s).trim().toUpperCase()).filter(Boolean);
      try { await chrome.storage.sync.set({ [key]: clean }); } catch { }
      return clean;
    }

    function renderChip(plate, kind) {
      const chip = document.createElement('span');
      chip.className = 'ccb-chip';
      const txt = document.createElement('span');
      txt.textContent = plate;
      const edit = document.createElement('button');
      edit.title = 'Edit';
      edit.textContent = '✎';
      const del = document.createElement('button');
      del.title = 'Remove';
      del.textContent = '×';
      chip.append(txt, edit, del);
      edit.addEventListener('click', async () => {
        const next = (prompt('Edit plate', plate) || '').toUpperCase().replace(/\s+/g, '');
        if (!next) return;
        const data = await getLists();
        const key = KEYS[kind];
        const list = (data[key] || []).slice();
        const idx = list.indexOf(plate);
        if (idx >= 0) { list[idx] = next; await setList(kind, list); chips[kind](); }
      });
      del.addEventListener('click', async () => {
        const data = await getLists();
        const key = KEYS[kind];
        const list = (data[key] || []).filter(p => p !== plate);
        await setList(kind, list); chips[kind]();
      });
      return chip;
    }

    const chips = { classic: () => { }, envelope: () => { } };

    function buildListSection(kind, title) {
      const section = document.createElement('div');
      const h = document.createElement('div');
      h.className = 'ccb-section-title';
      h.textContent = title;
      const listEl = document.createElement('div');
      listEl.className = 'ccb-list';
      const row = document.createElement('div');
      row.className = 'ccb-row';
      const input = document.createElement('input');
      input.className = 'ccb-input';
      input.placeholder = 'Add license plate (e.g., EK128JW)';
      const add = document.createElement('button');
      add.className = 'ccb-btn';
      add.textContent = 'Add';
      row.append(input, add);
      section.append(h, row, listEl);

      chips[kind] = async () => {
        listEl.innerHTML = '';
        const data = await getLists();
        const list = (data[KEYS[kind]] || []);
        list.forEach(p => listEl.appendChild(renderChip(p, kind)));
      };

      async function handleAdd() {
        const raw = (input.value || '').toUpperCase().replace(/\s+/g, '');
        if (!raw) return;
        const data = await getLists();
        const list = (data[KEYS[kind]] || []).slice();
        raw.split(/[,\n\s]+/).map(s => s.trim()).filter(Boolean).forEach(v => {
          const p = v.toUpperCase();
          if (!list.includes(p)) list.push(p);
        });
        await setList(kind, list);
        input.value = '';
        chips[kind]();
      }
      add.addEventListener('click', handleAdd);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdd(); });

      return { section, refresh: chips[kind] };
    }

    function mount() {
      ensureStyle();
      if (document.getElementById('ccb-float')) return; // already

      const wrap = document.createElement('div');
      wrap.id = 'ccb-float';
      wrap.className = 'ccb-float';

      const header = document.createElement('header');
      const title = document.createElement('div');
      title.textContent = 'Auction Tools';
      const close = document.createElement('button');
      close.className = 'ccb-close';
      close.textContent = '×';
      header.append(title, close);

      const body = document.createElement('div');
      body.className = 'ccb-body';

      // Top buttons only
      const buttonsWrap = document.createElement('div');
      buttonsWrap.className = 'ccb-buttons';

      const btnClassic = document.createElement('button');
      btnClassic.className = 'ccb-btn primary full';
      btnClassic.textContent = 'Start Processing Classic Bids';
      btnClassic.setAttribute('type', 'classic');


      const btnEnvelope = document.createElement('button');
      btnEnvelope.className = 'ccb-btn primary full';
      btnEnvelope.textContent = 'Start Processing Closed Envelop Bids';
      btnEnvelope.setAttribute('type', 'closed');

      buttonsWrap.append(btnClassic, btnEnvelope);

      // Accordion for managing lists
      const acc = document.createElement('div');
      acc.className = 'ccb-accordion';
      const accHeader = document.createElement('div');
      accHeader.className = 'ccb-acc-header';
      const accTitle = document.createElement('span');
      accTitle.textContent = 'Manage License Plates';
      const accArrow = document.createElement('span');
      accArrow.className = 'arrow';
      accArrow.textContent = '▶';
      accHeader.append(accTitle, accArrow);
      const accBody = document.createElement('div');
      accBody.className = 'ccb-acc-body';

      const classic = buildListSection('classic', 'Classic Auction');
      const envelope = buildListSection('envelope', 'Closed Envelope');
      accBody.append(classic.section, envelope.section);

      accHeader.addEventListener('click', () => {
        const open = !accBody.classList.contains('open');
        accBody.classList.toggle('open', open);
        accHeader.classList.toggle('open', open);
      });
      close.addEventListener('click', () => wrap.remove());

      acc.append(accHeader, accBody);
      body.append(buttonsWrap, acc);
      wrap.append(header, body);
      document.body.appendChild(wrap);

      // Wire start buttons to run the automation with stored config
      async function runWithMode(mode) {

        const store = await chrome.storage.sync.get([
          KEYS.classic,
          KEYS.envelope,
          'refresh',
          'increment',
          'classicStep',
          'maxBid'
        ]);

        const plates = mode === 'classic'
          ? (store[KEYS.classic] || [])
          : (store[KEYS.envelope] || []);

        console.log("Plates to open:", plates);

        // Open one tab per plate with query param
        plates.forEach((plate) => {
          const newUrl = `${window.location.origin}${window.location.pathname}?plate=${encodeURIComponent(plate)}`;
          chrome.runtime.sendMessage({
            action: "openTab",
            url: newUrl
          });
        });

        // Keep your start() logic
        start({
          mode,
          plates,
          increment: +(store.increment || 10),
          classicStep: +(store.classicStep || 150)
        });
      }



      btnClassic.addEventListener('click', () => {
        localStorage.setItem("carbacar_mode", "classic");
        runWithMode('classic');
      });

      btnEnvelope.addEventListener('click', () => {
        localStorage.setItem("carbacar_mode", "closed");
        runWithMode('closed');
      });


      // Load list data for accordion
      classic.refresh();
      envelope.refresh();

      // React to external updates (e.g., card automation button adds)
      document.addEventListener('ccb-lists-updated', (ev) => {
        const kind = ev.detail?.kind;
        if (kind === 'classic') classic.refresh();
        if (kind === 'envelope') envelope.refresh();
      });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      mount();
    } else {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    }
  } catch (e) { /* ignore UI errors */ }
})();

(function() {
  // helper: wait for element
  function waitForSelector(selector, timeout = 50000) {
    return new Promise((resolve, reject) => {
      const interval = 100;
      let elapsed = 0;

      const timer = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(timer);
          resolve(el);
        }
        elapsed += interval;
        if (elapsed >= timeout) {
          clearInterval(timer);
          reject(`Timeout waiting for ${selector}`);
        }
      }, interval);
    });
  }

  async function autoClickCard() {
    const params = new URLSearchParams(window.location.search);
    const plate = params.get("plate");
    if (!plate) return; // only run if a plate param exists

    try {
      const card = await waitForSelector(".VehicleCard_infoContainer__9bIyD", 50000);
      console.log("Clicking vehicle card for:", plate);
      card.click();
    } catch (err) {
      console.warn("No card found for plate:", plate, err);
    }
  }

  window.addEventListener("load", autoClickCard);
})();



// ===== Automation Button on Vehicle Cards =====
(function setupAutomationButtons() {
  try {
    const ORIG_ICON_SRC = 'https://cdn.iconscout.com/icon/free/png-256/free-automation-icon-svg-png-download-3709992.png';
    const OK_ICON_SRC = 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Eo_circle_green_white_checkmark.svg/768px-Eo_circle_green_white_checkmark.svg.png';

    const KEYS = { classic: 'classicPlates', envelope: 'envelopePlates' };

    function selectedSearchTab(img) {
      const parentDiv = img.closest('div[class^="VehicleCard_descriptionContainer"]');
      if (!parentDiv) return null;
      try {
        const el = parentDiv.querySelector('div[class^="AuctionLabel_component"]');
        if (!el) return null;
        if (el) {
            const childDiv = el.querySelector('div[class^="AuctionLabel_"]');
            
            if (childDiv) {
              const txt = childDiv.innerText.replace(/[^a-zA-Z ]/g, " ").trim();
              const lower = txt.toLowerCase();
              if (lower === 'classic auction' || lower.includes('classic')) return 'classic';
              if (lower === 'closed envelope' || lower.includes('closed')) return 'envelope';
              return null;
            }
        }
      } catch { return null; }
    }

    async function addPlate(kind, plate) {
      const store = await chrome.storage.sync.get([KEYS.classic, KEYS.envelope]);
      const key = KEYS[kind];
      const list = (store[key] || []).slice();
      const norm = String(plate || '').toUpperCase().replace(/\s+/g, '');
      if (!norm) return false;
      if (!list.includes(norm)) list.push(norm);
      await chrome.storage.sync.set({ [key]: list });
      return true;
    }

    function extractPlateFrom(btn) {
      try {
        const upper = btn.closest(SELECTORS.cardUpper);
        const label = upper?.querySelector(SELECTORS.cardPlate);
        const txt = (label?.textContent || '').trim();
        return txt.toUpperCase().replace(/\s+/g, '');
      } catch { return '' }
    }

    function handleClick(img) {
      return async () => {
        const plate = extractPlateFrom(img);
        const kind = selectedSearchTab(img);
        if (!plate || !kind) {
          try {
            img.title = !plate ? 'Plate not found on card' : 'Cannot detect search tab';
          } catch { }
          return;
        }

        const ok = await addPlate(kind, plate);
        if (ok) {
          // Keep icon permanent after success
          img.src = OK_ICON_SRC;
          img.title = 'Added for Automation';
          try { 
            document.dispatchEvent(new CustomEvent('ccb-lists-updated', { detail: { kind } })); 
          } catch { }
        }
      };
    }


    function enhanceOnce(icon) {
      if (icon.dataset.ccbEnhanced === '1') return;
      icon.dataset.ccbEnhanced = '1';
      const img = document.createElement('img');
      img.className = 'automation-btn';
      img.src = ORIG_ICON_SRC;
      img.title = 'Add For Automation';
      img.style.marginLeft = '6px';
      img.style.height = "50"
      img.style.width = "50"
      img.addEventListener('click', handleClick(img));
      icon.insertAdjacentElement('afterend', img);
    }

    function scan() {
      document.querySelectorAll(SELECTORS.cardFavouriteIcon).forEach(enhanceOnce);
    }

    // Initial and observe mutations for dynamic lists
    if (document.readyState === 'complete' || document.readyState === 'interactive') scan();
    else document.addEventListener('DOMContentLoaded', scan, { once: true });

    const mo = new MutationObserver(() => scan());
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* swallow */ }
})();
