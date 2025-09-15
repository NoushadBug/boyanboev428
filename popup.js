const qs = s=>document.querySelector(s);
const qsa = s=>Array.from(document.querySelectorAll(s));
const badge = qs('#badge');
const statusEl = qs('#status');
const fields = ['email','password','classic_increament','closed_increament','fetchtime_offset','clicktime_offset'];
const getMode = () => {
  const activeBtn = document.querySelector('.list-tab.active');
  return activeBtn ? activeBtn.getAttribute('data-kind') : null;
};

const KEYS = { classic: 'classicPlates', envelope: 'envelopePlates' };
const chipsEls = { classic: qs('#chips-classic'), envelope: qs('#chips-envelope') };
const inputEls = { classic: qs('#plate-input-classic'), envelope: qs('#plate-input-envelope') };

async function getLists(){
  try{ return await chrome.storage.sync.get([KEYS.classic, KEYS.envelope]); }catch{ return {}; }
}
async function setList(kind, arr){
  const key = KEYS[kind];
  const clean = (arr||[]).map(s=>String(s).trim().toUpperCase()).filter(Boolean);
  try{ await chrome.storage.sync.set({[key]: clean}); }catch{}
  return clean;
}

function chip(plate, kind){
  const el = document.createElement('span');
  el.className = 'chip';
  const txt = document.createElement('span');
  txt.textContent = plate;
  const edit = document.createElement('button');
  edit.title = 'Edit'; edit.textContent = '✎';
  const del = document.createElement('button');
  del.title = 'Remove'; del.textContent = '×';
  edit.addEventListener('click', async () => {
    const next = (prompt('Edit plate', plate) || '').toUpperCase().replace(/\s+/g, '');
    if (!next) return;

    const store = await getLists();
    const list = (store[KEYS[kind]] || []).slice();
    const idx = list.indexOf(plate);
    if (idx >= 0) {
      list[idx] = next;
      await setList(kind, list);
      render(kind);

      // Update content.js chip
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: (oldPlate, newPlate) => {
              const chipSpan = Array.from(document.querySelectorAll('.ccb-chip span'))
                .find(s => s.textContent === oldPlate);
              if (chipSpan) chipSpan.textContent = newPlate;
            },
            args: [plate, next]
          });
        });
    }
  });

  del.addEventListener('click', async () => {
    const store = await getLists();
    const list = (store[KEYS[kind]] || []).filter(p => p !== plate);
    await setList(kind, list);
    render(kind);

    // Remove content.js chip
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: (plateText) => {
          const chip = Array.from(document.querySelectorAll('.ccb-chip span'))
            .find(s => s.textContent === plateText);
          if (chip && chip.parentElement) chip.parentElement.remove();
        },
        args: [plate]
      });
    });
  });

  el.append(txt, edit, del);
  return el;
}

async function render(kind){
  const target = chipsEls[kind];
  if(!target) return;
  target.innerHTML = '';
  const store = await getLists();
  (store[KEYS[kind]]||[]).forEach(p=> target.appendChild(chip(p, kind)) );
}

async function addPlate(kind){
  const input = inputEls[kind];
  const raw = (input.value||'').toUpperCase().replace(/\s+/g,'');
  if(!raw) return;
  const store = await getLists();
  const list = (store[KEYS[kind]]||[]).slice();
  raw.split(/[,\n\s]+/).map(s=>s.trim()).filter(Boolean).forEach(v=>{
    const p = v.toUpperCase();
    if(!list.includes(p)) list.push(p);
  });
  await setList(kind, list);
  input.value = '';
  render(kind);
}

const load = async()=>{
  const data = await chrome.storage.sync.get(fields.concat(['mode', KEYS.classic, KEYS.envelope]));
  fields.forEach(k=>{ if(data[k]!==undefined) qs('#'+k).value = data[k]; });
  if (data.mode) {
    const modeEl = document.querySelector(`input[name="mode"][value="${data.mode}"]`);
    if (modeEl) modeEl.checked = true;
  }
  await Promise.all([render('classic'), render('envelope')]);
  updateBadge('idle');
};
load();

function updateBadge(t){ badge.textContent = t; }

qs('#save').addEventListener('click', async()=>{
  const mode = getMode();
  const payload = {mode};
  fields.forEach(k=>payload[k]=qs('#'+k).value);
  await chrome.storage.sync.set(payload);
  updateBadge('saved');
  setTimeout(()=>updateBadge('idle'),900);
});

qs('#autologin').addEventListener('click', async()=>{
  const {email,password}=await chrome.storage.sync.get(['email','password']);
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  chrome.tabs.sendMessage(tab.id, {type:'AUTO_LOGIN', creds:{email,password}});
});



chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==='UI'){
    if(msg.status) statusEl.textContent = msg.status;
    if(msg.auctionId) document.querySelector('#auctionId').textContent = msg.auctionId;
    if(msg.endTime) document.querySelector('#endTime').textContent = msg.endTime;
    if(msg.bestBid!==undefined) document.querySelector('#bestBid').textContent = msg.bestBid;
    if(msg.bestBidTime) document.querySelector('#bestBidTime').textContent = msg.bestBidTime;
    if(msg.myBid!==undefined) document.querySelector('#myBid').textContent = msg.myBid;
  }
});

// Tab switching
qsa('.list-tab').forEach(btn=>btn.addEventListener('click', (e)=>{
  const kind = e.currentTarget.getAttribute('data-kind');
  qsa('.list-tab').forEach(b=>b.classList.toggle('active', b===e.currentTarget));
  qsa('.list-body').forEach(p=> p.classList.toggle('hidden', p.getAttribute('data-panel')!==kind));
}));

// Add buttons and input enter
qsa('.list-add').forEach(btn=> btn.addEventListener('click', ()=> addPlate(btn.getAttribute('data-kind'))));
Object.entries(inputEls).forEach(([kind, input])=>{
  input.addEventListener('keydown', (e)=>{ if(e.key==='Enter') addPlate(kind); });
});

// Local start buttons: just alerts (per request)
// Classic
qs('#start-classic-local').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        document.querySelector("#ccb-float > div > div.ccb-buttons > button:nth-child(1)")?.click();
      }
    });
  });
});

// Envelope
qs('#start-envelope-local').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        document.querySelector("#ccb-float > div > div.ccb-buttons > button:nth-child(2)")?.click();
      }
    });
  });
});


