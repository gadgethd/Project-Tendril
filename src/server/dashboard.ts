export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0f1117">
  <title>Project Tendril · Browser Operations</title>
  <style>
    :root {
      color-scheme:dark;
      font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:#0f1117;
      color:#f8fafc;
      --bg:#0f1117;
      --surface:#1a1d27;
      --surface-raised:#202431;
      --surface-soft:#151821;
      --border:#2a2f3d;
      --border-strong:#394154;
      --text:#f8fafc;
      --muted:#94a3b8;
      --muted-strong:#cbd5e1;
      --blue:#3b82f6;
      --blue-bright:#60a5fa;
      --purple:#8b5cf6;
      --danger:#ef4444;
      --danger-soft:#7f1d1d;
      --shadow:0 24px 70px rgba(0,0,0,.34);
    }
    *{box-sizing:border-box}
    html{min-height:100%;background:var(--bg)}
    body{
      margin:0;
      min-width:320px;
      min-height:100vh;
      background:
        radial-gradient(circle at 18% -10%,rgba(59,130,246,.16),transparent 32rem),
        radial-gradient(circle at 92% 4%,rgba(139,92,246,.12),transparent 28rem),
        var(--bg);
      color:var(--text);
    }
    button,input{font:inherit}
    button{color:inherit}
    button:focus-visible,input:focus-visible,[role="button"]:focus-visible{
      outline:2px solid var(--blue-bright);
      outline-offset:2px;
    }
    .sr-only{
      position:absolute;
      width:1px;
      height:1px;
      padding:0;
      margin:-1px;
      overflow:hidden;
      clip:rect(0,0,0,0);
      white-space:nowrap;
      border:0;
    }
    .topbar{
      position:sticky;
      top:0;
      z-index:20;
      height:68px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:24px;
      padding:0 24px;
      border-bottom:1px solid rgba(148,163,184,.14);
      background:rgba(15,17,23,.78);
      backdrop-filter:blur(20px) saturate(130%);
    }
    .brand-lockup,.connection,.panel-heading,.heading-copy,.session-title-row,.session-meta,.preview-heading,.preview-state,.tab-bar,.tab-meta{
      display:flex;
      align-items:center;
    }
    .brand-lockup{gap:12px;min-width:0}
    .brand-mark{
      position:relative;
      width:34px;
      height:34px;
      flex:0 0 auto;
      border:1px solid rgba(96,165,250,.38);
      border-radius:11px;
      background:linear-gradient(145deg,rgba(59,130,246,.24),rgba(139,92,246,.2));
      box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 24px rgba(59,130,246,.12);
    }
    .brand-mark::before,.brand-mark::after{
      content:"";
      position:absolute;
      border-radius:999px;
      background:var(--blue-bright);
      box-shadow:0 0 12px rgba(96,165,250,.7);
    }
    .brand-mark::before{width:16px;height:4px;left:8px;top:9px;transform:rotate(-25deg)}
    .brand-mark::after{width:11px;height:4px;right:7px;bottom:9px;transform:rotate(38deg);background:var(--purple)}
    .brand-title{font-size:14px;font-weight:700;letter-spacing:.01em}
    .brand-subtitle{margin-top:2px;color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase}
    .connection{
      gap:9px;
      padding:7px 10px;
      border:1px solid rgba(148,163,184,.14);
      border-radius:999px;
      background:rgba(26,29,39,.72);
      color:var(--muted-strong);
      font-size:12px;
      white-space:nowrap;
    }
    .connection-dot{
      width:7px;
      height:7px;
      border-radius:50%;
      background:var(--muted);
      box-shadow:0 0 0 4px rgba(148,163,184,.09);
    }
    .connection.online .connection-dot{background:var(--blue-bright);box-shadow:0 0 0 4px rgba(59,130,246,.13),0 0 12px rgba(96,165,250,.55)}
    .connection.error .connection-dot{background:var(--danger);box-shadow:0 0 0 4px rgba(239,68,68,.13)}
    .connection-separator{width:1px;height:13px;background:var(--border)}
    .shell{
      display:grid;
      grid-template-columns:292px minmax(0,1fr);
      gap:18px;
      min-height:calc(100vh - 68px);
      padding:18px;
    }
    .panel{
      min-width:0;
      overflow:hidden;
      border:1px solid rgba(148,163,184,.15);
      border-radius:14px;
      background:rgba(26,29,39,.8);
      box-shadow:var(--shadow),inset 0 1px 0 rgba(255,255,255,.025);
      backdrop-filter:blur(18px);
    }
    .sidebar{display:flex;flex-direction:column;max-height:calc(100vh - 104px)}
    .panel-heading{
      min-height:58px;
      justify-content:space-between;
      gap:12px;
      padding:14px 16px;
      border-bottom:1px solid var(--border);
    }
    .heading-copy{gap:9px}
    .eyebrow{margin:0;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase}
    .count-badge{
      min-width:25px;
      padding:3px 7px;
      border:1px solid rgba(96,165,250,.2);
      border-radius:999px;
      background:rgba(59,130,246,.1);
      color:var(--blue-bright);
      font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;
      text-align:center;
    }
    .session-create{padding:14px 14px 12px;border-bottom:1px solid var(--border)}
    .field-label{display:flex;justify-content:space-between;margin-bottom:7px;color:var(--muted-strong);font-size:11px;font-weight:600}
    .field-label span{color:var(--muted);font-weight:400}
    .create-row,.navigate-row,.action-row,.search-group{display:flex;align-items:center;gap:8px}
    input{
      width:100%;
      min-width:0;
      height:38px;
      border:1px solid var(--border);
      border-radius:9px;
      background:rgba(15,17,23,.72);
      color:var(--text);
      padding:0 11px;
      transition:border-color .16s ease,box-shadow .16s ease,background .16s ease;
    }
    input::placeholder{color:#64748b}
    input:hover{border-color:var(--border-strong)}
    input:focus{border-color:var(--blue);background:rgba(15,17,23,.92);box-shadow:0 0 0 3px rgba(59,130,246,.12)}
    button{
      height:38px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:7px;
      flex:0 0 auto;
      border:1px solid var(--border-strong);
      border-radius:9px;
      background:rgba(32,36,49,.86);
      padding:0 12px;
      font-size:12px;
      font-weight:650;
      cursor:pointer;
      transition:transform .14s ease,border-color .14s ease,background .14s ease,box-shadow .14s ease,color .14s ease;
    }
    button:hover:not(:disabled){border-color:#4a556d;background:#292e3d;transform:translateY(-1px)}
    button:active:not(:disabled){transform:translateY(0)}
    button:disabled{opacity:.52;cursor:wait}
    button.primary{
      border-color:rgba(96,165,250,.42);
      background:linear-gradient(135deg,var(--blue),#2563eb);
      box-shadow:0 7px 18px rgba(37,99,235,.2),inset 0 1px 0 rgba(255,255,255,.15);
    }
    button.primary:hover:not(:disabled){border-color:var(--blue-bright);background:linear-gradient(135deg,#4f8ff7,#2d6dea)}
    button.ghost{border-color:transparent;background:transparent;color:var(--muted-strong)}
    button.ghost:hover:not(:disabled){border-color:var(--border);background:rgba(148,163,184,.07);color:var(--text)}
    button.danger-action{height:27px;border-color:rgba(239,68,68,.34);border-radius:7px;background:rgba(127,29,29,.24);color:#fca5a5;padding:0 8px;font-size:10px}
    button.busy::after{
      content:"";
      width:11px;
      height:11px;
      border:2px solid rgba(255,255,255,.3);
      border-top-color:#fff;
      border-radius:50%;
      animation:spin .7s linear infinite;
    }
    .session-list{
      display:grid;
      gap:9px;
      min-height:110px;
      padding:12px 10px;
      overflow:auto;
      scrollbar-color:#3a4254 transparent;
      scrollbar-width:thin;
    }
    .session-card{
      position:relative;
      padding:12px;
      border:1px solid var(--border);
      border-radius:11px;
      background:rgba(15,17,23,.5);
      cursor:pointer;
      transition:border-color .16s ease,background .16s ease,box-shadow .16s ease,transform .16s ease;
    }
    .session-card:hover{border-color:var(--border-strong);background:rgba(32,36,49,.7);transform:translateY(-1px)}
    .session-card.active{
      border-color:rgba(96,165,250,.76);
      background:linear-gradient(135deg,rgba(59,130,246,.13),rgba(32,36,49,.76));
      box-shadow:0 0 0 1px rgba(59,130,246,.12),0 0 24px rgba(59,130,246,.12);
    }
    .session-card.challenge{
      border-color:rgba(239,68,68,.78);
      box-shadow:0 0 0 1px rgba(239,68,68,.12),0 0 22px rgba(239,68,68,.15);
      animation:challenge-pulse 2s ease-in-out infinite;
    }
    .session-title-row{justify-content:space-between;gap:8px}
    .session-identity{display:flex;align-items:center;min-width:0;gap:8px}
    .session-indicator{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:#64748b;box-shadow:0 0 0 4px rgba(100,116,139,.1)}
    .session-card.active .session-indicator{background:var(--blue-bright);box-shadow:0 0 0 4px rgba(59,130,246,.12),0 0 9px rgba(96,165,250,.65)}
    .session-card.challenge .session-indicator{background:var(--danger);box-shadow:0 0 0 4px rgba(239,68,68,.12),0 0 10px rgba(239,68,68,.7)}
    .session-id{overflow:hidden;color:var(--text);font:650 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
    .challenge-badge{
      flex:0 0 auto;
      padding:3px 6px;
      border:1px solid rgba(239,68,68,.35);
      border-radius:5px;
      background:rgba(127,29,29,.28);
      color:#fca5a5;
      font-size:9px;
      font-weight:800;
      letter-spacing:.08em;
      text-transform:uppercase;
    }
    .session-page{margin:9px 0 10px;overflow:hidden;color:var(--muted-strong);font-size:11px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}
    .session-meta{justify-content:space-between;gap:8px;color:var(--muted);font:10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}
    .session-meta-group{display:flex;align-items:center;gap:8px}
    .meta-separator{width:3px;height:3px;border-radius:50%;background:#4b5563}
    .sidebar-empty{display:grid;place-items:center;min-height:150px;padding:20px;color:var(--muted);font-size:12px;text-align:center}
    .sidebar-empty strong{display:block;margin-bottom:5px;color:var(--muted-strong);font-size:13px}
    .sidebar-footer{margin-top:auto;padding:12px 14px;border-top:1px solid var(--border);color:#64748b;font-size:10px;line-height:1.5}
    .workspace{
      display:grid;
      grid-template-rows:auto minmax(360px,1fr) 224px;
      min-height:calc(100vh - 104px);
    }
    .toolbar{padding:13px 14px;border-bottom:1px solid var(--border);background:rgba(15,17,23,.23)}
    .navigate-row{margin-bottom:9px}
    .address-field{position:relative;flex:1;min-width:180px}
    .address-field::before{
      content:"";
      position:absolute;
      z-index:1;
      left:12px;
      top:50%;
      width:7px;
      height:7px;
      border:1px solid var(--blue-bright);
      border-radius:50%;
      transform:translateY(-50%);
      box-shadow:0 0 8px rgba(96,165,250,.35);
    }
    .address-field input{height:40px;padding-left:31px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
    .navigate-row button{height:40px;padding:0 16px}
    .action-row{justify-content:space-between}
    .action-group{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
    .action-group button{height:34px}
    .search-group{width:min(330px,42%)}
    .search-group input,.search-group button{height:34px}
    .preview-panel{display:grid;grid-template-rows:48px minmax(0,1fr);min-height:0;background:#10131a}
    .preview-heading{justify-content:space-between;gap:14px;padding:0 14px;border-bottom:1px solid var(--border);background:rgba(26,29,39,.82)}
    .browser-dots{display:flex;gap:5px;flex:0 0 auto}
    .browser-dot{width:7px;height:7px;border-radius:50%;background:#475569}
    .browser-dot:nth-child(2){background:var(--blue)}
    .browser-dot:nth-child(3){background:var(--purple)}
    .page-context{min-width:0;flex:1}
    .page-title{overflow:hidden;color:var(--muted-strong);font-size:11px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
    .page-url{margin-top:2px;overflow:hidden;color:#64748b;font:9px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
    .preview-state{gap:8px;flex:0 0 auto;color:var(--muted);font-size:10px}
    .live-label{display:inline-flex;align-items:center;gap:6px;color:var(--blue-bright);font-weight:700;letter-spacing:.07em;text-transform:uppercase}
    .live-label::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--blue-bright);box-shadow:0 0 9px rgba(96,165,250,.7)}
    .live-label.paused{color:var(--muted)}
    .live-label.paused::before{background:var(--muted);box-shadow:none}
    .preview-state .challenge-badge{font-size:8px}
    .preview-state button{height:28px;padding:0 8px;font-size:10px}
    .preview-surface{
      position:relative;
      min-height:0;
      overflow:auto;
      display:grid;
      place-items:center;
      padding:18px;
      background:
        linear-gradient(rgba(148,163,184,.025) 1px,transparent 1px),
        linear-gradient(90deg,rgba(148,163,184,.025) 1px,transparent 1px),
        #0c0e13;
      background-size:24px 24px;
      cursor:pointer;
      scrollbar-color:#3a4254 transparent;
      scrollbar-width:thin;
    }
    .preview-surface img{
      display:block;
      max-width:100%;
      max-height:100%;
      margin:auto;
      border:1px solid rgba(148,163,184,.18);
      border-radius:8px;
      background:#fff;
      box-shadow:0 22px 55px rgba(0,0,0,.42);
      object-fit:contain;
    }
    .preview-empty{max-width:340px;padding:24px;text-align:center;color:var(--muted)}
    .empty-orbit{
      position:relative;
      width:54px;
      height:54px;
      margin:0 auto 16px;
      border:1px solid rgba(96,165,250,.3);
      border-radius:18px;
      background:linear-gradient(145deg,rgba(59,130,246,.12),rgba(139,92,246,.09));
      box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 0 30px rgba(59,130,246,.08);
    }
    .empty-orbit::before{content:"";position:absolute;inset:15px;border:2px solid var(--blue-bright);border-radius:50%;box-shadow:0 0 14px rgba(96,165,250,.45)}
    .empty-orbit::after{content:"";position:absolute;width:7px;height:7px;right:9px;top:11px;border-radius:50%;background:var(--purple);box-shadow:0 0 10px rgba(139,92,246,.65)}
    .preview-empty strong{display:block;margin-bottom:7px;color:var(--muted-strong);font-size:14px}
    .preview-empty p{margin:0;font-size:11px;line-height:1.6}
    .preview-loader{
      position:absolute;
      top:12px;
      right:12px;
      z-index:3;
      display:none;
      align-items:center;
      gap:7px;
      padding:6px 9px;
      border:1px solid var(--border);
      border-radius:7px;
      background:rgba(15,17,23,.86);
      color:var(--muted-strong);
      font-size:9px;
      box-shadow:0 8px 22px rgba(0,0,0,.25);
    }
    .preview-surface.loading .preview-loader{display:flex}
    .preview-loader::before{content:"";width:10px;height:10px;border:2px solid rgba(96,165,250,.25);border-top-color:var(--blue-bright);border-radius:50%;animation:spin .7s linear infinite}
    .pause-overlay{
      position:absolute;
      inset:0;
      z-index:2;
      display:none;
      place-items:center;
      background:rgba(15,17,23,.38);
      backdrop-filter:blur(1px);
    }
    .pause-overlay span{padding:8px 11px;border:1px solid var(--border-strong);border-radius:8px;background:rgba(15,17,23,.88);color:var(--muted-strong);font-size:10px;box-shadow:0 12px 30px rgba(0,0,0,.3)}
    .preview-surface.paused .pause-overlay{display:grid}
    .diagnostics{display:grid;grid-template-rows:43px minmax(0,1fr);min-height:0;border-top:1px solid var(--border);background:rgba(15,17,23,.42)}
    .diagnostic-header{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding-right:11px}
    .tab-bar{height:100%;gap:2px;padding-left:8px}
    .tab-button{position:relative;height:100%;border:0;border-radius:0;background:transparent;color:var(--muted);padding:0 12px;font-size:11px}
    .tab-button:hover:not(:disabled){border-color:transparent;background:rgba(148,163,184,.05);transform:none;color:var(--muted-strong)}
    .tab-button.active{color:var(--text)}
    .tab-button.active::after{content:"";position:absolute;right:10px;bottom:0;left:10px;height:2px;border-radius:2px 2px 0 0;background:linear-gradient(90deg,var(--blue),var(--purple));box-shadow:0 0 8px rgba(59,130,246,.35)}
    .tab-meta{gap:8px;color:#64748b;font-size:9px}
    .tab-meta button{width:27px;height:27px;padding:0;border-color:transparent;background:transparent;color:var(--muted);font-size:15px}
    .panel-output{margin:0;min-height:0;overflow:auto;padding:14px 16px;color:#cbd5e1;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-color:#3a4254 transparent;scrollbar-width:thin}
    .toast{
      position:fixed;
      z-index:50;
      right:20px;
      bottom:20px;
      max-width:min(390px,calc(100vw - 40px));
      padding:10px 13px;
      border:1px solid rgba(96,165,250,.35);
      border-radius:9px;
      background:rgba(26,29,39,.96);
      color:var(--muted-strong);
      font-size:11px;
      box-shadow:0 18px 45px rgba(0,0,0,.4);
      opacity:0;
      pointer-events:none;
      transform:translateY(8px);
      transition:opacity .18s ease,transform .18s ease;
    }
    .toast.visible{opacity:1;transform:translateY(0)}
    .toast.error{border-color:rgba(239,68,68,.5);color:#fecaca}
    [hidden]{display:none!important}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes challenge-pulse{0%,100%{box-shadow:0 0 0 1px rgba(239,68,68,.1),0 0 15px rgba(239,68,68,.1)}50%{box-shadow:0 0 0 2px rgba(239,68,68,.18),0 0 28px rgba(239,68,68,.22)}}
    @media(max-width:980px){
      .shell{grid-template-columns:248px minmax(0,1fr);gap:12px;padding:12px}
      .sidebar,.workspace{max-height:none;min-height:calc(100vh - 92px)}
      .search-group{width:min(280px,44%)}
      .action-group button{padding:0 9px}
    }
    @media(max-width:780px){
      .topbar{height:62px;padding:0 15px}
      .brand-subtitle,.connection-separator,#session-summary{display:none}
      .shell{display:block;min-height:auto;padding:10px}
      .sidebar{max-height:330px;margin-bottom:10px;min-height:0}
      .session-list{grid-template-columns:repeat(auto-fit,minmax(210px,1fr));min-height:110px}
      .sidebar-footer{display:none}
      .workspace{grid-template-rows:auto minmax(400px,62vh) 230px;min-height:780px}
      .action-row{align-items:stretch;flex-direction:column}
      .search-group{width:100%}
    }
    @media(max-width:520px){
      .brand-mark{width:30px;height:30px;border-radius:9px}
      .brand-mark::before{left:7px;top:8px}
      .brand-mark::after{right:6px;bottom:7px}
      .connection{padding:6px 8px}
      .panel{border-radius:11px}
      .create-row,.navigate-row{align-items:stretch;flex-direction:column}
      .create-row button,.navigate-row button{width:100%}
      .navigate-row{margin-bottom:10px}
      .action-group{display:grid;grid-template-columns:repeat(2,1fr)}
      .action-group button{width:100%}
      .search-group{display:grid;grid-template-columns:minmax(0,1fr) auto}
      .workspace{grid-template-rows:auto minmax(340px,55vh) 238px;min-height:760px}
      .preview-heading{padding:0 10px}
      .browser-dots,#refresh-time{display:none}
      .preview-surface{padding:9px}
      .tab-button{padding:0 8px}
      .diagnostic-header{padding-right:5px}
      .tab-meta span{display:none}
    }
    @media(prefers-reduced-motion:reduce){
      *,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand-lockup">
      <span class="brand-mark" aria-hidden="true"></span>
      <div>
        <div class="brand-title">Project Tendril</div>
        <div class="brand-subtitle">Browser operations</div>
      </div>
    </div>
    <div id="connection" class="connection" role="status" aria-live="polite">
      <span class="connection-dot" aria-hidden="true"></span>
      <span id="status">Connecting</span>
      <span class="connection-separator" aria-hidden="true"></span>
      <span id="session-summary">0 sessions</span>
    </div>
  </header>

  <main class="shell">
    <aside class="panel sidebar" aria-label="Browser sessions">
      <div class="panel-heading">
        <div class="heading-copy"><p class="eyebrow">Sessions</p></div>
        <span id="session-count" class="count-badge">0</span>
      </div>
      <form id="create-form" class="session-create">
        <label class="field-label" for="profile">Profile name <span>optional</span></label>
        <div class="create-row">
          <input id="profile" name="profile" autocomplete="off" placeholder="e.g. research">
          <button id="create" class="primary" type="submit"><span aria-hidden="true">+</span> New</button>
        </div>
      </form>
      <div id="sessions" class="session-list" aria-live="polite">
        <div class="sidebar-empty"><div><strong>No sessions yet</strong>Create one to start browsing.</div></div>
      </div>
      <div class="sidebar-footer">Isolated Chromium runtimes · local machine only</div>
    </aside>

    <section class="panel workspace" aria-label="Browser workspace">
      <div class="toolbar">
        <form id="navigate-form" class="navigate-row">
          <label class="sr-only" for="url">Page URL</label>
          <div class="address-field"><input id="url" name="url" value="https://example.com" inputmode="url" autocomplete="url" spellcheck="false"></div>
          <button id="go" class="primary" type="submit">Navigate <span aria-hidden="true">↗</span></button>
        </form>
        <div class="action-row">
          <div class="action-group" aria-label="Page actions">
            <button id="snap" type="button">Snapshot</button>
            <button id="shot" type="button">Screenshot</button>
            <button id="extract" type="button">Extract</button>
          </div>
          <form id="search-form" class="search-group">
            <label class="sr-only" for="query">Search the web</label>
            <input id="query" name="query" autocomplete="off" placeholder="Search the web">
            <button id="search" type="submit">Search</button>
          </form>
        </div>
      </div>

      <section class="preview-panel" aria-label="Live browser preview">
        <div class="preview-heading">
          <div class="browser-dots" aria-hidden="true"><span class="browser-dot"></span><span class="browser-dot"></span><span class="browser-dot"></span></div>
          <div class="page-context">
            <div id="page-title" class="page-title">No active session</div>
            <div id="page-url" class="page-url">Create or select a session to begin</div>
          </div>
          <div class="preview-state">
            <span id="challenge-state" class="challenge-badge" hidden>CAPTCHA</span>
            <span id="live-label" class="live-label">Live</span>
            <span id="refresh-time">Waiting</span>
            <button id="preview-toggle" class="ghost" type="button" aria-pressed="false">Pause</button>
          </div>
        </div>
        <div id="preview" class="preview-surface" role="button" tabindex="0" aria-label="Live screenshot. Click to pause or resume auto-refresh.">
          <div class="preview-loader">Refreshing</div>
          <img id="preview-image" alt="Live browser screenshot" hidden>
          <div id="preview-empty" class="preview-empty">
            <div class="empty-orbit" aria-hidden="true"></div>
            <strong>Live browser preview</strong>
            <p>Select a session to stream its current page. The preview refreshes every four seconds.</p>
          </div>
          <div class="pause-overlay"><span>Preview paused · click to resume</span></div>
        </div>
      </section>

      <section class="diagnostics" aria-label="Session diagnostics">
        <div class="diagnostic-header">
          <nav class="tab-bar" aria-label="Diagnostics tabs">
            <button class="tab-button active" type="button" role="tab" aria-selected="true" data-tab="output">Output</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab="console">Console</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab="network">Network</button>
            <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab="logs">Logs</button>
          </nav>
          <div class="tab-meta"><span id="tab-status">Ready</span><button id="refresh-tab" type="button" title="Refresh active tab" aria-label="Refresh active tab">↻</button></div>
        </div>
        <pre id="panel-output" class="panel-output" role="tabpanel">Create a session to begin. Snapshot, extraction, and search results will appear here.</pre>
      </section>
    </section>
  </main>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script type="module">
    const state={
      token:new URLSearchParams(location.hash.slice(1)).get('token')||sessionStorage.getItem('tendril-token'),
      session:null,
      sessions:[],
      challenges:new Map(),
      activeTab:'output',
      output:'Create a session to begin. Snapshot, extraction, and search results will appear here.',
      logs:[],
      previewPaused:false,
      previewBusy:false,
      sessionsBusy:false,
      toastTimer:null,
      lastPreviewError:null
    };
    if(state.token)sessionStorage.setItem('tendril-token',state.token);
    history.replaceState(null,'',location.pathname+location.search);

    const $=id=>document.getElementById(id);
    const headers=()=>({'content-type':'application/json','authorization':'Bearer '+state.token});
    const selectedSession=()=>state.sessions.find(session=>session.id===state.session);
    const formatValue=value=>typeof value==='string'?value:JSON.stringify(value,null,2);

    async function api(path,options={}){
      const response=await fetch(path,{...options,headers:{...headers(),...(options.headers||{})}});
      const text=await response.text();
      let payload={};
      if(text){try{payload=JSON.parse(text)}catch{payload=text}}
      if(!response.ok){
        const message=payload&&typeof payload==='object'&&payload.error?payload.error.message:text;
        throw new Error(message||('Request failed with status '+response.status));
      }
      return payload;
    }

    function showToast(message,type='info'){
      const toast=$('toast');
      toast.textContent=message;
      toast.className='toast visible '+(type==='error'?'error':'');
      clearTimeout(state.toastTimer);
      state.toastTimer=setTimeout(()=>{toast.className='toast'},3200);
    }

    function writeLog(value,level='info'){
      state.logs.unshift({time:new Date().toLocaleTimeString(),level,message:formatValue(value)});
      state.logs=state.logs.slice(0,100);
      if(state.activeTab==='logs')renderActiveTab();
    }

    function setConnection(mode,label){
      $('connection').className='connection '+mode;
      $('status').textContent=label;
    }

    function setOutput(value,status='Output updated'){
      state.output=formatValue(value);
      $('tab-status').textContent=status;
      setActiveTab('output');
    }

    function setButtonBusy(button,busy){
      button.disabled=busy;
      button.classList.toggle('busy',busy);
    }

    async function runAction(button,action){
      setButtonBusy(button,true);
      try{return await action()}
      catch(error){
        const message=error instanceof Error?error.message:String(error);
        writeLog(message,'error');
        showToast(message,'error');
      }finally{setButtonBusy(button,false)}
    }

    function requireSession(){
      if(state.session)return state.session;
      showToast('Create or select a session first.','error');
      return null;
    }

    function shortId(id){return id.length>18?id.slice(0,8)+'…'+id.slice(-5):id}

    function relativeTime(value){
      const seconds=Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/1000));
      if(seconds<10)return 'now';
      if(seconds<60)return seconds+'s ago';
      const minutes=Math.floor(seconds/60);
      if(minutes<60)return minutes+'m ago';
      return Math.floor(minutes/60)+'h ago';
    }

    function selectedPage(session){return session&&session.pages.find(page=>page.selected)||session&&session.pages[0]}

    function updateWorkspaceContext(){
      const session=selectedSession();
      const page=selectedPage(session);
      $('page-title').textContent=page&&page.title?String(page.title):session?'Untitled page':'No active session';
      $('page-url').textContent=page&&page.url?String(page.url):session?'No page URL available':'Create or select a session to begin';
      if(page&&page.url&&document.activeElement!==$('url'))$('url').value=page.url;
      const challenge=session&&state.challenges.get(session.id);
      $('challenge-state').hidden=!(challenge&&challenge.detected);
      if(challenge&&challenge.detected)$('challenge-state').textContent=((challenge.provider?challenge.provider+' ':'')+'CAPTCHA').replace('-',' ');
    }

    function renderSessions(){
      const container=$('sessions');
      container.replaceChildren();
      $('session-count').textContent=String(state.sessions.length);
      $('session-summary').textContent=state.sessions.length+' session'+(state.sessions.length===1?'':'s');
      if(!state.sessions.length){
        const empty=document.createElement('div');
        empty.className='sidebar-empty';
        const content=document.createElement('div');
        const title=document.createElement('strong');
        title.textContent='No sessions yet';
        content.append(title,document.createTextNode('Create one to start browsing.'));
        empty.append(content);
        container.append(empty);
        updateWorkspaceContext();
        return;
      }
      for(const session of state.sessions){
        const challenge=state.challenges.get(session.id);
        const card=document.createElement('article');
        card.className='session-card'+(state.session===session.id?' active':'')+(challenge&&challenge.detected?' challenge':'');
        card.tabIndex=0;
        card.setAttribute('role','button');
        card.setAttribute('aria-label','Select session '+session.id);

        const titleRow=document.createElement('div');
        titleRow.className='session-title-row';
        const identity=document.createElement('div');
        identity.className='session-identity';
        const indicator=document.createElement('span');
        indicator.className='session-indicator';
        indicator.setAttribute('aria-hidden','true');
        const id=document.createElement('span');
        id.className='session-id';
        id.textContent=shortId(session.id);
        id.title=session.id;
        identity.append(indicator,id);
        titleRow.append(identity);
        if(challenge&&challenge.detected){
          const badge=document.createElement('span');
          badge.className='challenge-badge';
          badge.textContent=((challenge.provider?challenge.provider+' ':'')+'CAPTCHA').replace('-',' ');
          titleRow.append(badge);
        }

        const page=selectedPage(session);
        const pageLine=document.createElement('div');
        pageLine.className='session-page';
        const pageLabel=page&&(page.title||page.url)?page.title||page.url:'Blank page';
        pageLine.textContent=session.profile?session.profile+' · '+pageLabel:pageLabel;
        pageLine.title=page&&page.url?page.url:'';

        const meta=document.createElement('div');
        meta.className='session-meta';
        const metaGroup=document.createElement('div');
        metaGroup.className='session-meta-group';
        const pages=document.createElement('span');
        pages.textContent=session.pages.length+' page'+(session.pages.length===1?'':'s');
        const separator=document.createElement('span');
        separator.className='meta-separator';
        const pid=document.createElement('span');
        pid.textContent='PID '+(session.processId||'—');
        metaGroup.append(pages,separator,pid);
        const activity=document.createElement('span');
        activity.textContent=relativeTime(session.lastActivityAt);
        meta.append(metaGroup,activity);
        if(challenge&&challenge.detected){
          const solve=document.createElement('button');
          solve.type='button';
          solve.className='danger-action';
          solve.textContent='Solve';
          solve.onclick=event=>{event.stopPropagation();void solveChallenge(session.id,solve)};
          meta.replaceChildren(metaGroup,solve);
        }

        card.append(titleRow,pageLine,meta);
        card.onclick=()=>selectSession(session.id);
        card.onkeydown=event=>{
          if(event.key==='Enter'||event.key===' '){event.preventDefault();selectSession(session.id)}
        };
        container.append(card);
      }
      updateWorkspaceContext();
    }

    async function refreshChallenges(sessions){
      const checks=await Promise.allSettled(sessions.map(async session=>[
        session.id,
        await api('/v1/sessions/'+encodeURIComponent(session.id)+'/challenge')
      ]));
      for(const result of checks){
        if(result.status!=='fulfilled')continue;
        const id=result.value[0];
        const challenge=result.value[1];
        if(challenge&&challenge.detected)state.challenges.set(id,challenge);
        else state.challenges.delete(id);
      }
      for(const id of [...state.challenges.keys()]){
        if(!sessions.some(session=>session.id===id))state.challenges.delete(id);
      }
    }

    async function refreshSessions(){
      if(state.sessionsBusy)return;
      state.sessionsBusy=true;
      try{
        const data=await api('/v1/sessions');
        state.sessions=Array.isArray(data.sessions)?data.sessions:[];
        if(!state.session||!state.sessions.some(session=>session.id===state.session))state.session=state.sessions[0]?.id||null;
        await refreshChallenges(state.sessions);
        setConnection('online','Online');
        renderSessions();
      }catch(error){
        setConnection('error',state.token?'Unavailable':'Authentication required');
        const message=error instanceof Error?error.message:String(error);
        writeLog(message,'error');
        if(!state.token)setOutput('Open this dashboard through the Tendril serve command. Its printed URL contains a one-time local token.','Authentication required');
      }finally{state.sessionsBusy=false}
    }

    function selectSession(id){
      const changed=state.session!==id;
      state.session=id;
      state.previewPaused=false;
      setPreviewPaused(false);
      renderSessions();
      if(changed){
        $('preview-image').hidden=true;
        $('preview-empty').hidden=false;
        $('refresh-time').textContent='Refreshing';
      }
      void refreshPreview(true);
      void refreshActiveTab();
    }

    function setPreviewPaused(paused){
      state.previewPaused=paused;
      $('preview').classList.toggle('paused',paused);
      $('live-label').classList.toggle('paused',paused);
      $('live-label').textContent=paused?'Paused':'Live';
      $('preview-toggle').textContent=paused?'Resume':'Pause';
      $('preview-toggle').setAttribute('aria-pressed',String(paused));
      if(!paused&&state.session)void refreshPreview(true);
    }

    function togglePreview(){setPreviewPaused(!state.previewPaused)}

    async function loadPreviewImage(data,sessionId){
      const source='data:'+data.mimeType+';base64,'+data.data;
      await new Promise((resolve,reject)=>{
        const image=new Image();
        image.onload=resolve;
        image.onerror=reject;
        image.src=source;
      });
      if(state.session!==sessionId)return;
      $('preview-image').src=source;
      $('preview-image').hidden=false;
      $('preview-empty').hidden=true;
    }

    async function refreshPreview(force=false,manual=false){
      const sessionId=state.session;
      if(!sessionId||state.previewBusy||(!force&&(state.previewPaused||document.hidden)))return null;
      state.previewBusy=true;
      $('preview').classList.add('loading');
      try{
        const data=manual
          ?await api('/v1/sessions/'+encodeURIComponent(sessionId)+'/capture',{method:'POST',body:JSON.stringify({format:'png'})})
          :await api('/v1/sessions/'+encodeURIComponent(sessionId)+'/screenshot?format=jpeg&quality=80');
        await loadPreviewImage(data,sessionId);
        if(state.session===sessionId){
          $('refresh-time').textContent='Updated now';
          state.lastPreviewError=null;
        }
        return true;
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(state.lastPreviewError!==message){
          writeLog('Preview: '+message,'error');
          state.lastPreviewError=message;
        }
        if($('preview-image').hidden){
          $('preview-empty').hidden=false;
          $('preview-empty').querySelector('strong').textContent='Preview unavailable';
          $('preview-empty').querySelector('p').textContent=message;
        }
        $('refresh-time').textContent='Retrying';
        return false;
      }finally{
        state.previewBusy=false;
        $('preview').classList.remove('loading');
      }
    }

    async function solveChallenge(sessionId,button){
      await runAction(button,async()=>{
        const data=await api('/v1/sessions/'+encodeURIComponent(sessionId)+'/challenge',{method:'POST',body:JSON.stringify({action:'focus'})});
        writeLog({event:'Challenge handoff requested',sessionId,result:data});
        showToast('Challenge handoff requested.');
        state.session=sessionId;
        await refreshSessions();
      });
    }

    function renderActiveTab(content){
      const output=$('panel-output');
      if(content!==undefined){
        output.textContent=content;
        return;
      }
      if(state.activeTab==='output')output.textContent=state.output;
      else if(state.activeTab==='logs')output.textContent=state.logs.length
        ?state.logs.map(entry=>'['+entry.time+'] '+entry.level.toUpperCase()+'  '+entry.message).join('\n\n')
        :'No dashboard activity yet.';
    }

    function setActiveTab(tab){
      state.activeTab=tab;
      document.querySelectorAll('.tab-button').forEach(button=>{
        const active=button.dataset.tab===tab;
        button.classList.toggle('active',active);
        button.setAttribute('aria-selected',String(active));
      });
      renderActiveTab();
      if(tab==='console'||tab==='network')void refreshActiveTab();
    }

    async function refreshActiveTab(){
      if(state.activeTab==='output'||state.activeTab==='logs'){
        renderActiveTab();
        $('tab-status').textContent=state.activeTab==='logs'?state.logs.length+' entries':'Ready';
        return;
      }
      const sessionId=requireSession();
      if(!sessionId)return;
      $('tab-status').textContent='Refreshing';
      try{
        const data=await api('/v1/sessions/'+encodeURIComponent(sessionId)+'/inspect/'+state.activeTab);
        const entries=Array.isArray(data.entries)?data.entries:[];
        renderActiveTab(entries.length?JSON.stringify(entries,null,2):'No '+state.activeTab+' entries for this session.');
        $('tab-status').textContent=entries.length+' entr'+(entries.length===1?'y':'ies');
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        renderActiveTab(message);
        $('tab-status').textContent='Unavailable';
        writeLog(message,'error');
      }
    }

    $('create-form').onsubmit=event=>{
      event.preventDefault();
      void runAction($('create'),async()=>{
        const profile=$('profile').value.trim();
        const body=profile?{profile}:{};
        const data=await api('/v1/sessions',{method:'POST',body:JSON.stringify(body)});
        state.session=data.id;
        $('profile').value='';
        writeLog({event:'Session created',sessionId:data.id,profile:profile||undefined});
        showToast('Browser session created.');
        await refreshSessions();
        await refreshPreview(true);
      });
    };

    $('navigate-form').onsubmit=event=>{
      event.preventDefault();
      const sessionId=requireSession();
      if(!sessionId)return;
      void runAction($('go'),async()=>{
        let url=$('url').value.trim();
        if(url&&!/^[a-z][a-z0-9+.-]*:/i.test(url))url='https://'+url;
        $('url').value=url;
        const data=await api('/v1/sessions/'+encodeURIComponent(sessionId)+'/navigate',{method:'POST',body:JSON.stringify({url})});
        writeLog({event:'Navigation complete',url});
        setOutput(data,'Navigation complete');
        await refreshSessions();
        await refreshPreview(true);
      });
    };

    $('snap').onclick=()=>{
      const sessionId=requireSession();
      if(!sessionId)return;
      void runAction($('snap'),async()=>{
        const data=await api('/v1/sessions/'+encodeURIComponent(sessionId)+'/snapshot',{method:'POST',body:JSON.stringify({mode:'interactive'})});
        setOutput(data.content||data,'Snapshot complete');
        writeLog(data.warnings&&data.warnings.length?data.warnings:'Interactive snapshot captured');
      });
    };

    $('shot').onclick=()=>{
      if(!requireSession())return;
      void runAction($('shot'),async()=>{
        const captured=await refreshPreview(true,true);
        if(captured){
          writeLog('Screenshot captured');
          showToast('Screenshot refreshed.');
        }else if(captured===null)showToast('A preview refresh is already in progress.');
        else showToast('Screenshot failed. Check Logs for details.','error');
      });
    };

    $('extract').onclick=()=>{
      const sessionId=requireSession();
      if(!sessionId)return;
      void runAction($('extract'),async()=>{
        const data=await api('/v1/sessions/'+encodeURIComponent(sessionId)+'/extract',{method:'POST',body:JSON.stringify({format:'markdown'})});
        setOutput(data.data,'Markdown extracted');
        writeLog('Page content extracted as Markdown');
      });
    };

    $('search-form').onsubmit=event=>{
      event.preventDefault();
      const query=$('query').value.trim();
      if(!query)return showToast('Enter a search query.','error');
      void runAction($('search'),async()=>{
        const data=await api('/v1/search',{method:'POST',body:JSON.stringify({query})});
        const results=Array.isArray(data.results)?data.results:[];
        const text=results.map(result=>result.rank+'. '+result.title+'\n'+result.url+'\n'+result.snippet).join('\n\n');
        setOutput(text||'No search results.','Search complete');
        writeLog({event:'Search complete',provider:data.provider,count:results.length});
      });
    };

    $('preview-toggle').onclick=event=>{event.stopPropagation();togglePreview()};
    $('preview').onclick=togglePreview;
    $('preview').onkeydown=event=>{
      if(event.key==='Enter'||event.key===' '){event.preventDefault();togglePreview()}
    };
    $('refresh-tab').onclick=()=>void refreshActiveTab();
    document.querySelectorAll('.tab-button').forEach(button=>button.onclick=()=>setActiveTab(button.dataset.tab));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.previewPaused)void refreshPreview(true)});

    void refreshSessions().then(()=>refreshPreview(true));
    setInterval(()=>void refreshSessions(),5000);
    setInterval(()=>void refreshPreview(),4000);
    setInterval(()=>{if(state.activeTab==='console'||state.activeTab==='network')void refreshActiveTab()},5000);
  </script>
</body>
</html>`;
