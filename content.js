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
  plate: '',
  refresh: 1500,
  increment: 10,
  maxBid: 0,
  auctionId: null,
  endTime: null,
  bestBid: 0,
  myBid: 0,
  bidTemplate: null,
  lastSeenJson: null,
  timer: null
};

function ui(p){ chrome.runtime.sendMessage({type:'UI', ...p}); }

function scanJson(json){
  if(!json) return;
  const d = json.data || json;
  let end = d?.newEndDate || d?.endTime || d?.end || d?.expiryDate || null;
  if(typeof end === 'string') state.endTime = end;
  if(d?._id) state.auctionId = d._id;
  if(d?.auctionId) state.auctionId = d.auctionId;
  const bids = d?.bids || d?.bets || d?.offers || d?.automaticBets || null;
  let maxPrice = state.bestBid;
  if(Array.isArray(bids)){
    for(const b of bids){
      const p = +(b?.price ?? b?.amount ?? b?.bid ?? b?.assignedPrice ?? 0);
      if(p > maxPrice) maxPrice = p;
    }
  }
  if(typeof d?.assignedPrice === 'number' && d.assignedPrice > maxPrice) maxPrice = d.assignedPrice;
  if(maxPrice !== state.bestBid){
    state.bestBid = maxPrice;
    ui({bestBid: state.bestBid});
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

  if(state.mode==='classic'){
    const ms = msUntilEnd();
    if(ms !== null){
      if(ms <= 1200 && ms > 200){
        scheduleAt(ms - 180, ()=>{
          const target = Math.max(state.bestBid, 0) + 10;
          placeBid(target);
          scheduleAt(800, loop);
        });
        return;
      }
    }
  }else if(state.mode==='closed'){
    const ms = msUntilEnd();
    if(ms !== null){
      if(ms <= 2100 && ms > 400){
        scheduleAt(ms - 400, ()=>{
          const target = (state.bestBid||0) + (state.increment||10);
          placeBid(target);
          scheduleAt(800, loop);
        });
        return;
      }
    }
  }
  scheduleAt(wait, loop);
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
