export const AGENT_TEAM_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Agent Team</title>
<style>
:root{color-scheme:light;--bg:#f5f7fb;--panel:#fff;--panel2:#fff;--soft:#f8f9fc;--line:#e3e7ef;--text:#182033;--muted:#737d91;--accent:#6758e8;--accent-soft:#eeeaff;--danger:#c2415a;--success:#23825d;--shadow:0 8px 28px rgba(26,35,58,.07)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text)}button,input,textarea,select{font:inherit}.app-shell{display:grid;grid-template-columns:210px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:24px;padding:24px 18px;background:var(--panel);border-right:1px solid var(--line)}.brand{display:flex;align-items:center;gap:11px;color:var(--text);text-decoration:none;font-size:17px;font-weight:800}.brand-icon{width:34px;height:34px;display:grid;place-items:center;border-radius:11px;background:var(--accent);color:#fff;box-shadow:0 8px 18px rgba(103,88,232,.25)}.nav{display:grid;gap:7px}.nav-item{width:100%;display:flex;align-items:center;gap:11px;padding:10px 12px;border:0;border-radius:10px;background:transparent;color:var(--muted);font-size:13px;font-weight:650;text-align:left}.nav-item:hover{border:0;background:var(--soft)}.nav-item.active{background:var(--accent-soft);color:var(--accent)}.nav-icon{width:18px;text-align:center}.side-note{margin-top:auto;padding:13px;border:1px solid var(--line);background:var(--soft);border-radius:12px;font-size:11px;line-height:1.55;color:var(--muted)}.side-note strong{color:var(--success)}
.shell{min-width:320px;padding:24px}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:18px}.eyebrow{font-size:11px;font-weight:800;letter-spacing:.12em;color:var(--accent);margin-bottom:6px}.top h1{font-size:27px;line-height:1.2;letter-spacing:-.025em;margin:0}.top p{font-size:12px;color:var(--muted);margin:6px 0 0}.top a{height:38px;display:inline-flex;align-items:center;padding:0 13px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);text-decoration:none;font-size:12px;font-weight:700}
.workspace-bar{display:grid;grid-template-columns:minmax(180px,220px) minmax(280px,1fr) auto auto;gap:9px;padding:11px;background:var(--panel);border:1px solid var(--line);border-radius:15px;margin-bottom:12px;box-shadow:var(--shadow)}input,textarea,select{border:1px solid var(--line);background:var(--soft);color:var(--text);border-radius:9px;padding:10px 12px;outline:none}input:focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(103,88,232,.13)}button{cursor:pointer;border:1px solid var(--line);border-radius:9px;padding:10px 14px;background:var(--panel);color:var(--text);font-weight:700}button:hover{border-color:#c8cde0;background:#fbfbfe}button.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 7px 17px rgba(103,88,232,.22)}button.primary:hover{background:#5949d6;border-color:#5949d6}button.ghost{background:var(--soft)}button.danger{background:#fff1f3;border-color:#f3c4ce;color:var(--danger)}.hidden{display:none!important}
.main-agent-bar{display:grid;grid-template-columns:minmax(180px,1fr) minmax(170px,230px) auto;align-items:center;gap:12px;padding:13px 15px;background:var(--panel);border:1px solid var(--line);border-radius:15px;margin-bottom:12px;box-shadow:var(--shadow)}.main-agent-copy{min-width:0}.main-agent-copy strong{display:block;font-size:13px;margin-bottom:3px}.main-agent-copy span{display:block;color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.main-agent-controls{display:flex;gap:8px}.main-agent-controls select{min-width:130px}.agent-status{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}.agent-status::before{content:"●";font-size:9px;color:#a3aabd}.agent-status.ready::before{color:var(--success)}.agent-status.error::before{color:var(--danger)}.agent-status.provisioning::before{color:#b7791f}
.status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 3px 10px;color:var(--muted);font-size:11px}.workspace-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.save-state{min-width:78px;text-align:right;color:var(--success);font-weight:700}.save-state::before{content:"● ";font-size:9px}.save-state.saving{color:#b7791f}.save-state.error{color:var(--danger)}
.board-scroll{overflow-x:auto;padding-bottom:12px}.board{display:grid;grid-template-columns:repeat(5,minmax(230px,1fr));gap:11px;min-width:1200px}.column{display:flex;flex-direction:column;min-height:calc(100vh - 230px);background:var(--soft);border:1px solid var(--line);border-radius:15px;overflow:hidden}.column.drag-over{border-color:var(--accent);box-shadow:0 0 0 3px rgba(103,88,232,.13)}.column-head{display:flex;align-items:center;gap:8px;padding:14px 13px 9px}.column-dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}.column-title{font-size:13px;font-weight:800}.count{margin-left:auto;display:inline-grid;place-items:center;min-width:23px;height:23px;padding:0 7px;border-radius:999px;background:var(--panel);border:1px solid var(--line);color:var(--muted);font-size:10px}.task-list{flex:1;min-height:100px;padding:4px 10px 10px}.task{position:relative;background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:12px;margin:8px 0;box-shadow:0 4px 15px rgba(34,42,65,.045);cursor:grab}.task:hover{border-color:#d1d5e1;box-shadow:0 8px 22px rgba(34,42,65,.08)}.task:active{cursor:grabbing}.task.dragging{opacity:.35}.task h3{font-size:13px;line-height:1.45;margin:0 42px 6px 0}.task p{font-size:11px;line-height:1.55;color:var(--muted);margin:0;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.task-actions{display:flex;gap:4px;position:absolute;right:7px;top:7px;opacity:0;transition:opacity .15s}.task:hover .task-actions,.task:focus-within .task-actions{opacity:1}.icon-btn{padding:3px 6px;border-radius:6px;background:var(--soft);color:var(--muted);font-size:10px}.add{margin:0 10px 11px;background:transparent;border:1px dashed #c7cdd9;color:var(--muted);font-size:11px}.empty{padding:20px 8px;text-align:center;color:#9aa3b4;font-size:11px}
.modal-backdrop{position:fixed;inset:0;z-index:20;background:rgba(24,32,51,.36);display:grid;place-items:center;padding:20px;backdrop-filter:blur(3px)}.modal{width:min(560px,100%);background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 28px 90px rgba(35,43,65,.24)}.modal h2{margin:0 0 16px}.field{display:grid;gap:7px;margin-bottom:14px}.field label{font-size:13px;color:var(--text);font-weight:650}.field textarea{min-height:150px;resize:vertical}.modal-actions{display:flex;justify-content:flex-end;gap:9px}.directory-modal{width:min(820px,100%)}.directory-layout{display:grid;grid-template-columns:180px minmax(0,1fr);min-height:430px;border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:16px}.directory-sidebar{padding:12px;background:var(--soft);border-right:1px solid var(--line)}.directory-label{margin:2px 6px 9px;color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.05em}.directory-locations{display:grid;gap:4px}.directory-location{width:100%;padding:8px 9px;border:0;background:transparent;text-align:left;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.directory-location:hover{border:0;background:var(--accent-soft);color:var(--accent)}.directory-main{min-width:0;display:flex;flex-direction:column;padding:12px}.directory-toolbar{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:7px}.directory-toolbar button{padding:8px 11px}.directory-toolbar input{min-width:0;padding:8px 10px}.directory-list{flex:1;height:310px;overflow:auto;margin-top:10px;border:1px solid var(--line);border-radius:10px;background:var(--soft);padding:6px}.directory-row{width:100%;display:flex;align-items:center;gap:9px;padding:9px 10px;border:0;background:transparent;text-align:left;font-size:12px}.directory-row:hover{border:0;background:#fff}.directory-row.selected{border:0;background:var(--accent-soft);color:var(--accent)}.directory-folder-icon{color:#b7791f;font-size:15px}.directory-empty{padding:46px 16px;text-align:center;color:var(--muted);font-size:12px}.directory-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;color:var(--muted);font-size:11px}.directory-footer label{display:flex;align-items:center;gap:6px;white-space:nowrap}.directory-footer input{width:15px;height:15px;margin:0}.directory-selected{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}.toast{position:fixed;right:22px;bottom:22px;z-index:30;max-width:min(420px,calc(100vw - 44px));padding:12px 15px;border-radius:10px;background:#253047;color:#fff;border:1px solid #35415a;box-shadow:0 16px 50px rgba(35,43,65,.25)}.toast.error{border-color:#ef9bad;background:#9f2942}
@media(max-width:1100px){.app-shell{grid-template-columns:78px minmax(0,1fr)}.sidebar{padding:22px 12px;align-items:center}.brand span:last-child,.nav-item span:last-child,.side-note{display:none}.nav-item{width:45px;height:45px;justify-content:center;padding:0}.workspace-bar{grid-template-columns:1fr 1fr}.workspace-bar input{grid-column:1/-1}.main-agent-bar{grid-template-columns:1fr auto}.main-agent-copy{grid-column:1/-1}.board{min-width:1200px}}
@media(max-width:700px){.app-shell{display:block}.sidebar{display:none}.shell{padding:14px}.top{align-items:flex-start}.workspace-bar{grid-template-columns:1fr}.workspace-bar input{grid-column:auto}.main-agent-bar{grid-template-columns:1fr}.main-agent-copy{grid-column:auto}.main-agent-controls{display:grid;grid-template-columns:1fr auto}.main-agent-controls select{min-width:0}.board{min-width:1180px}.directory-layout{grid-template-columns:1fr}.directory-sidebar{border-right:0;border-bottom:1px solid var(--line)}.directory-locations{display:flex;overflow-x:auto}.directory-location{width:auto;min-width:max-content}.directory-toolbar{grid-template-columns:auto auto 1fr}.directory-list{height:270px}}
</style>
</head>
<body>
<div class="app-shell">
<aside class="sidebar">
  <a class="brand" href="/agent-team"><span class="brand-icon">✦</span><span>Agent Team</span></a>
  <nav class="nav" aria-label="Agent Team 导航">
    <span class="nav-item active"><span class="nav-icon">▦</span><span>任务看板</span></span>
    <button type="button" class="nav-item" data-feature="工作目录"><span class="nav-icon">⌕</span><span>工作目录</span></button>
    <button type="button" class="nav-item" data-feature="同步设置"><span class="nav-icon">↻</span><span>同步设置</span></button>
  </nav>
  <div class="side-note">本地优先<br>数据保存在 ~/.chatccc<br><strong>● Node 后端已连接</strong></div>
</aside>
<main class="shell">
  <div class="top"><div><div class="eyebrow">LOCAL WORKSPACE</div><h1>Agent Team</h1><p>每个工作目录拥有独立的本地任务看板</p></div><a href="/">返回设置</a></div>
  <section class="workspace-bar">
    <select id="recent" aria-label="最近工作目录"><option value="">最近工作目录</option></select>
    <input id="workspace-path" type="text" spellcheck="false" placeholder="输入本机工作目录绝对路径">
    <button id="pick" class="ghost">选择文件夹</button>
    <button id="relink" class="hidden">重新关联</button>
  </section>
  <section class="main-agent-bar" aria-label="项目主 Agent">
    <div class="main-agent-copy"><strong>项目主 Agent</strong><span id="main-agent-status" class="agent-status">请先打开一个项目</span></div>
    <div class="main-agent-controls"><select id="main-agent" disabled aria-label="选择主 Agent"><option value="">选择主 Agent</option></select><button id="save-main-agent" class="primary" disabled>设置</button></div>
  </section>
  <div class="status-row"><span id="workspace-name" class="workspace-name">尚未打开工作目录</span><span id="save-state" class="save-state">本地 JSON</span></div>
  <div class="board-scroll"><section class="board" id="board">
    <article class="column" data-column="brainstorm"><header class="column-head"><span class="column-dot"></span><span class="column-title">头脑风暴</span><span class="count">0</span></header><div class="task-list"></div><button class="add" data-add="brainstorm">＋ 添加任务</button></article>
    <article class="column" data-column="todo"><header class="column-head"><span class="column-dot"></span><span class="column-title">Todo</span><span class="count">0</span></header><div class="task-list"></div><button class="add" data-add="todo">＋ 添加任务</button></article>
    <article class="column" data-column="doing"><header class="column-head"><span class="column-dot"></span><span class="column-title">Doing</span><span class="count">0</span></header><div class="task-list"></div><button class="add" data-add="doing">＋ 添加任务</button></article>
    <article class="column" data-column="done"><header class="column-head"><span class="column-dot"></span><span class="column-title">Done</span><span class="count">0</span></header><div class="task-list"></div><button class="add" data-add="done">＋ 添加任务</button></article>
    <article class="column" data-column="on_hold"><header class="column-head"><span class="column-dot"></span><span class="column-title">搁置</span><span class="count">0</span></header><div class="task-list"></div><button class="add" data-add="on_hold">＋ 添加任务</button></article>
  </section></div>
</main>
</div>
<div id="modal" class="modal-backdrop hidden" role="dialog" aria-modal="true">
  <form class="modal" id="task-form">
    <h2 id="modal-title">添加任务</h2>
    <div class="field"><label for="task-title">标题</label><input id="task-title" maxlength="200" required></div>
    <div class="field"><label for="task-description">描述</label><textarea id="task-description" maxlength="20000"></textarea></div>
    <div class="modal-actions"><button type="button" id="cancel" class="ghost">取消</button><button type="submit" class="primary">保存</button></div>
  </form>
</div>
<div id="dm-modal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="dm-modal-title">
  <div class="modal">
    <h2 id="dm-modal-title">需要识别飞书用户</h2>
    <p style="color:var(--muted);line-height:1.7;margin:0 0 16px">请先给飞书机器人私聊发送任意消息。检测到私聊后，网页会自动继续创建主 Agent 群。</p>
    <div id="dm-detect-status" class="agent-status provisioning" style="margin-bottom:18px">正在等待私聊消息…</div>
    <div class="modal-actions"><button type="button" id="dm-cancel" class="ghost">取消</button><button type="button" id="dm-check" class="primary">立即检测</button></div>
  </div>
</div>
<div id="directory-modal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="directory-modal-title">
  <div class="modal directory-modal">
    <h2 id="directory-modal-title">选择工作目录</h2>
    <div class="directory-layout">
      <aside class="directory-sidebar"><div class="directory-label">快捷位置</div><div id="directory-locations" class="directory-locations"></div></aside>
      <section class="directory-main">
        <div class="directory-toolbar"><button type="button" id="directory-up" class="ghost" title="返回上级">↑</button><button type="button" id="directory-refresh" class="ghost" title="刷新">↻</button><input id="directory-path" aria-label="目录路径" spellcheck="false"></div>
        <div id="directory-list" class="directory-list"><div class="directory-empty">正在读取目录…</div></div>
        <div class="directory-footer"><label><input type="checkbox" id="directory-show-hidden">显示隐藏目录</label><span id="directory-selected" class="directory-selected">请选择当前目录或一个子目录</span></div>
      </section>
    </div>
    <div class="modal-actions"><button type="button" id="directory-cancel" class="ghost">取消</button><button type="button" id="directory-confirm" class="primary">选择当前文件夹</button></div>
  </div>
</div>
<div id="feature-modal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="feature-modal-title">
  <div class="modal">
    <h2 id="feature-modal-title">功能尚未实现</h2>
    <p id="feature-modal-message" style="color:var(--muted);line-height:1.7;margin:0 0 16px"></p>
    <div class="modal-actions"><button type="button" id="feature-modal-ok" class="primary">知道了</button></div>
  </div>
</div>
<div id="create-board-modal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="create-board-modal-title">
  <div class="modal">
    <h2 id="create-board-modal-title">新建看板</h2>
    <p style="color:var(--muted);line-height:1.7;margin:0 0 8px">这个路径还没有创建过看板，是否为这个路径新建看板？</p>
    <p id="create-board-path" style="word-break:break-all;background:var(--soft);border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:0 0 18px"></p>
    <div class="modal-actions"><button type="button" id="create-board-cancel" class="ghost">取消</button><button type="button" id="create-board-confirm" class="primary">新建看板</button></div>
  </div>
</div>
<div id="toast" class="toast hidden"></div>
<script>
(function(){
  var state={board:null,binding:null,workspaces:[],agentOptions:[],dragTaskId:null,modalTaskId:null,modalColumnId:null,relinkBoardId:null,pendingAgentId:null,pendingWorkspacePath:null,workspaceSelectionVersion:0,directoryLocations:[],directoryPath:null,directoryParentPath:null,directorySelectedPath:null,directoryBrowseVersion:0,contactTimer:null,contactChecking:false,mutationQueue:Promise.resolve()};
  var columns=['brainstorm','todo','doing','done','on_hold'];
  var recent=document.getElementById('recent');
  var pathInput=document.getElementById('workspace-path');
  var relinkButton=document.getElementById('relink');
  var saveState=document.getElementById('save-state');
  var mainAgentSelect=document.getElementById('main-agent');
  var mainAgentButton=document.getElementById('save-main-agent');

  async function api(path,options){
    var response=await fetch(path,Object.assign({headers:{'content-type':'application/json; charset=utf-8'}},options||{}));
    var data=await response.json().catch(function(){return {error:'响应不是有效 JSON'};});
    if(!response.ok){var error=new Error(data.error||('HTTP '+response.status));error.code=data.code;throw error;}
    return data;
  }
  function request(method,path,body){return api(path,{method:method,body:body===undefined?undefined:JSON.stringify(body)});}
  function setSaving(label,kind){saveState.textContent=label;saveState.className='save-state '+(kind||'');}
  function toast(message,error){var el=document.getElementById('toast');el.textContent=message;el.className='toast'+(error?' error':'');clearTimeout(toast.timer);toast.timer=setTimeout(function(){el.className='toast hidden';},3500);}
  function mutate(operation){
    if(!state.board)return Promise.resolve(false);
    state.mutationQueue=state.mutationQueue.then(async function(){
      setSaving('保存中…','saving');
      try{var result=await operation();state.board=result.board;if(Object.prototype.hasOwnProperty.call(result,'binding'))state.binding=result.binding;renderBoard();setSaving('已保存','');return true;}
      catch(error){setSaving('保存失败','error');if(error.code==='revision_conflict'){try{await reloadBoard();toast('其他页面修改了看板，已载入最新版本',true);}catch(reloadError){toast(reloadError.message,true);}}else toast(error.message,true);return false;}
    });
    return state.mutationQueue;
  }
  async function refreshWorkspaces(selectBoardId){
    var data=await api('/api/agent-team/workspaces');state.workspaces=data.workspaces||[];state.agentOptions=data.agentOptions||[];recent.innerHTML='<option value="">最近工作目录</option>';
    state.workspaces.forEach(function(item){var option=document.createElement('option');option.value=item.boardId;option.textContent=(item.exists?'':'⚠ ')+item.workspacePath;recent.appendChild(option);});
    if(selectBoardId)recent.value=selectBoardId;
    return data.defaultWorkspace;
  }
  async function openWorkspace(path,selectionVersion){
    if(!path||!path.trim())return toast('请输入工作目录',true);
    var version=selectionVersion===undefined?++state.workspaceSelectionVersion:selectionVersion;
    await state.mutationQueue;
    setSaving('加载中…','saving');
    try{var result=await request('POST','/api/agent-team/open',{workspacePath:path.trim()});if(version!==state.workspaceSelectionVersion)return;state.board=result.board;state.binding=result.binding||null;state.relinkBoardId=null;relinkButton.classList.add('hidden');pathInput.value=state.board.workspacePath;await refreshWorkspaces(state.board.boardId);if(version!==state.workspaceSelectionVersion)return;renderBoard();setSaving('已保存','');}
    catch(error){if(version!==state.workspaceSelectionVersion)return;setSaving('打开失败','error');toast(error.message,true);}
  }
  async function selectWorkspacePath(path){
    if(!path||!path.trim())return toast('请输入工作目录',true);
    var workspacePath=path.trim();var version=++state.workspaceSelectionVersion;
    await state.mutationQueue;
    setSaving('检查中…','saving');
    try{var lookup=await request('POST','/api/agent-team/lookup',{workspacePath:workspacePath});if(version!==state.workspaceSelectionVersion)return;if(lookup.exists)return openWorkspace(workspacePath,version);state.pendingWorkspacePath=workspacePath;pathInput.value=workspacePath;document.getElementById('create-board-path').textContent=workspacePath;document.getElementById('create-board-modal').classList.remove('hidden');setSaving(state.board?'已保存':'本地 JSON','');}
    catch(error){if(version!==state.workspaceSelectionVersion)return;setSaving('打开失败','error');toast(error.message,true);}
  }
  function closeCreateBoardModal(keepPath){document.getElementById('create-board-modal').classList.add('hidden');state.pendingWorkspacePath=null;if(!keepPath&&state.board)pathInput.value=state.board.workspacePath;}
  function showFeatureModal(feature){document.getElementById('feature-modal-message').textContent='“'+feature+'”功能还未实现，后续版本会开放。';document.getElementById('feature-modal').classList.remove('hidden');}
  function closeFeatureModal(){document.getElementById('feature-modal').classList.add('hidden');}
  function renderDirectoryLocations(){var root=document.getElementById('directory-locations');root.innerHTML='';state.directoryLocations.forEach(function(location){var button=document.createElement('button');button.type='button';button.className='directory-location';button.textContent=(location.kind==='drive'?'▣ ':'⌂ ')+location.label;button.title=location.path;button.addEventListener('click',function(){browseDirectory(location.path);});root.appendChild(button);});}
  function renderDirectoryEntries(entries){var root=document.getElementById('directory-list');root.innerHTML='';if(!entries.length){var empty=document.createElement('div');empty.className='directory-empty';empty.textContent='这个目录中没有可显示的子目录';root.appendChild(empty);return;}entries.forEach(function(entry){var row=document.createElement('button');row.type='button';row.className='directory-row';row.title='双击进入 '+entry.path;var icon=document.createElement('span');icon.className='directory-folder-icon';icon.textContent='▰';var name=document.createElement('span');name.textContent=entry.name;row.append(icon,name);row.addEventListener('click',function(){state.directorySelectedPath=entry.path;root.querySelectorAll('.directory-row').forEach(function(item){item.classList.remove('selected');});row.classList.add('selected');document.getElementById('directory-selected').textContent=entry.path;document.getElementById('directory-confirm').textContent='选择此文件夹';});row.addEventListener('dblclick',function(){browseDirectory(entry.path);});root.appendChild(row);});}
  async function browseDirectory(path){if(!path)return false;var version=++state.directoryBrowseVersion;var root=document.getElementById('directory-list');root.innerHTML='<div class="directory-empty">正在读取目录…</div>';document.getElementById('directory-path').value=path;try{var result=await request('POST','/api/agent-team/filesystem/directories',{path:path,showHidden:document.getElementById('directory-show-hidden').checked});if(version!==state.directoryBrowseVersion)return false;state.directoryPath=result.directory.path;state.directoryParentPath=result.directory.parentPath;state.directorySelectedPath=null;document.getElementById('directory-path').value=result.directory.path;document.getElementById('directory-up').disabled=!result.directory.parentPath;document.getElementById('directory-selected').textContent=result.directory.path;document.getElementById('directory-confirm').textContent='选择当前文件夹';renderDirectoryEntries(result.directory.entries||[]);return true;}catch(error){if(version!==state.directoryBrowseVersion)return false;root.innerHTML='';var empty=document.createElement('div');empty.className='directory-empty';empty.textContent=error.message;root.appendChild(empty);return false;}}
  async function openDirectoryModal(){state.directoryPath=null;state.directoryParentPath=null;state.directorySelectedPath=null;document.getElementById('directory-modal').classList.remove('hidden');document.getElementById('directory-locations').innerHTML='';document.getElementById('directory-list').innerHTML='<div class="directory-empty">正在读取目录…</div>';try{var result=await api('/api/agent-team/filesystem/locations');state.directoryLocations=result.locations||[];renderDirectoryLocations();var candidate=pathInput.value.trim()||(state.board&&state.board.workspacePath)||(state.directoryLocations[0]&&state.directoryLocations[0].path);var opened=await browseDirectory(candidate);if(!opened&&state.directoryLocations[0]&&state.directoryLocations[0].path!==candidate)await browseDirectory(state.directoryLocations[0].path);}catch(error){var root=document.getElementById('directory-list');root.innerHTML='';var empty=document.createElement('div');empty.className='directory-empty';empty.textContent=error.message;root.appendChild(empty);}}
  function closeDirectoryModal(){state.directoryBrowseVersion++;document.getElementById('directory-modal').classList.add('hidden');}
  async function confirmDirectorySelection(){var target=state.directorySelectedPath||state.directoryPath;if(!target)return;var button=document.getElementById('directory-confirm');button.disabled=true;try{var result=await request('POST','/api/agent-team/filesystem/validate-directory',{path:target});closeDirectoryModal();pathInput.value=result.path;if(!state.relinkBoardId)selectWorkspacePath(result.path);}catch(error){toast(error.message,true);}finally{button.disabled=false;}}
  async function reloadBoard(){if(!state.board)return;var result=await api('/api/agent-team/boards/'+encodeURIComponent(state.board.boardId));state.board=result.board;state.binding=result.binding||null;renderBoard();}
  function activeTasks(columnId){return state.board?state.board.tasks.filter(function(task){return !task.deletedAt&&task.columnId===columnId;}).sort(function(a,b){return a.order-b.order;}):[];}
  function renderBoard(){
    document.getElementById('workspace-name').textContent=state.board?state.board.workspacePath:'尚未打开工作目录';
    renderMainAgent();
    columns.forEach(function(columnId){var column=document.querySelector('[data-column="'+columnId+'"]');var list=column.querySelector('.task-list');var tasks=activeTasks(columnId);column.querySelector('.count').textContent=String(tasks.length);list.innerHTML='';
      if(!tasks.length){var empty=document.createElement('div');empty.className='empty';empty.textContent='暂无任务';list.appendChild(empty);}
      tasks.forEach(function(task){var card=document.createElement('article');card.className='task';card.draggable=true;card.dataset.taskId=task.id;
        var title=document.createElement('h3');title.textContent=task.title;card.appendChild(title);if(task.description){var desc=document.createElement('p');desc.textContent=task.description;card.appendChild(desc);}
        var actions=document.createElement('div');actions.className='task-actions';var edit=document.createElement('button');edit.type='button';edit.className='icon-btn';edit.textContent='编辑';edit.addEventListener('click',function(event){event.stopPropagation();showEdit(task);});var del=document.createElement('button');del.type='button';del.className='icon-btn';del.textContent='删';del.addEventListener('click',function(event){event.stopPropagation();removeTask(task);});actions.append(edit,del);card.appendChild(actions);
        card.addEventListener('dblclick',function(){showEdit(task);});card.addEventListener('dragstart',function(event){state.dragTaskId=task.id;card.classList.add('dragging');event.dataTransfer.effectAllowed='move';});card.addEventListener('dragend',function(){state.dragTaskId=null;card.classList.remove('dragging');document.querySelectorAll('.column').forEach(function(el){el.classList.remove('drag-over');});});list.appendChild(card);
      });
    });
  }
  function renderMainAgent(){
    var selected=state.board?(state.board.primaryAgentId||(state.binding&&state.binding.agentId)||''):'';mainAgentSelect.innerHTML='<option value="">选择主 Agent</option>';
    state.agentOptions.forEach(function(agent){var option=document.createElement('option');option.value=agent.id;option.textContent=agent.label;mainAgentSelect.appendChild(option);});
    mainAgentSelect.value=selected;mainAgentSelect.disabled=!state.board;mainAgentButton.disabled=!state.board||!mainAgentSelect.value;
    var status=document.getElementById('main-agent-status');var binding=state.binding;
    if(!state.board){status.textContent='请先打开一个项目';status.className='agent-status';mainAgentButton.textContent='设置';return;}
    if(!selected){status.textContent='尚未设置；设置后将创建“主Agent-'+state.board.workspacePath.split(/[\\/]/).pop()+'”群聊';status.className='agent-status';mainAgentButton.textContent='设置';return;}
    if(binding&&binding.status==='ready'){status.textContent='主 Agent 群已就绪';status.className='agent-status ready';}
    else if(binding&&binding.status==='error'){status.textContent='创建失败，可重新设置后重试';status.className='agent-status error';}
    else{status.textContent='正在准备主 Agent 群';status.className='agent-status provisioning';}
    mainAgentButton.textContent='保存';
  }
  function closeDmModal(){document.getElementById('dm-modal').classList.add('hidden');if(state.contactTimer){clearInterval(state.contactTimer);state.contactTimer=null;}state.contactChecking=false;}
  function showDmModal(){document.getElementById('dm-modal').classList.remove('hidden');document.getElementById('dm-detect-status').textContent='正在等待私聊消息…';if(state.contactTimer)clearInterval(state.contactTimer);state.contactTimer=setInterval(checkFeishuContact,1500);}
  async function checkFeishuContact(){if(state.contactChecking)return;state.contactChecking=true;try{var result=await api('/api/agent-team/feishu-contact');if(result.contact){var pending=state.pendingAgentId;closeDmModal();toast('已识别飞书私聊用户，继续创建主 Agent 群');if(pending)saveMainAgent(pending);}}catch(error){document.getElementById('dm-detect-status').textContent='检测失败：'+error.message;}finally{state.contactChecking=false;}}
  function saveMainAgent(agentId){
    if(!state.board||!agentId)return;state.pendingAgentId=agentId;
    state.mutationQueue=state.mutationQueue.then(async function(){setSaving('创建主 Agent…','saving');mainAgentButton.disabled=true;try{var result=await request('POST','/api/agent-team/boards/'+encodeURIComponent(state.board.boardId)+'/main-agent',{expectedRevision:state.board.revision,agentId:agentId});state.board=result.board;state.binding=result.binding;state.pendingAgentId=null;renderBoard();setSaving('已保存','');toast('主 Agent 群已就绪');return true;}catch(error){setSaving('设置失败','error');renderBoard();if(error.code==='feishu_dm_required')showDmModal();else if(error.code==='revision_conflict'){try{await reloadBoard();toast('其他页面修改了项目，已载入最新版本',true);}catch(reloadError){toast(reloadError.message,true);}}else toast(error.message,true);return false;}});return state.mutationQueue;
  }
  function showCreate(columnId){if(!state.board)return toast('请先打开一个工作目录',true);state.modalTaskId=null;state.modalColumnId=columnId;document.getElementById('modal-title').textContent='添加任务';document.getElementById('task-title').value='';document.getElementById('task-description').value='';document.getElementById('modal').classList.remove('hidden');setTimeout(function(){document.getElementById('task-title').focus();},0);}
  function showEdit(task){state.modalTaskId=task.id;state.modalColumnId=task.columnId;document.getElementById('modal-title').textContent='编辑任务';document.getElementById('task-title').value=task.title;document.getElementById('task-description').value=task.description;document.getElementById('modal').classList.remove('hidden');}
  function closeModal(){document.getElementById('modal').classList.add('hidden');state.modalTaskId=null;}
  function removeTask(task){if(!confirm('删除任务“'+task.title+'”？'))return;mutate(function(){return request('DELETE','/api/agent-team/boards/'+encodeURIComponent(state.board.boardId)+'/tasks/'+encodeURIComponent(task.id),{expectedRevision:state.board.revision});});}

  document.querySelectorAll('[data-add]').forEach(function(button){button.addEventListener('click',function(){showCreate(button.dataset.add);});});
  document.querySelectorAll('.column').forEach(function(column){
    column.addEventListener('dragover',function(event){if(!state.dragTaskId)return;event.preventDefault();column.classList.add('drag-over');event.dataTransfer.dropEffect='move';});column.addEventListener('dragleave',function(event){if(!column.contains(event.relatedTarget))column.classList.remove('drag-over');});
    column.addEventListener('drop',function(event){event.preventDefault();column.classList.remove('drag-over');if(!state.dragTaskId||!state.board)return;var columnId=column.dataset.column;var cards=Array.from(column.querySelectorAll('.task:not(.dragging)'));var index=cards.findIndex(function(card){return event.clientY<card.getBoundingClientRect().top+card.getBoundingClientRect().height/2;});if(index<0)index=cards.length;var taskId=state.dragTaskId;mutate(function(){return request('POST','/api/agent-team/boards/'+encodeURIComponent(state.board.boardId)+'/tasks/'+encodeURIComponent(taskId)+'/move',{expectedRevision:state.board.revision,columnId:columnId,index:index});});});
  });
  document.getElementById('task-form').addEventListener('submit',function(event){event.preventDefault();var title=document.getElementById('task-title').value;var description=document.getElementById('task-description').value;var taskId=state.modalTaskId;var columnId=state.modalColumnId;closeModal();mutate(function(){var root='/api/agent-team/boards/'+encodeURIComponent(state.board.boardId)+'/tasks';return taskId?request('PATCH',root+'/'+encodeURIComponent(taskId),{expectedRevision:state.board.revision,title:title,description:description}):request('POST',root,{expectedRevision:state.board.revision,title:title,description:description,columnId:columnId});});});
  document.getElementById('cancel').addEventListener('click',closeModal);document.getElementById('modal').addEventListener('click',function(event){if(event.target===event.currentTarget)closeModal();});
  document.querySelectorAll('[data-feature]').forEach(function(button){button.addEventListener('click',function(){showFeatureModal(button.dataset.feature);});});
  document.getElementById('feature-modal-ok').addEventListener('click',closeFeatureModal);document.getElementById('feature-modal').addEventListener('click',function(event){if(event.target===event.currentTarget)closeFeatureModal();});
  document.getElementById('directory-cancel').addEventListener('click',closeDirectoryModal);document.getElementById('directory-modal').addEventListener('click',function(event){if(event.target===event.currentTarget)closeDirectoryModal();});document.getElementById('directory-confirm').addEventListener('click',confirmDirectorySelection);document.getElementById('directory-up').addEventListener('click',function(){if(state.directoryParentPath)browseDirectory(state.directoryParentPath);});document.getElementById('directory-refresh').addEventListener('click',function(){if(state.directoryPath)browseDirectory(state.directoryPath);});document.getElementById('directory-show-hidden').addEventListener('change',function(){if(state.directoryPath)browseDirectory(state.directoryPath);});document.getElementById('directory-path').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();browseDirectory(event.currentTarget.value);}});
  document.getElementById('create-board-cancel').addEventListener('click',function(){closeCreateBoardModal(false);});document.getElementById('create-board-modal').addEventListener('click',function(event){if(event.target===event.currentTarget)closeCreateBoardModal(false);});document.getElementById('create-board-confirm').addEventListener('click',function(){var path=state.pendingWorkspacePath;if(!path)return;closeCreateBoardModal(true);openWorkspace(path);});
  mainAgentSelect.addEventListener('change',function(){mainAgentButton.disabled=!state.board||!mainAgentSelect.value;});mainAgentButton.addEventListener('click',function(){saveMainAgent(mainAgentSelect.value);});
  document.getElementById('dm-cancel').addEventListener('click',function(){state.pendingAgentId=null;closeDmModal();});document.getElementById('dm-check').addEventListener('click',checkFeishuContact);
  pathInput.addEventListener('change',function(){if(!state.relinkBoardId)selectWorkspacePath(pathInput.value);});pathInput.addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();if(!state.relinkBoardId)selectWorkspacePath(pathInput.value);}});
  document.getElementById('pick').addEventListener('click',openDirectoryModal);
  recent.addEventListener('change',function(){var item=state.workspaces.find(function(candidate){return candidate.boardId===recent.value;});if(!item)return;pathInput.value=item.workspacePath;if(item.exists){state.relinkBoardId=null;relinkButton.classList.add('hidden');openWorkspace(item.workspacePath);}else{state.relinkBoardId=item.boardId;relinkButton.classList.remove('hidden');api('/api/agent-team/boards/'+encodeURIComponent(item.boardId)).then(function(result){state.board=result.board;state.binding=result.binding||null;renderBoard();toast('原目录不存在，请选择新目录后重新关联',true);}).catch(function(error){toast(error.message,true);});}});
  relinkButton.addEventListener('click',function(){if(!state.relinkBoardId||!state.board)return toast('请先打开或选择需要关联的看板',true);mutate(function(){return request('POST','/api/agent-team/boards/'+encodeURIComponent(state.relinkBoardId)+'/relink',{expectedRevision:state.board.revision,workspacePath:pathInput.value});}).then(function(saved){if(!saved)return;refreshWorkspaces(state.board.boardId);state.relinkBoardId=null;relinkButton.classList.add('hidden');});});
  refreshWorkspaces().then(function(defaultWorkspace){pathInput.value=defaultWorkspace;return selectWorkspacePath(defaultWorkspace);}).catch(function(error){toast(error.message,true);});
})();
</script>
</body>
</html>`;
