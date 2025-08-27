(()=>{
  const ORIG_FETCH = window.fetch;
  const ORIG_XHR = window.XMLHttpRequest;

  function post(name, payload){
    window.postMessage({source:'carbacar-bridge', name, payload}, '*');
  }

  window.fetch = async function(input, init={}){
    const res = await ORIG_FETCH(input, init);
    try {
      const url = (typeof input==='string')? input : input.url;
      const clone = res.clone();
      const t = res.headers.get('content-type')||'';
      if(t.includes('application/json')){
        const json = await clone.json();
        post('fetch', {url, method:(init?.method||'GET'), body:init?.body||null, json});
      }
    } catch(e){}
    return res;
  };

  class X extends ORIG_XHR{
    constructor(){ super(); this._url=''; this._method='GET'; this._body=null; }
    open(m,u,...rest){ this._method=m; this._url=u; return super.open(m,u,...rest); }
    send(b){ this._body=b; this.addEventListener('load', ()=>{
      try{
        const t = this.getResponseHeader('content-type')||'';
        if(t.includes('application/json')){
          const json = JSON.parse(this.responseText);
          post('xhr', {url:this._url, method:this._method, body:this._body, json});
        }
      }catch(e){}
    }); return super.send(b); }
  }
  window.XMLHttpRequest = X;

  window.addEventListener('message', async(ev)=>{
    const d = ev.data || {};
    if(d?.source!=='carbacar-extension') return;
    if(d?.name==='place-bid'){
      try{
        const resp = await ORIG_FETCH(d.payload.url, {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify(d.payload.body),
          credentials: 'include'
        });
        const j = await resp.json();
        post('bid-result', {ok: resp.ok, json: j});
      }catch(err){
        post('bid-result', {ok:false, error:String(err)});
      }
    }
  });
})();
