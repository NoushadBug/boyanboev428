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
    const email = document.querySelector('input[type="email"], input[name="email"], input[name="username"]');
    const pass = document.querySelector('input[type="password"]');
    const btn = document.querySelector('button[type="submit"], button[name="login"], [data-testid="login-submit"]');
    if(email){ email.value = creds.email || ''; email.dispatchEvent(new Event('input',{bubbles:true})); }
    if(pass){ pass.value = creds.password || ''; pass.dispatchEvent(new Event('input',{bubbles:true})); }
    if(btn) btn.click();
  }catch(e){}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg.type==='START') start(msg.config);
  if(msg.type==='STOP') stop();
  if(msg.type==='AUTO_LOGIN') autoLogin(msg.creds);
});

ui({status:'Content ready'});
