(function inject(){
  try{
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('page_bridge.js');
    (document.head||document.documentElement).appendChild(s);
    s.onload = ()=> s.remove();
  }catch(e){}
})();

const state = {
  enabled: false,
  mode: 'closed',
  plates: [],
  refresh: 1500,
  increment: 10,
  classicStep: 150,
  maxBid: 0,
  auctionId: null,
  endTime: null,
  bestBid: 0,
  bestBidTime: null,
  myBid: 0,
  bidTemplate: null,
  lastSeenJson: null,
  timer: null
};

function ui(p){ chrome.runtime.sendMessage({type:'UI', ...p}); }

function pickTimeField(obj){
  const keys = Object.keys(obj||{});
  for(const k of keys){
    const lk = k.toLowerCase();
    if(lk.includes('time') || lk.includes('date') || lk.includes('created') || lk==='ts'){
      return obj[k];
    }
  }
  return null;
}

function scanJson(json){
  if(!json) return;
  const d = json.data || json;
  let end = d?.newEndDate || d?.endTime || d?.end || d?.expiryDate || null;
  if(typeof end === 'string') state.endTime = end;
  if(d?._id) state.auctionId = d._id;
  if(d?.auctionId) state.auctionId = d.auctionId;
  const bids = d?.bids || d?.bets || d?.offers || d?.automaticBets || null;
  let maxPrice = state.bestBid;
  let maxTime = state.bestBidTime;
  if(Array.isArray(bids)){
    for(const b of bids){
      const p = +(b?.price ?? b?.amount ?? b?.bid ?? b?.assignedPrice ?? 0);
      if(p > maxPrice){
        maxPrice = p;
        maxTime = pickTimeField(b);
      }
    }
  }
  if(typeof d?.assignedPrice === 'number' && d.assignedPrice > maxPrice) maxPrice = d.assignedPrice;
  if(maxPrice !== state.bestBid){
    state.bestBid = maxPrice;
    ui({bestBid: state.bestBid});
  }
  if(maxTime && maxTime !== state.bestBidTime){
    state.bestBidTime = maxTime;
    try{ ui({bestBidTime: new Date(maxTime).toLocaleString()}); }catch{ ui({bestBidTime: String(maxTime)}); }
  }
  if(end) ui({endTime: new Date(end).toLocaleString()});
  if(state.auctionId) ui({auctionId: state.auctionId});
}

function maybeCaptureBid(url, method, bodyObj){
  if(method !== 'POST') return;
  const u = url.toLowerCase();
  if(!(u.includes('bid') || u.includes('bet'))) return;
  let priceKey = null, auctionIdKey = null;
  if(bodyObj){
    for(const k of Object.keys(bodyObj)){
      const lk = k.toLowerCase();
      if(!priceKey && (lk.includes('price') || lk.includes('amount') || lk==='value')) priceKey = k;
      if(!auctionIdKey && (lk.includes('auction') || lk.endsWith('id'))) auctionIdKey = k;
    }
  }
  if(priceKey && auctionIdKey){
    state.bidTemplate = {url, bodyKeys:{priceKey, auctionIdKey}, sampleBody: bodyObj};
    ui({status:'Bid template captured'});
  }
}

window.addEventListener('message',(ev)=>{
  const d = ev.data || {};
  if(d.source !== 'carbacar-bridge') return;
  if(d.name==='fetch' || d.name==='xhr'){
    const {url, method, body, json} = d.payload || {};
    state.lastSeenJson = json;
    scanJson(json);
    let bodyObj = null;
    try{ bodyObj = typeof body === 'string' ? JSON.parse(body) : body; }catch{}
    maybeCaptureBid(url, method, bodyObj);
  }else if(d.name==='bid-result'){
    ui({status: d.payload?.ok ? 'Bid OK' : 'Bid Failed'});
  }
});

function stop(){
  state.enabled = false;
  if(state.timer){ clearTimeout(state.timer); state.timer = null; }
  ui({status:'Stopped'});
}

async function start(cfg){
  // Ensure login status once before starting any bidding logic
  try{
    if(!isLoginChecked()){
      ui({status:'Ensuring login before start'});
      sessionStorage.setItem('carbacar_auto_login_flow','1');
      const loc = detectLocale();
      location.href = buildUrl(loc, '/account/preferiti');
      return;
    }
  }catch{}
  Object.assign(state, cfg||{});
  // Plate gating: if user provided a list, ensure current page matches
  try{
    const pagePlate = detectPlate();
    if(Array.isArray(state.plates) && state.plates.length>0){
      if(!pagePlate){ ui({status:'No plate detected on page; idle'}); state.enabled=false; return; }
      const listed = state.plates.map(p=>String(p).trim().toUpperCase());
      if(!listed.includes(pagePlate.toUpperCase())){ ui({status:`Plate ${pagePlate} not in list; idle`}); state.enabled=false; return; }
    }
  }catch(e){}
  state.enabled = true;
  ui({status:`Running ${state.mode}`});
  loop();
}

function msUntilEnd(){
  if(!state.endTime) return null;
  const t = new Date(state.endTime).getTime();
  return t - Date.now();
}

function scheduleAt(msFromNow, fn){
  if(state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(fn, Math.max(0, msFromNow));
}

function placeBid(targetPrice){
  if(state.maxBid && targetPrice > state.maxBid){
    ui({status:`Max cap reached at ${state.maxBid}`});
    return;
  }
  if(!state.bidTemplate || !state.auctionId){
    ui({status:'No bid template yet. Submit a test bid once.'});
    return;
  }
  const body = {...state.bidTemplate.sampleBody};
  body[state.bidTemplate.bodyKeys.priceKey] = targetPrice;
  body[state.bidTemplate.bodyKeys.auctionIdKey] = state.auctionId;
  window.postMessage({source:'carbacar-extension', name:'place-bid', payload:{url: state.bidTemplate.url, body}}, '*');
  state.myBid = targetPrice;
  ui({myBid: state.myBid});
}

function loop(){
  if(!state.enabled) return;
  if(state.lastSeenJson) scanJson(state.lastSeenJson);
  const wait = +state.refresh || 1500;

  const ms = msUntilEnd();
  if(ms !== null){
    if(state.mode==='closed'){
      const offset = 2000; // 2 seconds
      const guard = 400;   // when to start precision scheduling
      const fudge = 50;    // fire ~50ms before target to account for latency
      if(ms > offset + guard){
        scheduleAt(Math.min(wait, ms - (offset + guard)), loop);
        return;
      } else if(ms > fudge){
        scheduleAt(Math.max(0, ms - offset + fudge), ()=>{
          const target = (state.bestBid||0) + (state.increment||10);
          placeBid(target);
          scheduleAt(800, loop);
        });
        return;
      }
    } else if(state.mode==='classic'){
      const offset = 1000; // 1 second
      const guard = 400;
      const fudge = 50;
      if(ms > offset + guard){
        scheduleAt(Math.min(wait, ms - (offset + guard)), loop);
        return;
      } else if(ms > fudge){
        scheduleAt(Math.max(0, ms - offset + fudge), ()=>{
          const step = +state.classicStep || 150;
          const target = (state.bestBid||0) + step;
          placeBid(target);
          scheduleAt(800, loop);
        });
        return;
      }
    }
  }
  scheduleAt(wait, loop);
}

function detectPlate(){
  try{
    const rx = /\b([A-Z]{2})\s?(\d{3})\s?([A-Z]{2})\b/; // e.g., EK128JW or EK 128 JW
    const txt = (document.querySelector('[data-plate]')?.textContent || document.body.innerText || '').toUpperCase();
    const m = txt.match(rx);
    if(m) return `${m[1]}${m[2]}${m[3]}`;
  }catch(e){}
  return null;
}

async function autoLogin(creds){
  try{
    // Persist creds if provided so the login page can read them
    if(creds && (creds.email || creds.password)){
      try{ await chrome.storage.sync.set({email: creds.email||'', password: creds.password||''}); }catch{}
    }
    // Arm the flow and start from Favorites page
    const loc = detectLocale();
    sessionStorage.setItem('carbacar_auto_login_flow','1');
    location.href = buildUrl(loc, '/account/preferiti');
  }catch(e){ ui({status:'Auto-login init failed'}); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg.type==='START') start(msg.config);
  if(msg.type==='STOP') stop();
  if(msg.type==='AUTO_LOGIN') autoLogin(msg.creds);
});

ui({status:'Content ready'});

// ===== Locale & login status helpers =====
function detectLocale(){
  try{
    const p = location.pathname || '/';
    if(p.startsWith('/it/')) return 'it';
    if(p.startsWith('/en/')) return 'en';
    const lang = (document.documentElement.lang||'').toLowerCase();
    if(lang.startsWith('it')) return 'it';
    if(lang.startsWith('en')) return 'en';
  }catch{}
  return 'en';
}
function buildUrl(locale, suffix){
  const seg = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return `https://business.carbacar.it/${locale}/${seg}`;
}
function isLoginChecked(){
  try{ return sessionStorage.getItem('carbacar_login_checked') === '1'; }catch{ return false; }
}
function markLoginChecked(){
  try{ sessionStorage.setItem('carbacar_login_checked','1'); }catch{}
}

// ===== Auto Login Flow (per spec) =====
(function setupAutoLoginFlow(){
  const LOCALE = detectLocale();
  const FAVORITES_PATH = `/${LOCALE}/account/preferiti`;
  const LOGIN_URL = buildUrl(LOCALE, '/login');
  const FAVORITES_URL = buildUrl(LOCALE, '/account/preferiti');
  const SEARCH_URL = buildUrl(LOCALE, '/cerca');
  const FLOW_FLAG = 'carbacar_auto_login_flow';

  function onReady(fn){
    if(document.readyState === 'complete' || document.readyState === 'interactive'){
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn, {once:true});
    }
  }

  function waitFor(selector, {timeout=10000, interval=100}={}){
    return new Promise((resolve, reject)=>{
      const t0 = Date.now();
      const tick = ()=>{
        const el = document.querySelector(selector);
        if(el) return resolve(el);
        if(Date.now() - t0 > timeout) return reject(new Error('Timeout: '+selector));
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  async function fillAndSubmitLogin(){
    try{
      const store = await chrome.storage.sync.get(['email','password']);
      const email = store.email || '';
      const password = store.password || '';
      if(!email || !password){
        ui({status:'Missing email/password in extension settings'});
        return;
      }

      // Wait for MUI inputs, then fill using exact selectors
      await waitFor('.MuiFormControl-root input');
      const inputs = document.querySelectorAll('.MuiFormControl-root input');
      if(inputs[0]){
        inputs[0].focus();
        inputs[0].value = email;
        inputs[0].dispatchEvent(new Event('input', {bubbles:true}));
        inputs[0].dispatchEvent(new Event('change', {bubbles:true}));
      }
      if(inputs[1]){
        inputs[1].focus();
        inputs[1].value = password;
        inputs[1].dispatchEvent(new Event('input', {bubbles:true}));
        inputs[1].dispatchEvent(new Event('change', {bubbles:true}));
      }

      // Stay logged in switch
      try{ document.querySelectorAll('.MuiSwitch-root')[0]?.click(); }catch{}

      // Submit button using exact selector
      await waitFor('button[id=":r0:"]');
      const btn = document.querySelectorAll('button[id=":r0:"]')[0];
      if(btn) btn.click();

      // Wait 8 seconds to allow login to complete, then mark and go to search page
      setTimeout(()=>{
        try{ sessionStorage.removeItem(FLOW_FLAG); }catch{}
        markLoginChecked();
        location.href = SEARCH_URL;
      }, 8000);
      ui({status:'Login submitted; waiting 8s'});
    }catch(e){
      ui({status:'Auto-login failed: '+(e?.message||e)});
    }
  }

  function checkFavoritesForLogin(){
    // Look for element with href pointing to locale-specific login
    const link = document.querySelector(`[href="/${LOCALE}/login"], [href="https://business.carbacar.it/${LOCALE}/login"]`);
    return !!link;
  }

  async function runAutoLoginIfArmed(){
    const armed = sessionStorage.getItem(FLOW_FLAG) === '1';
    if(!armed) return; // only run if initiated via popup

    // Normalize starting point: always go to Favorites first to check
    if(location.pathname !== FAVORITES_PATH && location.href !== LOGIN_URL){
      location.href = FAVORITES_URL;
      return;
    }

    if(location.pathname === FAVORITES_PATH){
      // Check if login is required by presence of href="/en/login"
      const start = Date.now();
      const tryCheck = ()=>{
        if(checkFavoritesForLogin()){
          location.href = LOGIN_URL;
        } else if(Date.now() - start < 10000) {
          setTimeout(tryCheck, 300);
        } else {
          // No login link found; consider logged in
          sessionStorage.removeItem(FLOW_FLAG);
          markLoginChecked();
          ui({status:'Already logged in'});
        }
      };
      tryCheck();
      return;
    }

    if(location.href === LOGIN_URL){
      fillAndSubmitLogin();
      return;
    }
  }

  onReady(()=>{
    // Always ensure login the first time this tab loads the site
    if(!isLoginChecked()){
      try{ sessionStorage.setItem(FLOW_FLAG,'1'); }catch{}
      if(location.pathname !== FAVORITES_PATH && location.href !== LOGIN_URL){
        location.href = FAVORITES_URL;
        return;
      }
    }
    runAutoLoginIfArmed();
  });
})();
