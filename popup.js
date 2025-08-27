const qs = s=>document.querySelector(s);
const badge = qs('#badge');
const statusEl = qs('#status');
const fields = ['email','password','plate','refresh','increment','maxBid'];
const getMode = ()=>document.querySelector('input[name="mode"]:checked').value;

const load = async()=>{
  const data = await chrome.storage.sync.get(fields.concat(['mode']));
  fields.forEach(k=>{ if(data[k]!==undefined) qs('#'+k).value = data[k]; });
  if(data.mode) document.querySelector(`input[name="mode"][value="${data.mode}"]`).checked = true;
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

qs('#start').addEventListener('click', async()=>{
  const mode = getMode();
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  const store = await chrome.storage.sync.get(null);
  chrome.tabs.sendMessage(tab.id, {type:'START', config:{
    mode,
    plate: store.plate||'',
    refresh: +(store.refresh||1500),
    increment: +(store.increment||10),
    maxBid: +(store.maxBid||0)
  }});
  updateBadge('running');
});

qs('#stop').addEventListener('click', async()=>{
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  chrome.tabs.sendMessage(tab.id, {type:'STOP'});
  updateBadge('idle');
});

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==='UI'){
    if(msg.status) statusEl.textContent = msg.status;
    if(msg.auctionId) document.querySelector('#auctionId').textContent = msg.auctionId;
    if(msg.endTime) document.querySelector('#endTime').textContent = msg.endTime;
    if(msg.bestBid!==undefined) document.querySelector('#bestBid').textContent = msg.bestBid;
    if(msg.myBid!==undefined) document.querySelector('#myBid').textContent = msg.myBid;
  }
});
