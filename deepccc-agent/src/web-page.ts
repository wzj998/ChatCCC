import { WEB_TOOL_SUMMARY_RULES } from "./web-tool-presentation.js";

const WEB_TOOL_SUMMARY_RULES_JSON = JSON.stringify(WEB_TOOL_SUMMARY_RULES).replace(/</g, "\\u003c");

export const DEEPCCC_WEB_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepCCC</title>
<style>
:root{color-scheme:light;--bg:#f5f7fb;--panel:#fff;--panel2:#fff;--soft:#f8f9fc;--line:#e3e7ef;--text:#182033;--muted:#737d91;--accent:#6758e8;--accent-soft:#eeeaff;--accent2:#23825d;--danger:#c2415a;--warning:#b7791f;--shadow:0 8px 28px rgba(26,35,58,.08)}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden}button,input,select,textarea{font:inherit}button{cursor:pointer}.app{height:100%;display:grid;grid-template-columns:286px minmax(0,1fr)}
.sidebar{min-width:0;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column}.brand{height:70px;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--line)}.mark{width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:var(--accent);color:#fff;box-shadow:0 9px 25px rgba(103,88,232,.25);font-weight:900}.brand-copy strong{display:block;font-size:16px;letter-spacing:.01em}.brand-copy span{font-size:10px;color:var(--muted);letter-spacing:.13em}.sidebar-actions{display:flex;gap:8px;padding:14px}.primary,.ghost,.icon{border:1px solid var(--line);border-radius:10px;color:var(--text);background:var(--panel);font-weight:700}.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 8px 22px rgba(103,88,232,.22)}.sidebar-actions .primary{flex:1;padding:10px}.icon{width:40px;padding:0;font-size:17px}.ghost{padding:9px 12px}.primary:hover,.ghost:hover,.icon:hover{filter:brightness(1.03)}
.session-list{flex:1;overflow:auto;padding:0 10px 14px}.session-empty{padding:38px 18px;color:var(--muted);text-align:center}.session-item{width:100%;display:block;padding:12px;border:1px solid transparent;border-radius:12px;background:transparent;color:var(--text);text-align:left;margin:3px 0}.session-item:hover{background:var(--panel2)}.session-item.active{background:linear-gradient(135deg,rgba(124,105,241,.2),rgba(93,74,207,.08));border-color:rgba(139,124,246,.35)}.session-title{display:flex;align-items:center;gap:8px;font-weight:750}.status-dot{width:7px;height:7px;border-radius:50%;background:#626a78}.status-dot.running{background:var(--accent2);box-shadow:0 0 0 4px rgba(94,228,177,.1)}.session-meta{margin-top:5px;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sidebar-foot{padding:12px 16px;border-top:1px solid var(--line);color:var(--muted);font-size:10px;display:flex;justify-content:space-between}
.main{min-width:0;height:100%;display:flex;flex-direction:column}.topbar{height:70px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid var(--line);background:rgba(12,14,19,.7);backdrop-filter:blur(18px)}.session-heading{min-width:0}.session-heading h1{font-size:16px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.session-heading p{font-size:11px;color:var(--muted);margin:3px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top-actions{display:flex;gap:8px}.top-actions button{height:38px}.content{flex:1;min-height:0;overflow-y:auto;scroll-behavior:smooth}.welcome{height:100%;display:grid;place-items:center;padding:30px}.welcome-card{max-width:650px;text-align:center}.welcome-mark{width:72px;height:72px;margin:0 auto 20px;border-radius:24px;display:grid;place-items:center;background:linear-gradient(135deg,#7764eb,#b45fd7);font-size:29px;box-shadow:0 20px 50px rgba(119,100,235,.28)}.welcome h2{font-size:28px;margin:0 0 10px;letter-spacing:-.02em}.welcome p{color:var(--muted);margin:0 auto;max-width:480px}.hint-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:28px}.hint{padding:14px;border:1px solid var(--line);border-radius:13px;background:rgba(24,28,37,.65);font-size:12px;color:var(--muted)}
.thread{width:min(900px,calc(100% - 36px));margin:0 auto;padding:28px 0 150px}.empty-thread{margin:80px auto 0;max-width:520px;padding:28px;border:1px dashed #353c4a;border-radius:18px;background:rgba(20,23,31,.55);text-align:center}.empty-thread strong{display:block;font-size:18px;margin-bottom:7px}.empty-thread span{color:var(--muted);font-size:12px}.message{display:grid;grid-template-columns:30px minmax(0,1fr);gap:12px;margin:0 0 22px}.avatar{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;background:var(--soft);font-size:11px;font-weight:900}.message.user .avatar{background:#304058}.message.assistant .avatar{background:linear-gradient(135deg,#7363e8,#9a61dc)}.bubble{min-width:0;padding:2px 0;color:#dfe3eb}.bubble .role{font-size:11px;color:var(--muted);font-weight:800;margin-bottom:7px}.markdown{font-size:14px;line-height:1.75;overflow-wrap:anywhere}.markdown p{margin:.35em 0}.markdown pre{padding:14px;border:1px solid var(--line);border-radius:11px;background:#0a0c11;overflow:auto;font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace}.markdown code{padding:2px 5px;border-radius:5px;background:var(--soft);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.markdown pre code{padding:0;background:transparent}.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6{margin:.85em 0 .45em;line-height:1.35;font-weight:800}.markdown h1{font-size:1.5em}.markdown h2{font-size:1.32em}.markdown h3{font-size:1.16em}.markdown h4{font-size:1.05em}.markdown h5,.markdown h6{font-size:1em}.markdown ul,.markdown ol{margin:.35em 0;padding-left:1.6em}.markdown li{margin:.15em 0}.markdown blockquote{margin:.6em 0;padding:2px 0 2px 14px;border-left:3px solid var(--line);color:var(--muted)}.markdown a{color:var(--accent);text-decoration:none}.markdown a:hover{text-decoration:underline}.markdown hr{border:0;border-top:1px solid var(--line);margin:1.1em 0}.markdown table{border-collapse:collapse;margin:.7em 0;width:100%}.markdown th,.markdown td{border:1px solid var(--line);padding:7px 11px;text-align:left;font-size:13px;vertical-align:top}.markdown th{background:var(--soft);font-weight:800}.markdown tr:nth-child(2n) td{background:var(--soft)}.tool-card{margin:8px 0;border:1px solid var(--line);border-radius:10px;background:var(--panel);overflow:hidden}.tool-card summary{padding:9px 11px;color:#bbc2d0;font-size:12px;font-weight:700}.tool-card pre{margin:0;border:0;border-top:1px solid var(--line);border-radius:0;max-height:260px}.tool-status{display:inline-flex;align-items:center;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:800}.tool-status.pending{background:#fff0c2;color:#8a6110}.tool-status.ok{background:#e5f5ee;color:#23825d}.tool-status.error{background:#fde4e9;color:#c2415a}.run-state{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;margin:8px 0 20px}.pulse{width:8px;height:8px;border-radius:50%;background:var(--accent2);animation:pulse 1.4s infinite}@keyframes pulse{50%{opacity:.35;transform:scale(.72)}}.workspace-warning{width:min(900px,calc(100% - 36px));margin:14px auto 0;padding:9px 12px;border:1px solid rgba(242,184,75,.3);background:rgba(242,184,75,.08);border-radius:10px;color:#e8c879;font-size:11px}
.composer-shell{position:absolute;left:286px;right:0;bottom:0;padding:0 20px 18px;background:linear-gradient(transparent,var(--bg) 32%)}.composer{width:min(900px,100%);margin:auto;border:1px solid #343b49;border-radius:17px;background:rgba(25,29,38,.96);box-shadow:var(--shadow);overflow:hidden}.composer textarea{width:100%;min-height:68px;max-height:180px;resize:none;border:0;outline:0;padding:15px 16px 8px;background:transparent;color:var(--text)}.composer textarea::placeholder{color:#737b8b}.composer-bar{display:flex;align-items:center;gap:8px;padding:7px 9px}.composer-bar input,.composer-bar select{min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--muted);padding:7px 9px;font-size:11px}.composer-bar input{width:180px}.composer-bar select{width:104px}.send{margin-left:auto;width:36px;height:36px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:17px}.stop{margin-left:auto;height:36px;border:1px solid rgba(255,111,137,.4);border-radius:10px;background:rgba(255,111,137,.12);color:#ff91a5;padding:0 13px;font-weight:700}.composer-disabled{opacity:.5;pointer-events:none}
.attachment-drafts{display:flex;gap:8px;padding:0 12px;overflow-x:auto}.attachment-draft{position:relative;flex:none;width:74px}.attachment-draft img{width:74px;height:54px;object-fit:cover;border:1px solid var(--line);border-radius:9px;background:var(--soft)}.attachment-draft button{position:absolute;right:-5px;top:-6px;width:20px;height:20px;padding:0;border:1px solid var(--line);border-radius:50%;background:#fff;color:var(--danger);font-weight:900}.attach{width:36px;height:36px;border:1px solid var(--line);border-radius:10px;background:var(--soft);color:var(--muted);font-size:17px}.image-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px;margin-top:10px;max-width:650px}.image-card{display:block;border:1px solid var(--line);border-radius:11px;background:var(--soft);overflow:hidden;color:var(--text);text-decoration:none}.image-card img{display:block;width:100%;height:150px;object-fit:cover;background:#eef1f6}.image-card span{display:block;padding:7px 9px;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.composer.dragging{outline:2px solid var(--accent);outline-offset:2px}
.tool-card summary{display:flex;align-items:center;gap:8px;min-width:0}.tool-summary-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-weight:700}.tool-section{border-top:1px solid var(--line)}.tool-section-title{padding:7px 11px 0;color:var(--muted);font-size:10px;font-weight:800;letter-spacing:.04em}.tool-card .tool-section pre{margin:0;border:0;background:var(--soft);max-height:none;white-space:pre-wrap;overflow-wrap:anywhere}.tool-overflow-toggle{margin:0 11px 9px;padding:5px 9px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--accent);font-size:10px;font-weight:700}
.modal-backdrop{position:fixed;inset:0;z-index:30;display:grid;place-items:center;padding:20px;background:rgba(4,5,8,.66);backdrop-filter:blur(7px)}.modal-backdrop.hidden{display:none}.modal{width:min(560px,100%);max-height:calc(100vh - 40px);overflow:auto;border:1px solid #353c4a;border-radius:18px;background:#171a22;box-shadow:0 30px 100px rgba(0,0,0,.55);padding:22px}.modal h2{margin:0 0 5px;font-size:20px}.modal>.subtitle{margin:0 0 20px;color:var(--muted);font-size:12px}.field{display:grid;gap:7px;margin:13px 0}.field label{font-size:11px;color:#b7becb;font-weight:800}.field input,.field select{width:100%;border:1px solid var(--line);border-radius:10px;background:#10131a;color:var(--text);padding:10px 11px;outline:none}.field input:focus,.field select:focus{border-color:var(--accent)}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.check{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.danger{border:1px solid rgba(255,111,137,.35);background:rgba(255,111,137,.1);color:#ff849b;border-radius:10px;padding:9px 12px;font-weight:700}.approval{width:min(620px,100%)}.approval-badge{display:inline-flex;padding:5px 8px;border-radius:999px;background:rgba(242,184,75,.13);color:#f1c565;font-size:10px;font-weight:900}.approval pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:13px;border:1px solid var(--line);border-radius:10px;background:#0d0f15;color:#dce0e9}.approval-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.toast{position:fixed;right:20px;top:20px;z-index:50;max-width:420px;padding:11px 14px;border-radius:10px;background:#283143;border:1px solid #3b465b;box-shadow:var(--shadow)}.toast.error{background:#602536;border-color:#913a52}.hidden{display:none!important}
.topbar{background:rgba(255,255,255,.86)}.welcome-mark{background:var(--accent);color:#fff}.hint,.empty-thread{background:var(--panel);border-color:var(--line)}.session-item.active{background:var(--accent-soft);border-color:#d8d1ff}.status-dot{background:#a3aabd}.status-dot.running{background:var(--accent2);box-shadow:0 0 0 4px rgba(35,130,93,.1)}.message.user .avatar{background:#e8edf6}.message.assistant .avatar{background:var(--accent);color:#fff}.bubble{color:var(--text)}.markdown pre,.tool-card pre{background:var(--soft);color:var(--text)}.tool-card summary{color:var(--muted)}.composer{border-color:var(--line);background:rgba(255,255,255,.98)}.composer textarea::placeholder{color:#9aa3b4}.composer-bar input,.composer-bar select{background:var(--soft)}.modal-backdrop{background:rgba(24,32,51,.36)}.modal{border-color:var(--line);background:var(--panel);box-shadow:0 28px 90px rgba(35,43,65,.24)}.field label{color:var(--text)}.field input,.field select{background:var(--soft);color:var(--text)}.danger{border-color:#f3c4ce;background:#fff1f3;color:var(--danger)}.toast{background:#253047;color:#fff}.toast.error{background:#9f2942}.approval-card{margin:16px 0;padding:14px;border:1px solid #ead49b;border-radius:13px;background:#fffaf0;box-shadow:0 5px 18px rgba(94,70,15,.06)}.approval-card.resolved{border-color:var(--line);background:var(--soft)}.approval-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.approval-head strong{font-size:12px}.approval-status{padding:3px 7px;border-radius:999px;background:#fff0c2;color:#8a6110;font-size:10px;font-weight:800}.approval-card.resolved .approval-status{background:#e5f5ee;color:var(--accent2)}.approval-detail{color:var(--muted);font-size:11px;margin-bottom:8px}.approval-command{margin:0;padding:10px;border:1px solid var(--line);border-radius:9px;background:#fff;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.approval-inline-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.approval-inline-actions button{padding:7px 10px;font-size:11px}
.sidebar{height:100%;overflow:hidden}.main{min-height:0!important;overflow:hidden}
@media(max-width:760px){.app{grid-template-columns:78px minmax(0,1fr)}.brand{padding:0;justify-content:center}.brand-copy,.sidebar-actions .primary,.session-item>div:not(.session-title),.session-title span:last-child,.sidebar-foot{display:none}.sidebar-actions{justify-content:center;padding:12px 8px}.session-item{padding:11px;display:grid;place-items:center}.composer-shell{left:78px}.hint-grid{grid-template-columns:1fr}.topbar{padding:0 14px}.thread{width:calc(100% - 24px)}.row{grid-template-columns:1fr}.approval-inline-actions{display:grid;grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="mark">D</div><div class="brand-copy"><strong>DeepCCC</strong><span>LOCAL AGENT</span></div></div>
    <div class="sidebar-actions"><button id="new-session" class="primary">＋ 新建会话</button><button id="open-settings" class="icon" title="API 设置">⚙</button></div>
    <div id="session-list" class="session-list"></div>
    <div class="sidebar-foot"><span>127.0.0.1</span><span id="server-port">28080</span></div>
  </aside>
  <main class="main">
    <header class="topbar"><div class="session-heading"><h1 id="session-title">DeepCCC</h1><p id="session-cwd">选择或创建一个会话</p></div><div class="top-actions"><button id="rename-session" class="ghost hidden">重命名</button><button id="delete-session" class="danger hidden">删除</button></div></header>
    <div id="warning" class="workspace-warning hidden"></div>
    <section id="content" class="content"><div class="welcome"><div class="welcome-card"><div class="welcome-mark">✦</div><h2>把工作交给 DeepCCC</h2><p>在浏览器里管理多个本地 Coding Agent 会话，切换模型与推理强度，并在会话内审批操作。</p><div class="hint-grid"><div class="hint">多会话并行运行</div><div class="hint">本地文件与历史</div><div class="hint">API 自由配置</div></div></div></div></section>
  </main>
</div>
<div id="composer-shell" class="composer-shell hidden"><div id="composer" class="composer"><textarea id="prompt" placeholder="描述你想完成的任务…可粘贴或拖入图片"></textarea><div id="attachment-drafts" class="attachment-drafts"></div><div class="composer-bar"><input id="attachment-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden><button id="attach-image" class="attach" type="button" title="添加图片">＋</button><input id="session-model" list="recent-models" aria-label="模型"><input id="session-sub-model" list="recent-models" aria-label="子模型" placeholder="默认子模型"><datalist id="recent-models"></datalist><select id="session-effort" aria-label="推理强度"><option value="">默认 effort</option><option>none</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select><button id="send" class="send" title="发送">↑</button><button id="stop" class="stop hidden">■ 停止</button></div></div></div>

<div id="new-modal" class="modal-backdrop hidden"><form id="new-form" class="modal"><h2>新建 Agent 会话</h2><p class="subtitle">每个会话拥有独立上下文；同目录会话可以并发，但文件修改可能冲突。</p><div class="field"><label>工作目录</label><input id="new-cwd" required></div><div class="field"><label>会话名称（可选）</label><input id="new-title" placeholder="默认使用目录名"></div><div class="row"><div class="field"><label>模型</label><input id="new-model" list="recent-models"></div><div class="field"><label>子模型（可选）</label><input id="new-sub-model" list="recent-models"></div></div><div class="field"><label>Effort</label><select id="new-effort"><option value="">默认</option><option>none</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></div><div class="modal-actions"><button type="button" data-close="new-modal" class="ghost">取消</button><button class="primary" type="submit">创建会话</button></div></form></div>

<div id="settings-modal" class="modal-backdrop hidden"><form id="settings-form" class="modal"><h2>API 与 Web 设置</h2><p class="subtitle">单一 API 配置作为所有新会话的默认值；会话可单独覆盖模型和 effort。</p><div class="row"><div class="field"><label>API 协议</label><select id="cfg-provider"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option></select></div><div class="field"><label>API Key</label><input id="cfg-api-key" type="password" placeholder="留空保留当前 Key"></div></div><div class="field"><label>Base URL</label><input id="cfg-base-url" required></div><div class="row"><div class="field"><label>默认模型</label><input id="cfg-model" required></div><div class="field"><label>子模型（可选）</label><input id="cfg-sub-model"></div></div><div class="row"><div class="field"><label>默认 Effort</label><select id="cfg-effort"><option value="">不传</option><option>none</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></div><div class="field"><label>Context Window</label><input id="cfg-context" type="number" min="1"></div></div><div class="row"><div class="field"><label>Web 端口</label><input id="cfg-port" type="number" min="1" max="65535"></div><div class="field"><label>Max Output Tokens（可选）</label><input id="cfg-max-output" type="number" min="1"></div></div><label class="check"><input id="cfg-streaming" type="checkbox">启用流式请求</label><label class="check"><input id="cfg-open" type="checkbox">运行 deepccc web 时自动打开浏览器</label><div id="key-state" class="subtitle"></div><div class="modal-actions"><button type="button" data-close="settings-modal" class="ghost">取消</button><button class="primary" type="submit">保存设置</button></div></form></div>

<div id="rename-modal" class="modal-backdrop hidden"><form id="rename-form" class="modal"><h2>重命名会话</h2><div class="field"><label>名称</label><input id="rename-title" required maxlength="120"></div><div class="modal-actions"><button type="button" data-close="rename-modal" class="ghost">取消</button><button class="primary">保存</button></div></form></div>

<div id="toast" class="toast hidden"></div>
<script>
(function(){
  var toolSummaryRules=${WEB_TOOL_SUMMARY_RULES_JSON};
  var state={sessions:[],selectedId:null,detail:null,config:null,eventSource:null,globalEventSource:null,reloadTimer:null,sessionsReloadTimer:null,detailRequestToken:0,configDrafts:{},promptDrafts:{},attachmentDrafts:{},uploading:false,renderQueued:false};
  var $=function(id){return document.getElementById(id);};
  async function api(path,options){var response=await fetch(path,Object.assign({headers:{'content-type':'application/json; charset=utf-8'}},options||{}));var data=await response.json().catch(function(){return {error:'响应不是有效 JSON'};});if(!response.ok)throw new Error(data.error||('HTTP '+response.status));return data;}
  function toast(message,error){var el=$('toast');el.textContent=message;el.className='toast'+(error?' error':'');clearTimeout(toast.timer);toast.timer=setTimeout(function(){el.className='toast hidden';},3500);}
  function openModal(id){$(id).classList.remove('hidden');}function closeModal(id){$(id).classList.add('hidden');}
  function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
  function markdown(value){
  var text = escapeHtml(value == null ? '' : String(value));
  var tick = String.fromCharCode(96);
  var NL = String.fromCharCode(10);
  var fence = tick + tick + tick;
  var blocks = [];
  var lines = text.split(NL);
  var out = [];
  var i = 0;
  var listStack = [];
  var inFence = false;
  var fenceLang = '';
  var fenceBuf = [];
  var gt = '&gt;';
  function closeLists(){ while(listStack.length){ out.push(listStack.pop()); } }
  function restore(s, prefix, items){
    var result = '';
    var endMark = '@@';
    while(true){
      var idx = s.indexOf(prefix);
      if(idx < 0){ result += s; break; }
      result += s.slice(0, idx);
      var numStart = idx + prefix.length;
      var end = s.indexOf(endMark, numStart);
      if(end < 0){ result += s.slice(idx); break; }
      var num = Number(s.slice(numStart, end));
      result += items[num] == null ? '' : items[num];
      s = s.slice(end + endMark.length);
    }
    return result;
  }
  function safeHref(url){
    var value = String(url || '').trim();
    var lower = value.toLowerCase();
    if(lower.indexOf('https://') === 0 || lower.indexOf('http://') === 0 || lower.indexOf('mailto:') === 0 || lower.charAt(0) === '#' || lower.charAt(0) === '/') return value;
    return '#';
  }
  function inline(s){
    var codes = [];
    s = s.replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), function(_, code){
      codes.push('<code>' + code + '</code>');
      return '@@CODE' + (codes.length - 1) + '@@';
    });
    var linked = '';
    while(true){
      var open = s.indexOf('[');
      if(open < 0){ linked += s; break; }
      linked += s.slice(0, open);
      var mid = s.indexOf('](', open + 1);
      if(mid < 0){ linked += s.slice(open); break; }
      var close = s.indexOf(')', mid + 2);
      if(close < 0){ linked += s.slice(open); break; }
      var label = s.slice(open + 1, mid);
      var url = s.slice(mid + 2, close);
      linked += '<a href="' + safeHref(url) + '" target="_blank" rel="noopener">' + label + '</a>';
      s = s.slice(close + 1);
    }
    s = linked;
    s = s.replace(new RegExp('[*][*]([^*]+)[*][*]', 'g'), '<strong>$1</strong>');
    s = s.replace(new RegExp('[*]([^*]+)[*]', 'g'), '<em>$1</em>');
    return restore(s, '@@CODE', codes);
  }
  function splitRow(line){
    var s = line.trim();
    if(s.charAt(0) === '|') s = s.slice(1);
    if(s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|');
  }
  function alignOf(cell){
    var t = cell.trim();
    var left = t.charAt(0) === ':';
    var right = t.charAt(t.length - 1) === ':' && t.length > 1;
    if(left && right) return 'center';
    if(right) return 'right';
    if(left) return 'left';
    return '';
  }
  function isHr(t){
    if(t.length < 3) return false;
    var ch = t.charAt(0);
    if(ch !== '-' && ch !== '*' && ch !== '_') return false;
    for(var k = 0; k < t.length; k++){
      var c = t.charAt(k);
      if(c !== ch && c !== ' ') return false;
    }
    return true;
  }
  function isTableSep(t){
    if(t.indexOf('|') < 0 || t.indexOf('-') < 0) return false;
    for(var k = 0; k < t.length; k++){
      var c = t.charAt(k);
      if(c !== '|' && c !== '-' && c !== ':' && c !== ' ') return false;
    }
    return true;
  }
  function tableAt(start){
    var header = lines[start];
    if(!header || header.indexOf('|') < 0) return null;
    var sep = lines[start + 1];
    if(sep === undefined || !isTableSep(sep)) return null;
    var heads = splitRow(header);
    var sepCells = splitRow(sep);
    var aligns = [];
    for(var a = 0; a < sepCells.length; a++) aligns.push(alignOf(sepCells[a]));
    var rows = [];
    var j = start + 2;
    while(j < lines.length && lines[j].indexOf('|') >= 0 && lines[j].trim() !== ''){
      rows.push(splitRow(lines[j]));
      j++;
    }
    var html = '<table><thead><tr>';
    for(var h = 0; h < heads.length; h++){
      html += '<th' + (aligns[h] ? ' style="text-align:' + aligns[h] + '"' : '') + '>' + inline(heads[h].trim()) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for(var r = 0; r < rows.length; r++){
      html += '<tr>';
      for(var c = 0; c < rows[r].length; c++){
        html += '<td' + (aligns[c] ? ' style="text-align:' + aligns[c] + '"' : '') + '>' + inline(rows[r][c].trim()) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return { html: html, next: j };
  }
  function isHeading(t){
    if(t.charAt(0) !== '#') return -1;
    var n = 0;
    while(n < t.length && n < 6 && t.charAt(n) === '#') n++;
    return t.charAt(n) === ' ' ? n : -1;
  }
  function isOrdered(t){
    var k = 0;
    while(k < t.length && t.charAt(k) >= '0' && t.charAt(k) <= '9') k++;
    if(k === 0 || k >= t.length) return -1;
    var ch = t.charAt(k);
    if((ch === '.' || ch === ')') && t.charAt(k + 1) === ' ') return k + 2;
    return -1;
  }
  while(i < lines.length){
    var line = lines[i];
    if(inFence){
      if(line.trim().slice(0, 3) === fence){
        blocks.push('<pre><code data-lang="' + fenceLang + '">' + fenceBuf.join(NL) + '</code></pre>');
        out.push('@@BLOCK' + (blocks.length - 1) + '@@');
        inFence = false;
        fenceBuf = [];
        fenceLang = '';
      } else {
        fenceBuf.push(line);
      }
      i++;
      continue;
    }
    var trimmed = line.trim();
    if(trimmed.slice(0, 3) === fence){
      inFence = true;
      fenceLang = trimmed.slice(3).trim();
      fenceBuf = [];
      i++;
      continue;
    }
    var table = tableAt(i);
    if(table){
      closeLists();
      out.push(table.html);
      i = table.next;
      continue;
    }
    var headingLevel = isHeading(trimmed);
    if(headingLevel > 0){
      closeLists();
      out.push('<h' + headingLevel + '>' + inline(trimmed.slice(headingLevel + 1).trim()) + '</h' + headingLevel + '>');
      i++;
      continue;
    }
    if(isHr(trimmed)){
      closeLists();
      out.push('<hr>');
      i++;
      continue;
    }
    if(trimmed === gt || trimmed.slice(0, gt.length + 1) === gt + ' '){
      closeLists();
      var quote = [];
      while(i < lines.length){
        var q = lines[i].trim();
        if(q === gt || q.slice(0, gt.length + 1) === gt + ' '){
          quote.push(q === gt ? '' : q.slice(gt.length + 1));
          i++;
        } else {
          break;
        }
      }
      out.push('<blockquote><p>' + inline(quote.join('<br>')) + '</p></blockquote>');
      continue;
    }
    var c0 = trimmed.charAt(0);
    if((c0 === '-' || c0 === '*' || c0 === '+') && trimmed.charAt(1) === ' '){
      if(listStack[listStack.length - 1] !== '</ul>'){
        closeLists();
        out.push('<ul>');
        listStack.push('</ul>');
      }
      out.push('<li>' + inline(trimmed.slice(2).trim()) + '</li>');
      i++;
      continue;
    }
    var orderedAt = isOrdered(trimmed);
    if(orderedAt > 0){
      if(listStack[listStack.length - 1] !== '</ol>'){
        closeLists();
        out.push('<ol>');
        listStack.push('</ol>');
      }
      out.push('<li>' + inline(trimmed.slice(orderedAt).trim()) + '</li>');
      i++;
      continue;
    }
    if(trimmed === ''){
      closeLists();
      i++;
      continue;
    }
    closeLists();
    var para = [];
    while(i < lines.length){
      var l = lines[i];
      var t = l.trim();
      if(t === '') break;
      if(t.slice(0, 3) === fence) break;
      if(isHeading(t) > 0) break;
      var cc0 = t.charAt(0);
      if((cc0 === '-' || cc0 === '*' || cc0 === '+') && t.charAt(1) === ' ') break;
      if(isOrdered(t) > 0) break;
      if(t === gt || t.slice(0, gt.length + 1) === gt + ' ') break;
      if(isHr(t)) break;
      if(t.indexOf('|') >= 0 && tableAt(i)) break;
      para.push(t);
      i++;
    }
    if(para.length){ out.push('<p>' + inline(para.join('<br>')) + '</p>'); }
  }
  if(inFence){
    blocks.push('<pre><code data-lang="' + fenceLang + '">' + fenceBuf.join(NL) + '</code></pre>');
    out.push('@@BLOCK' + (blocks.length - 1) + '@@');
  }
  closeLists();
  return restore(out.join(NL), '@@BLOCK', blocks);
}
  function statusText(status){return status==='running'?'执行中':'空闲';}
  function renderSessions(){var root=$('session-list');root.innerHTML='';if(!state.sessions.length){root.innerHTML='<div class="session-empty">还没有会话<br>点击上方按钮开始</div>';return;}state.sessions.forEach(function(session){var button=document.createElement('button');button.className='session-item'+(session.sessionId===state.selectedId?' active':'');button.innerHTML='<div class="session-title"><i class="status-dot '+session.status+'"></i><span>'+escapeHtml(session.title)+'</span></div><div class="session-meta">'+escapeHtml(session.model||'默认模型')+' · '+escapeHtml(session.effort||'默认 effort')+'</div><div class="session-meta">'+escapeHtml(session.cwd)+'</div>';button.addEventListener('click',function(){selectSession(session.sessionId).catch(function(error){toast(error.message,true);});});root.appendChild(button);});}
  function decodeAttachmentMessage(content){var start=content.indexOf('<deepccc-attachments>');var end=content.indexOf('</deepccc-attachments>',start);if(start<0||end<0)return{text:content,attachments:[]};var attachments=[];try{attachments=JSON.parse(content.slice(start+21,end).trim());if(!Array.isArray(attachments))attachments=[];}catch(error){}return{text:content.slice(0,start).trim(),attachments:attachments};}
  function attachmentUrl(sessionId,id){return '/api/sessions/'+encodeURIComponent(sessionId)+'/attachments/'+encodeURIComponent(id);}
  function attachmentGallery(items,sessionId){if(!items||!items.length)return'';return '<div class="image-gallery">'+items.map(function(item){var url=attachmentUrl(sessionId,item.attachmentId);return '<a class="image-card" href="'+escapeHtml(url)+'" target="_blank"><img src="'+escapeHtml(url)+'" alt="'+escapeHtml(item.originalName)+'"><span>'+escapeHtml(item.originalName)+'</span></a>';}).join('')+'</div>';}
  function artifactFromOutput(output){try{var value=typeof output==='string'?JSON.parse(output):output;return value&&typeof value.path==='string'&&String(value.mimeType||'').indexOf('image/')===0?value:null;}catch(error){return null;}}
  function artifactGallery(toolCalls,sessionId){var items=(toolCalls||[]).filter(function(call){return call.name==='present_file';}).map(function(call){return artifactFromOutput(call.output);}).filter(Boolean);if(!items.length)return'';return '<div class="image-gallery">'+items.map(function(item){var url='/api/sessions/'+encodeURIComponent(sessionId)+'/artifact?path='+encodeURIComponent(item.path);return '<a class="image-card" href="'+escapeHtml(url)+'" target="_blank"><img src="'+escapeHtml(url)+'" alt="'+escapeHtml(item.caption||item.name)+'"><span>'+escapeHtml(item.caption||item.name)+'</span></a>';}).join('')+'</div>';}
  function withoutToolTranscript(content){var marker='\\n\\n[工具记录]\\n';var index=content.indexOf(marker);return index>=0?content.slice(0,index):content;}
  function tryToolJson(value){if(typeof value!=='string')return value;var text=value.trim();if(!text||(['{','['].indexOf(text.charAt(0))<0))return value;try{return JSON.parse(text);}catch(error){return value;}}
  function toolRecord(value){var parsed=tryToolJson(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}
  function toolOneLine(value){if(value==null)return'';var text=typeof value==='string'?value:JSON.stringify(value);return text.split(String.fromCharCode(10)).join(' ').trim().slice(0,220);}
  function toolFormatBytes(value){if(value<1024)return value+' B';if(value<1024*1024)return(value/1024).toFixed(1)+' KB';return(value/1024/1024).toFixed(1)+' MB';}
  function toolResultSummary(call){var output=toolRecord(call.output);if(call.isError)return toolOneLine(output.message||call.output)||'失败';if(typeof output.exitCode==='number')return'exit '+output.exitCode;if(Array.isArray(output.entries))return output.entries.length+' 项';if(Array.isArray(output.matches))return output.matches.length+' 条匹配';if(Array.isArray(output.changedFiles))return output.changedFiles.length+' 个文件';if(Array.isArray(output.results))return output.results.length+' 条结果';if(typeof output.size==='number')return toolFormatBytes(output.size);if(call.name==='task'&&typeof output.result==='string')return'已返回结果';return'完成';}
  function toolSummary(call){var rule=toolSummaryRules[call.name]||{emoji:'🔧',inputFields:[]};var input=toolRecord(call.input);var details=(rule.inputFields||[]).map(function(field){return toolOneLine(input[field]);}).filter(Boolean);if(!call.pending)details.push(toolResultSummary(call));var mark=call.pending?'…':(call.isError?'✗':'✓');return[rule.emoji,call.name||'tool',mark,details.join(' · ')].filter(Boolean).join(' ').slice(0,420);}
  function toolPayloadText(value){if(value===undefined)return'';if(value===null)return'null';var parsed=tryToolJson(value);if(typeof parsed==='string')return parsed;try{return JSON.stringify(parsed,null,2);}catch(error){return String(value);}}
  function truncateToolPayload(value,headLines,tailLines){var full=toolPayloadText(value);var NL=String.fromCharCode(10);var lines=full.split(NL);var omitted=Math.max(0,lines.length-headLines-tailLines);var selected=omitted>0?lines.slice(0,headLines).concat(['… 已省略 '+omitted+' 行'],lines.slice(-tailLines)):lines;var clipped=false;var preview=selected.map(function(line){if(line.length<=240)return line;clipped=true;return line.slice(0,239)+'…';}).join(NL);return{full:full,preview:preview,omittedLines:omitted,truncated:omitted>0||clipped};}
  function toolStorageKey(key){return'deepccc:tool-ui:v1:'+state.selectedId+':'+key;}
  function toolState(key){try{return sessionStorage.getItem(toolStorageKey(key))==='1';}catch(error){return false;}}
  function setToolState(key,value){try{sessionStorage.setItem(toolStorageKey(key),value?'1':'0');}catch(error){}}
  function clearToolSessionState(sessionId){try{var prefix='deepccc:tool-ui:v1:'+sessionId+':';for(var index=sessionStorage.length-1;index>=0;index--){var key=sessionStorage.key(index);if(key&&key.indexOf(prefix)===0)sessionStorage.removeItem(key);}}catch(error){}}
  function toolSectionHtml(call,kind,value,headLines,tailLines){if(value===undefined)return'';var result=truncateToolPayload(value,headLines,tailLines);var stateKey=call.uiKey+':'+kind+'-full';var expanded=toolState(stateKey);var text=expanded?result.full:result.preview;var label=kind==='input'?'调用参数':'工具结果';var button=result.truncated?'<button type="button" class="tool-overflow-toggle" data-tool-overflow="'+escapeHtml(stateKey)+'">'+escapeHtml(expanded?'收起省略内容':(result.omittedLines>0?'展开省略的 '+result.omittedLines+' 行':'展开完整内容'))+'</button>':'';return'<section class="tool-section"><div class="tool-section-title">'+label+'</div><pre>'+escapeHtml(text)+'</pre>'+button+'</section>';}
  function timelineHtml(timeline,messageIndex){var results={};(timeline||[]).forEach(function(item){if(item&&item.type==='tool_result'&&item.tool_use_id)results[item.tool_use_id]=item;});var renderedCalls={};var html='';(timeline||[]).forEach(function(item,index){if(!item)return;if(item.type==='text'){if(item.text)html+='<div class="markdown">'+markdown(item.text)+'</div>';return;}if(item.type==='tool_use'){var id=item.id||('timeline-'+messageIndex+'-'+index);var result=results[id];renderedCalls[id]=true;html+=toolCardHtml({uiKey:'tool:'+id,name:item.name||'tool',input:item.input,output:result?result.output:undefined,isError:!!(result&&result.is_error),pending:!result});return;}if(item.type==='tool_result'&&!renderedCalls[item.tool_use_id]){var fallbackId=item.tool_use_id||('result-'+messageIndex+'-'+index);renderedCalls[fallbackId]=true;html+=toolCardHtml({uiKey:'tool:'+fallbackId,name:item.name||'tool',output:item.output,isError:!!item.is_error,pending:false});}});return html;}
  function liveTimeline(events){var timeline=[];(events||[]).forEach(function(event){if(event.type!=='agent'||!event.data)return;var item=event.data;if(item.type==='text_reset'){timeline.length=0;return;}if(item.type==='text'){var previous=timeline[timeline.length-1];if(previous&&previous.type==='text')previous.text+=(item.text||'');else timeline.push({type:'text',text:item.text||''});return;}if(item.type==='tool_use')timeline.push({type:'tool_use',id:item.id,name:item.name,input:item.input});else if(item.type==='tool_result')timeline.push({type:'tool_result',tool_use_id:item.tool_use_id,name:item.name,output:item.content,is_error:!!item.is_error});});return timeline;}
  function legacyToolsHtml(toolCalls,messageIndex){var tools='';(toolCalls||[]).forEach(function(call,index){tools+=toolCardHtml({uiKey:call.id?'tool:'+call.id:'message:'+messageIndex+':tool:'+index,name:call.name,input:call.input,output:call.output,isError:!!call.is_error,pending:false});});return tools;}
  function messageHtml(role,content,toolCalls,messageIndex,timeline){var decoded=role==='user'?decodeAttachmentMessage(content):{text:withoutToolTranscript(content),attachments:[]};var body;if(role==='user')body='<div class="markdown">'+markdown(decoded.text)+'</div>'+attachmentGallery(decoded.attachments,state.detail.sessionId);else if(timeline&&timeline.length)body=timelineHtml(timeline,messageIndex);else body=legacyToolsHtml(toolCalls,messageIndex)+'<div class="markdown">'+markdown(decoded.text)+'</div>';return '<article class="message '+role+'"><div class="avatar">'+(role==='user'?'你':'D')+'</div><div class="bubble"><div class="role">'+(role==='user'?'YOU':'DEEPCCC')+'</div>'+body+'</div></article>';}
  function buildToolGroups(events){var groups=[];var byId={};var order=[];(events||[]).forEach(function(event){if(event.type!=='agent'||!event.data)return;var item=event.data;if(item.type==='tool_use'){var id=item.id||('call-'+order.length);var group={id:id,uiKey:'tool:'+id,name:item.name||'tool',input:item.input,output:undefined,isError:false,pending:true};byId[id]=group;order.push(id);groups.push(group);}else if(item.type==='tool_result'){var key=item.tool_use_id;var target=key?byId[key]:null;if(target){target.output=item.content;target.isError=!!item.is_error;target.pending=false;}}});return groups;}
  function toolCardHtml(call){var open=toolState(call.uiKey+':card');var present=call.name==='present_file'&&!call.pending?artifactFromOutput(call.output):null;var inputHtml=toolSectionHtml(call,'input',call.input,8,4);var outputHtml=call.pending?'':(present?'<section class="tool-section"><div class="tool-section-title">工具结果</div>'+artifactGallery([{name:'present_file',output:call.output}],state.detail.sessionId)+'</section>':toolSectionHtml(call,'output',call.output==null?'(无输出)':call.output,12,6));return'<details class="tool-card" data-tool-state="'+escapeHtml(call.uiKey+':card')+'"'+(open?' open':'')+'><summary><span class="tool-summary-text">'+escapeHtml(toolSummary(call))+'</span></summary>'+inputHtml+outputHtml+'</details>';}
  function toolCardsHtml(calls){return (calls||[]).map(toolCardHtml).join('');}
  function approvalAnswerLabel(answer){var labels={allow:'已允许一次','allow-session':'本会话已允许','allow-always':'已永久允许',deny:'已拒绝'};return labels[answer]||'等待决定';}
  function approvalHtml(approval){var resolved=approval.status==='resolved';var html='<section class="approval-card'+(resolved?' resolved':'')+'"><div class="approval-head"><strong>⚠ 操作审批</strong><span class="approval-status">'+escapeHtml(resolved?approvalAnswerLabel(approval.answer):'等待批准')+'</span></div><div class="approval-detail">'+escapeHtml(approval.detail||('工具：'+approval.tool))+'</div><pre class="approval-command">'+escapeHtml(approval.action)+'</pre>';if(!resolved)html+='<div class="approval-inline-actions"><button class="danger" data-approval-answer="deny" data-approval-id="'+escapeHtml(approval.approvalId)+'">拒绝</button><button class="ghost" data-approval-answer="allow" data-approval-id="'+escapeHtml(approval.approvalId)+'">允许一次</button><button class="ghost" data-approval-answer="allow-session" data-approval-id="'+escapeHtml(approval.approvalId)+'">本会话允许</button><button class="primary" data-approval-answer="allow-always" data-approval-id="'+escapeHtml(approval.approvalId)+'">永久允许</button></div>';return html+'</section>';}
  function sessionDraft(detail){return state.configDrafts[detail.sessionId]||{model:detail.model||'',subModel:detail.subModel||'',effort:detail.effort||''};}
  function rememberDraft(){if(!state.selectedId)return;state.configDrafts[state.selectedId]={model:$('session-model').value,subModel:$('session-sub-model').value,effort:$('session-effort').value};}
  function rememberPromptDraft(){if(!state.selectedId)return;state.promptDrafts[state.selectedId]=$('prompt').value;}
  function currentAttachments(){return state.attachmentDrafts[state.selectedId]||[];}
  function renderAttachmentDrafts(){var root=$('attachment-drafts');if(!root)return;root.innerHTML=currentAttachments().map(function(item){return '<div class="attachment-draft"><img src="'+escapeHtml(attachmentUrl(state.selectedId,item.attachmentId))+'" alt="'+escapeHtml(item.originalName)+'"><button type="button" data-remove-attachment="'+escapeHtml(item.attachmentId)+'">×</button></div>';}).join('');}
  function clearSelection(message){if(state.eventSource)state.eventSource.close();state.eventSource=null;state.detailRequestToken++;state.selectedId=null;state.detail=null;$('composer-shell').classList.add('hidden');$('rename-session').classList.add('hidden');$('delete-session').classList.add('hidden');$('warning').classList.add('hidden');$('session-title').textContent='DeepCCC';$('session-cwd').textContent='选择或创建一个会话';$('content').innerHTML='<div class="welcome"><div class="welcome-card"><div class="welcome-mark">✦</div><h2>'+escapeHtml(message||'选择一个会话')+'</h2><p>从左侧选择其他会话或创建一个新的任务。</p></div></div>';}
  function renderDetail(){
    var detail=state.detail;
    if(!detail)return;
    var contentEl=$('content');
    var previousScrollTop=contentEl.scrollTop;
    var stickToBottom=contentEl.scrollHeight-contentEl.scrollTop-contentEl.clientHeight<80;
    var draft=sessionDraft(detail);
    $('session-title').textContent=detail.title;
    $('session-cwd').textContent=detail.cwd+' · '+statusText(detail.status);
    $('rename-session').classList.remove('hidden');
    $('delete-session').classList.remove('hidden');
    $('composer-shell').classList.remove('hidden');
    $('prompt').value=state.promptDrafts[detail.sessionId]||'';
    $('session-model').value=draft.model;
    $('session-sub-model').value=draft.subModel;
    $('session-effort').value=draft.effort;
    renderAttachmentDrafts();
    var html='<div class="thread">';
    if(!(detail.messages||[]).length&&detail.status!=='running')html+='<div class="empty-thread"><strong>准备开始这个会话</strong><span>在下方输入任务，可附加截图。DeepCCC 会读取当前项目指令、调用工具并持续保存上下文。</span></div>';
    (detail.messages||[]).forEach(function(message,index){html+=messageHtml(message.role,message.content,message.toolCalls,index,message.timeline);});
    if(detail.status==='running'){
      var currentTimeline=liveTimeline(detail.events);
      if(currentTimeline.length)html+=messageHtml('assistant','',[],'live',currentTimeline);
    }
    var approvals=(detail.approvals||[]).slice();
    if(detail.pendingApproval&&!approvals.some(function(item){return item.approvalId===detail.pendingApproval.approvalId;}))approvals.push(Object.assign({status:'pending'},detail.pendingApproval));
    approvals.forEach(function(approval){html+=approvalHtml(approval);});
    if(detail.status==='running'){
      var lastAgent=(detail.events||[]).slice().reverse().find(function(event){return event.type==='agent';});
      var runningLabel=lastAgent&&lastAgent.data&&lastAgent.data.type==='progress'?'Agent 正在思考…':'Agent 正在工作';
      html+='<div class="run-state"><i class="pulse"></i>'+runningLabel+'</div>';
    }
    html+='</div>';
    contentEl.innerHTML=html;
    $('send').classList.toggle('hidden',detail.status==='running');
    $('stop').classList.toggle('hidden',detail.status!=='running');
    $('prompt').disabled=detail.status==='running';
    $('session-model').disabled=detail.status==='running';
    $('session-sub-model').disabled=detail.status==='running';
    $('session-effort').disabled=detail.status==='running';
    $('attach-image').disabled=detail.status==='running'||state.uploading;
    renderWarning();
    requestAnimationFrame(function(){contentEl.scrollTop=stickToBottom?contentEl.scrollHeight:previousScrollTop;});
  }
  function cwdKey(value){var raw=String(value||'');var normalized=raw.replace(/\\\\/g,'/').replace(new RegExp('/+$'),'');var windowsStyle=new RegExp('^[a-z]:/','i').test(normalized)||raw.indexOf(String.fromCharCode(92))>=0;return windowsStyle?normalized.toLowerCase():normalized;}
  function renderWarning(){if(!state.detail)return;var selectedCwd=cwdKey(state.detail.cwd);var conflicts=state.sessions.filter(function(item){return item.sessionId!==state.detail.sessionId&&item.status==='running'&&cwdKey(item.cwd)===selectedCwd;});var el=$('warning');if(conflicts.length){el.textContent='⚠ 当前目录还有 '+conflicts.length+' 个 Agent 会话正在运行。多个会话直接修改同一目录，可能产生覆盖或冲突。';el.classList.remove('hidden');}else el.classList.add('hidden');}
  async function loadSessions(){var result=await api('/api/sessions');state.sessions=result.sessions||[];if(state.selectedId&&!state.sessions.some(function(item){return item.sessionId===state.selectedId;}))clearSelection('会话已在其他页面删除');renderSessions();renderWarning();}
  async function loadDetail(id,token){var sessionId=id||state.selectedId;if(!sessionId)return false;var requestToken=token===undefined?++state.detailRequestToken:token;var result=await api('/api/sessions/'+encodeURIComponent(sessionId));if(state.selectedId!==sessionId||requestToken!==state.detailRequestToken)return false;await loadSessions();if(state.selectedId!==sessionId||requestToken!==state.detailRequestToken)return false;state.detail=result.session;renderDetail();return true;}
  function scheduleRender(){if(state.renderQueued)return;state.renderQueued=true;requestAnimationFrame(function(){state.renderQueued=false;if(state.detail)renderDetail();});}
  function scheduleSessions(){clearTimeout(state.sessionsReloadTimer);state.sessionsReloadTimer=setTimeout(function(){loadSessions().catch(function(error){toast(error.message,true);});},80);}
  function handleSessionEvent(msg){var update;try{update=JSON.parse(msg.data);}catch(error){return;}if(update.sessionId!==state.selectedId||!state.detail)return;if(update.type==='agent'||update.type==='run_started'){state.detail.events=(state.detail.events||[]).concat([update]).slice(-500);if(update.type==='run_started')state.detail.status='running';scheduleRender();}else if(update.type==='run_finished'){state.detail.events=(state.detail.events||[]).concat([update]).slice(-500);state.detail.status='idle';loadDetail(state.selectedId).catch(function(error){toast(error.message,true);});}else if(update.type==='approval'||update.type==='approval_resolved'||update.type==='session_updated'){loadDetail(state.selectedId).catch(function(error){toast(error.message,true);});}}
  async function selectSession(id){state.selectedId=id;state.detail=null;var token=++state.detailRequestToken;renderSessions();$('composer-shell').classList.add('hidden');$('content').innerHTML='<div class="welcome"><div class="welcome-card"><div class="welcome-mark">✦</div><h2>正在加载会话</h2><p>正在读取消息、工具记录与运行状态…</p></div></div>';if(state.eventSource)state.eventSource.close();state.eventSource=new EventSource('/api/sessions/'+encodeURIComponent(id)+'/events');state.eventSource.onmessage=handleSessionEvent;await loadDetail(id,token);}
  async function loadConfig(){var result=await api('/api/config');state.config=result.config;$('cfg-provider').value=state.config.provider;$('cfg-base-url').value=state.config.baseURL;$('cfg-model').value=state.config.model;$('cfg-sub-model').value=state.config.subModel||'';$('cfg-effort').value=state.config.effort||'';$('cfg-context').value=state.config.contextWindow;$('cfg-max-output').value=state.config.maxOutputTokens||'';$('cfg-streaming').checked=state.config.streaming!==false;$('cfg-port').value=state.config.web.port;$('cfg-open').checked=state.config.web.openOnStart!==false;$('server-port').textContent=state.config.web.port;$('key-state').textContent=state.config.apiKeyConfigured?'当前 API Key：'+state.config.apiKeyMask:'尚未配置 API Key';$('new-cwd').value=state.config.defaultCwd||'';$('new-model').value=state.config.model;$('new-sub-model').value=state.config.subModel||'';var models=[state.config.model,state.config.subModel].concat(state.sessions.reduce(function(all,item){return all.concat([item.model,item.subModel]);},[])).filter(Boolean).filter(function(value,index,array){return array.indexOf(value)===index;});$('recent-models').innerHTML=models.map(function(model){return '<option value="'+escapeHtml(model)+'">';}).join('');}
  $('new-session').addEventListener('click',function(){openModal('new-modal');setTimeout(function(){$('new-cwd').focus();},0);});$('open-settings').addEventListener('click',function(){loadConfig().then(function(){openModal('settings-modal');}).catch(function(error){toast(error.message,true);});});document.querySelectorAll('[data-close]').forEach(function(button){button.addEventListener('click',function(){closeModal(button.dataset.close);});});
  $('new-form').addEventListener('submit',async function(event){event.preventDefault();try{var result=await api('/api/sessions',{method:'POST',body:JSON.stringify({cwd:$('new-cwd').value,title:$('new-title').value,model:$('new-model').value,subModel:$('new-sub-model').value,effort:$('new-effort').value})});closeModal('new-modal');$('new-title').value='';await loadSessions();await selectSession(result.session.sessionId);}catch(error){toast(error.message,true);}});
  $('settings-form').addEventListener('submit',async function(event){event.preventDefault();var body={provider:$('cfg-provider').value,baseURL:$('cfg-base-url').value,model:$('cfg-model').value,subModel:$('cfg-sub-model').value,effort:$('cfg-effort').value,contextWindow:Number($('cfg-context').value),streaming:$('cfg-streaming').checked,web:{port:Number($('cfg-port').value),openOnStart:$('cfg-open').checked}};if($('cfg-max-output').value)body.maxOutputTokens=Number($('cfg-max-output').value);if($('cfg-api-key').value)body.apiKey=$('cfg-api-key').value;try{await api('/api/config',{method:'PUT',body:JSON.stringify(body)});$('cfg-api-key').value='';closeModal('settings-modal');toast('设置已保存，新配置从下一次新建会话生效');await loadConfig();}catch(error){toast(error.message,true);}});
  async function uploadAttachment(sessionId,file){var response=await fetch('/api/sessions/'+encodeURIComponent(sessionId)+'/attachments?name='+encodeURIComponent(file.name||'image'),{method:'POST',headers:{'content-type':file.type||'application/octet-stream'},body:file});var result=await response.json().catch(function(){return{error:'上传响应不是有效 JSON'};});if(!response.ok)throw new Error(result.error||('HTTP '+response.status));return result.attachment;}
  async function handleAttachmentFiles(files){var sessionId=state.selectedId;if(!sessionId||state.uploading)return;var candidates=[].slice.call(files||[]).filter(function(file){return ['image/png','image/jpeg','image/webp'].includes(file.type);});var existing=state.attachmentDrafts[sessionId]||[];if(existing.length+candidates.length>10){toast('每条消息最多添加 10 张图片',true);return;}if(!candidates.length){toast('仅支持 PNG、JPEG、WebP 图片',true);return;}state.uploading=true;if(state.detail)renderDetail();try{for(var i=0;i<candidates.length;i++){if(candidates[i].size>20*1024*1024)throw new Error('单张图片不能超过 20 MB：'+candidates[i].name);existing.push(await uploadAttachment(sessionId,candidates[i]));state.attachmentDrafts[sessionId]=existing;renderAttachmentDrafts();}}catch(error){toast(error.message,true);}finally{state.uploading=false;if(state.detail)renderDetail();$('attachment-input').value='';}}
  async function removeAttachment(id){var sessionId=state.selectedId;if(!sessionId)return;try{await api('/api/sessions/'+encodeURIComponent(sessionId)+'/attachments/'+encodeURIComponent(id),{method:'DELETE'});state.attachmentDrafts[sessionId]=(state.attachmentDrafts[sessionId]||[]).filter(function(item){return item.attachmentId!==id;});renderAttachmentDrafts();}catch(error){toast(error.message,true);}}
  async function send(){var sessionId=state.selectedId;var text=$('prompt').value;var attachments=currentAttachments();if(!sessionId||(!text.trim()&&!attachments.length)||state.uploading)return;try{var patch={model:$('session-model').value,subModel:$('session-sub-model').value,effort:$('session-effort').value};if(patch.model!==state.detail.model||patch.subModel!==state.detail.subModel||patch.effort!==state.detail.effort){var updated=await api('/api/sessions/'+encodeURIComponent(sessionId),{method:'PATCH',body:JSON.stringify(patch)});if(state.selectedId===sessionId){state.detail=Object.assign({},state.detail,updated.session);renderDetail();}await loadSessions();}await api('/api/sessions/'+encodeURIComponent(sessionId)+'/messages',{method:'POST',body:JSON.stringify({text:text,attachmentIds:attachments.map(function(item){return item.attachmentId;})})});delete state.configDrafts[sessionId];delete state.promptDrafts[sessionId];delete state.attachmentDrafts[sessionId];if(state.selectedId===sessionId){$('prompt').value='';renderAttachmentDrafts();state.detail.events=[];state.detail.status='running';renderDetail();}var token=++state.detailRequestToken;await loadDetail(sessionId,token);}catch(error){toast(error.message,true);}}
  ['session-model','session-sub-model','session-effort'].forEach(function(id){$(id).addEventListener('input',rememberDraft);$(id).addEventListener('change',rememberDraft);});
  $('attach-image').addEventListener('click',function(){$('attachment-input').click();});$('attachment-input').addEventListener('change',function(){handleAttachmentFiles(this.files);});$('attachment-drafts').addEventListener('click',function(event){var button=event.target.closest('[data-remove-attachment]');if(button)removeAttachment(button.dataset.removeAttachment);});document.addEventListener('paste',function(event){var files=[].slice.call(event.clipboardData&&event.clipboardData.files||[]).filter(function(file){return file.type.indexOf('image/')===0;});if(files.length){event.preventDefault();handleAttachmentFiles(files);}});$('composer').addEventListener('dragover',function(event){event.preventDefault();this.classList.add('dragging');});$('composer').addEventListener('dragleave',function(){this.classList.remove('dragging');});$('composer').addEventListener('drop',function(event){event.preventDefault();this.classList.remove('dragging');handleAttachmentFiles(event.dataTransfer.files);});
  $('send').addEventListener('click',send);$('prompt').addEventListener('input',rememberPromptDraft);$('prompt').addEventListener('keydown',function(event){if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}});$('stop').addEventListener('click',async function(){try{await api('/api/sessions/'+encodeURIComponent(state.selectedId)+'/stop',{method:'POST',body:'{}'});toast('已请求停止');}catch(error){toast(error.message,true);}});
  $('rename-session').addEventListener('click',function(){$('rename-title').value=state.detail.title;openModal('rename-modal');});$('rename-form').addEventListener('submit',async function(event){event.preventDefault();try{await api('/api/sessions/'+encodeURIComponent(state.selectedId),{method:'PATCH',body:JSON.stringify({title:$('rename-title').value})});closeModal('rename-modal');var token=++state.detailRequestToken;await loadDetail(state.selectedId,token);}catch(error){toast(error.message,true);}});$('delete-session').addEventListener('click',async function(){if(!confirm('删除这个会话及其本地历史？不会删除工作目录中的文件。'))return;try{var deletedId=state.selectedId;await api('/api/sessions/'+encodeURIComponent(deletedId),{method:'DELETE'});delete state.configDrafts[deletedId];delete state.promptDrafts[deletedId];delete state.attachmentDrafts[deletedId];clearToolSessionState(deletedId);clearSelection('会话已删除');await loadSessions();}catch(error){toast(error.message,true);}});
  $('content').addEventListener('toggle',function(event){var card=event.target.closest&&event.target.closest('details.tool-card[data-tool-state]');if(card)setToolState(card.dataset.toolState,card.open);},true);
  $('content').addEventListener('click',async function(event){var overflow=event.target.closest('[data-tool-overflow]');if(overflow){setToolState(overflow.dataset.toolOverflow,!toolState(overflow.dataset.toolOverflow));renderDetail();return;}var button=event.target.closest('[data-approval-answer]');if(!button)return;button.disabled=true;try{await api('/api/approvals/'+encodeURIComponent(button.dataset.approvalId),{method:'POST',body:JSON.stringify({answer:button.dataset.approvalAnswer})});var token=++state.detailRequestToken;await loadDetail(state.selectedId,token);}catch(error){button.disabled=false;toast(error.message,true);}});
  function handleGlobalEvent(event){try{var update=JSON.parse(event.data);if(update.type==='session_deleted'){delete state.configDrafts[update.sessionId];delete state.promptDrafts[update.sessionId];delete state.attachmentDrafts[update.sessionId];clearToolSessionState(update.sessionId);}}catch(error){}scheduleSessions();}
  state.globalEventSource=new EventSource('/api/events');state.globalEventSource.onmessage=handleGlobalEvent;
  Promise.all([loadSessions(),loadConfig()]).then(function(){if(state.sessions[0])return selectSession(state.sessions[0].sessionId);}).catch(function(error){toast(error.message,true);});
})();
</script>
</body></html>`;
