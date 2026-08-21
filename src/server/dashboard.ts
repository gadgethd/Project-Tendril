export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Project Tendril</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#08110e; color:#dff7e9; }
    * { box-sizing:border-box } body { margin:0; min-height:100vh; background:radial-gradient(circle at 20% 0,#143426,#08110e 45%); }
    header { display:flex; align-items:center; justify-content:space-between; padding:18px 24px; border-bottom:1px solid #27513d; background:#09130fcc; position:sticky; top:0; backdrop-filter:blur(12px); }
    h1 { margin:0; font-size:20px; letter-spacing:.04em } .brand { color:#73e6a6 } .status { font:12px ui-monospace,monospace; color:#8eb6a0 }
    main { display:grid; grid-template-columns:310px minmax(0,1fr); gap:16px; padding:16px; }
    .panel { border:1px solid #254b39; border-radius:12px; background:#0d1b15e8; overflow:hidden; box-shadow:0 12px 40px #0005; }
    .panel h2 { font-size:13px; text-transform:uppercase; letter-spacing:.12em; margin:0; padding:13px 15px; border-bottom:1px solid #254b39; color:#8ed9ad; }
    .body { padding:14px } input,select,button,textarea { font:inherit; color:inherit; background:#0a1511; border:1px solid #35644d; border-radius:7px; padding:9px 10px; }
    button { cursor:pointer; background:#174c34; border-color:#2e8a5d } button:hover { background:#206342 } button.secondary { background:#14251d }
    .row { display:flex; gap:8px; margin-bottom:10px } .row input { flex:1; min-width:0 } .stack { display:grid; gap:8px }
    .session { padding:10px; border:1px solid #244735; border-radius:8px; cursor:pointer } .session.active { border-color:#64d797; background:#112b20 }
    .session code { font-size:11px; color:#8eb6a0 } .workspace { display:grid; grid-template-rows:auto minmax(300px,55vh) minmax(160px,1fr); min-width:0; }
    .toolbar { padding:12px; border-bottom:1px solid #254b39 } .preview { display:grid; grid-template-columns:1fr 1fr; min-height:0 }
    .preview > * { min-width:0; overflow:auto; border-right:1px solid #254b39 } img { max-width:100%; display:block; margin:auto; }
    pre { margin:0; padding:14px; white-space:pre-wrap; overflow-wrap:anywhere; color:#c8e7d5; font:12px/1.55 ui-monospace,monospace; }
    .logs { border-top:1px solid #254b39; overflow:auto } .muted { color:#789887; font-size:12px } .error { color:#ff9d9d }
    @media(max-width:850px){ main{grid-template-columns:1fr}.preview{grid-template-columns:1fr}.workspace{grid-template-rows:auto auto auto} }
  </style>
</head>
<body>
<header><h1><span class="brand">Project Tendril</span> / local browser</h1><span id="status" class="status">connecting</span></header>
<main>
  <aside class="panel"><h2>Sessions</h2><div class="body stack"><button id="create">New isolated session</button><div id="sessions" class="stack"></div></div></aside>
  <section class="panel workspace">
    <div class="toolbar"><div class="row"><input id="url" value="https://example.com" aria-label="URL"><button id="go">Navigate</button><button id="snap" class="secondary">Snapshot</button><button id="shot" class="secondary">Screenshot</button><button id="challenge" class="secondary">Challenge</button></div><div class="row"><input id="query" placeholder="Search the web"><button id="search">Search</button></div></div>
    <div class="preview"><pre id="output">Create a session to begin.</pre><div id="image"></div></div>
    <pre id="logs" class="logs muted">Tendril runs entirely on this machine. Page output is untrusted.</pre>
  </section>
</main>
<script type="module">
const state={token:new URLSearchParams(location.hash.slice(1)).get('token')||sessionStorage.getItem('tendril-token'),session:null};
if(state.token)sessionStorage.setItem('tendril-token',state.token); history.replaceState(null,'',location.pathname);
const $=id=>document.getElementById(id); const headers=()=>({'content-type':'application/json','authorization':'Bearer '+state.token});
async function api(path,options={}){const response=await fetch(path,{...options,headers:{...headers(),...(options.headers||{})}});const text=await response.text();if(!response.ok)throw new Error(text);return text?JSON.parse(text):{};}
function log(value){$('logs').textContent=typeof value==='string'?value:JSON.stringify(value,null,2)}
async function refresh(){try{const data=await api('/v1/sessions');$('status').textContent='online · '+data.sessions.length+' sessions';$('sessions').innerHTML='';for(const session of data.sessions){const div=document.createElement('div');div.className='session '+(state.session===session.id?'active':'');div.innerHTML='<strong>'+session.id+'</strong><br><code>'+session.pages.length+' page(s) · pid '+(session.processId||'?')+'</code>';div.onclick=()=>{state.session=session.id;refresh()};$('sessions').append(div)}}catch(error){$('status').textContent='authentication required';log(error.message)}}
$('create').onclick=async()=>{try{const data=await api('/v1/sessions',{method:'POST',body:'{}'});state.session=data.id;log(data);refresh()}catch(e){log(e.message)}};
$('go').onclick=async()=>{if(!state.session)return log('Create a session first');try{log(await api('/v1/sessions/'+state.session+'/navigate',{method:'POST',body:JSON.stringify({url:$('url').value})}))}catch(e){log(e.message)}};
$('snap').onclick=async()=>{if(!state.session)return log('Create a session first');try{const data=await api('/v1/sessions/'+state.session+'/snapshot',{method:'POST',body:JSON.stringify({mode:'interactive'})});$('output').textContent=data.content;log(data.warnings?.length?data.warnings:'Snapshot complete')}catch(e){log(e.message)}};
$('shot').onclick=async()=>{if(!state.session)return log('Create a session first');try{const data=await api('/v1/sessions/'+state.session+'/capture',{method:'POST',body:JSON.stringify({format:'png'})});$('image').innerHTML='<img alt="Browser screenshot" src="data:'+data.mimeType+';base64,'+data.data+'">';log('Screenshot captured')}catch(e){log(e.message)}};
$('search').onclick=async()=>{try{const data=await api('/v1/search',{method:'POST',body:JSON.stringify({query:$('query').value})});$('output').textContent=data.results.map(x=>x.rank+'. '+x.title+'\n'+x.url+'\n'+x.snippet).join('\n\n');log({provider:data.provider,count:data.results.length})}catch(e){log(e.message)}};
$('challenge').onclick=async()=>{if(!state.session)return log('Create a session first');try{const data=await api('/v1/sessions/'+state.session+'/challenge');log(data);if(data.detected&&!data.headed)log({...data,next:'Enable challengeAutoSolve for automatic resolution, or restart Tendril with --headed for manual completion.'})}catch(e){log(e.message)}};
if(!state.token)log('Open this dashboard through the tendril serve command; its printed URL contains a one-time local token.');refresh();setInterval(refresh,5000);
</script>
</body></html>`;
