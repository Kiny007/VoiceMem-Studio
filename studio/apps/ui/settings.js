/* Device-local display preferences, shared across the two independent pages. */
(()=>{
'use strict';
const KEY='voicemem.display',UI_BASE=1.2,CONTENT_BASE=.75;
let prefs={lang:'zh-CN',uiLevel:1,contentLevel:1,schema:2};
try{
 const saved=JSON.parse(localStorage.getItem(KEY)||'null');
 if(saved){
  if(saved.schema===2) prefs={...prefs,...saved};
  else {
   const oldUI=Number(saved.uiScale??saved.scale??1);
   const oldContent=Number(saved.contentScale??saved.scale??1);
   prefs={lang:saved.lang||'zh-CN',uiLevel:oldUI/UI_BASE,contentLevel:oldContent/CONTENT_BASE,schema:2};
  }
 }
}catch{}
function normalize(){const clamp=value=>Math.min(2,Math.max(.5,Number(value)||1));prefs={lang:prefs.lang==='en'?'en':'zh-CN',uiLevel:clamp(prefs.uiLevel),contentLevel:clamp(prefs.contentLevel),schema:2};}normalize();
const pairs=[
['等待你的下一句话…','Waiting for your next words…'],['回答会同步显示在这里。','Responses will appear here.'],['说点什么，她在听。','Say something. She is listening.'],['我在。今天想从哪里说起？','I’m here. Where would you like to start?'],['还没有记录。说第一句话，它会出现在这里。','No history yet. Your first message will appear here.'],['说点什么，VoiceMem 会先去记忆里找相关的内容，再回答。','Say something. VoiceMem will retrieve relevant memories before responding.'],['你','You'],['人物','People'],['研究','Research'],['项目','Projects'],['人格','Personality'],['全部记忆','All memories'],['娱乐','Entertainment'],['设置','Settings'],['显示设置','Display settings'],['返回对话','Back to conversation'],['选择模式','Choose your mode'],['科技风','Technical'],['数字人','Digital human'],['专注、清晰，尽在掌握','Focus, clarity, and control'],['有回应，也有陪伴','A voice and a companion'],['系统语言','System language'],['字体大小','Font size'],['UI 字号','UI font size'],['内容字号','Content font size'],['按钮、导航与标签','Buttons, navigation, and labels'],['ASR、记忆、回复与对话记录','ASR, memories, responses, and conversations'],['恢复默认','Reset to default'],['当前模式','Current mode'],['预览','Preview'],['记忆','Memory'],['识别到的语音显示在这里','Your recognized speech appears here'],['相关记忆显示在这里','Relevant memories appear here'],['回复与对话记录显示在这里','Responses and conversation history appear here'],
['首页','Home'],['返回首页','Back to home'],['科技风 ↗','Technical ↗'],['数字人 ↗','Digital human ↗'],['新对话','New conversation'],['置顶','Pinned'],['聊天记录','Chat history'],['对话记录','Conversation'],['记忆空间','Memory Space'],['对话','Chat'],['模型回复','Response'],['本轮感知','Perception'],['本轮感知 · ASR','Perception · ASR'],['开始对话','Start conversation'],['结束对话','End conversation'],['开始说话','Start speaking'],['停止说话','Stop speaking'],['正在聆听…','Listening…'],['语音输入','Voice input'],['发送','Send'],['倾听','Listening'],['说话','Speaking'],['短思考','Short thinking'],['长思考','Long thinking'],['待机','Idle'],['演示 · 倾听','Demo · Listening'],['演示 · 说话','Demo · Speaking'],['演示 · 短思考','Demo · Short thinking'],['演示 · 长思考','Demo · Long thinking'],['当前浏览器使用静态球体预览','This browser uses a static orb preview'],
['输入这一轮想说的话…','Type what you want to say…'],['本轮文字输入','Message input'],['说点什么…','Say something…'],['对 Echo 说','Talk to Echo'],['待识别','Not identified'],['未匹配','No match'],['情感','Emotion'],['情绪','Emotion'],['实体','Entities'],['簇','Clusters'],['说话人','Speaker'],['事实与经历','Facts and experiences'],['偏好','Preference'],['性格','Personality'],['情绪与人格','Emotion and personality'],['记忆节点','Memory nodes'],['点击节点查看记忆域','Select a node to explore memories'],['点击任一记忆域，Top-K 会切换到该域','Select a memory domain to filter Top-K'],['全部记忆域 · 按相似度排序','All memory domains · Ranked by similarity'],['引用的记忆','Referenced memory'],['已与你的记忆同步','Synced with your memory'],['暂无置顶对话','No pinned conversations'],['暂无聊天记录','No conversations yet'],['已复制','Copied'],['复制','Copy'],['复制回复','Copy response'],['重播原声','Replay original voice'],['重播原声回复','Replay original response voice'],['停止重播','Stop replay'],['今天','Today'],['与 Echo 的对话','Conversation with Echo'],['深湖','Deep Lake'],['记忆空间 · 深湖','Memory Space · Deep Lake'],['你说过的话在这里沉下去，彼此连成一片。','Your words settle here and connect into memories.'],
['收起对话栏','Collapse conversations'],['展开对话栏','Expand conversations'],['展开对话列表','Expand conversations'],['收起对话列表','Collapse conversations'],['查看聊天记录','Show chat history'],['关闭聊天记录','Close chat history'],['取消置顶','Unpin'],['置顶对话','Pin conversation'],['页面导航','Page navigation'],['对话列表','Conversations'],['右侧显示','Right panel'],['左右脑记忆','Left and right brain memories'],['对话设置','Conversation settings'],['液态语音球','Liquid voice orb'],['液态语音状态动画','Liquid voice state animation'],['球体动效演示','Orb animation demos'],['脑部记忆图谱：245 个记忆节点','Brain memory graph: 245 memory nodes'],['245 个记忆节点','245 memory nodes'],
['交互原型','Interactive prototype'],['想以哪种方式开始？','How would you like to begin?'],['同一个助手，两种相处方式。','One assistant, two ways to connect.'],['选择一个空间，开始对话','Choose a space and start a conversation'],['选择风格','Choose a style'],['银发数字人助手','Silver-haired digital assistant'],['工作','Work'],['知识','Knowledge'],['健康','Health'],['日常','Daily life'],['关系','Relationships'],['目标','Goals'],['财务','Finance'],['紧张','Anxious'],['开心','Happy'],['低落','Low'],['疲惫','Tired'],['轻快','Upbeat'],['迟疑','Hesitant'],['平静','Calm'],
['请等当前回复完成。','Please wait for the current response.'],['这条回复的原始语音暂不可用。','The original voice for this response is unavailable.'],['原始语音播放失败。','Original voice playback failed.'],['复制未成功，请选中文字后复制。','Copy failed. Select the text and copy it manually.'],['此浏览器不支持语音识别，请在输入框中开始对话。','Speech recognition is unavailable. Please type your message.'],['麦克风权限未开启，可继续文字对话。','Microphone access is off. You can continue by typing.'],['未识别到语音，请重试或输入文字。','No speech recognized. Try again or type your message.'],['语音未确认，文字已保留在输入框。','Speech was not confirmed. The text remains in the input.'],['麦克风暂不可用，请使用文字输入。','Microphone unavailable. Please type your message.'],['根据本轮文字关键词展示','Based on keywords in this message'],['尚未接入说话人识别','Speaker identification is not connected']
];
const en=new Map(pairs),zh=new Map(pairs.map(([a,b])=>[b,a]));
[['风格','Style'],['语言与字体','Language & Type'],['组件','Components'],['组件画板','Component canvas']].forEach(([a,b])=>{en.set(a,b);zh.set(b,a);});
// Existing English chrome gets a Chinese equivalent too.
zh.set('Technical','科技风');zh.set('Chat','对话记录');zh.set('info','事实记忆');zh.set('emo&persona','情绪与人格');zh.set('Speaker ID','说话人 ID');
function t(value){
 const dict=prefs.lang==='en'?en:zh;if(dict.has(value))return dict.get(value);
 if(prefs.lang==='en'){
  const domain=value.match(/^(.+?) 记忆域 · 按相似度排序$/);if(domain)return t(domain[1])+' memory domain · Ranked by similarity';
  const score=value.match(/^(\w+ · )(.+?)( · 相似度 )(.*)$/);if(score)return score[1]+t(score[2])+' · Similarity '+score[4];
  if(value.startsWith('置顶对话：'))return 'Pin conversation: '+value.slice(5);
  if(value.startsWith('取消置顶：'))return 'Unpin conversation: '+value.slice(5);
 }
 return value;
}
en.set('事实记忆','info');en.set('说话人 ID','Speaker ID');
const textCache=new WeakMap(),attrCache=new WeakMap();
const skip='script,style,textarea,input,[data-no-i18n],.msg-body,.turn p,.conv-title,.conv-select,.item,#liveEcho,#liveEchoPrev,#aiEcho,#said,#voice';
function translate(root=document.body){
 const walk=node=>{
  if(node.nodeType===3){const parent=node.parentElement;if(!parent||parent.closest(skip))return;
   const current=node.nodeValue;let record=textCache.get(node);if(!record||current!==record.output)record={source:current};
   const trimmed=record.source.trim();const out=t(trimmed);record.output=record.source.replace(trimmed,out);textCache.set(node,record);if(current!==record.output)node.nodeValue=record.output;
  }else if(node.nodeType===1){if(node.matches('script,style,[data-no-i18n]'))return;
   for(const key of ['title','aria-label','placeholder','alt'])if(node.hasAttribute(key)){
    let records=attrCache.get(node);if(!records){records={};attrCache.set(node,records);}const current=node.getAttribute(key);let rec=records[key];if(!rec||rec.output!==current)rec={source:current};rec.output=t(rec.source);records[key]=rec;if(current!==rec.output)node.setAttribute(key,rec.output);
   }
   for(const child of node.childNodes)walk(child);
  }
 };walk(root);
}
function apply(save=true){
 normalize();document.documentElement.lang=prefs.lang;document.documentElement.style.setProperty('--font-scale',prefs.uiLevel*UI_BASE);document.documentElement.style.setProperty('--content-scale',prefs.contentLevel*CONTENT_BASE);
 if(save)try{localStorage.setItem(KEY,JSON.stringify(prefs));}catch{}
 document.dispatchEvent(new CustomEvent('display-settings-change',{detail:{...prefs}}));
 translate();
 for(const id of ['liveEcho','aiEcho','said','voice']){const node=document.getElementById(id);if(node&&pairs.slice(0,4).some(pair=>pair.includes(node.textContent)))node.textContent=t(node.textContent);}
 document.title='VoiceMem · '+t(document.body.dataset.style==='technical'?'科技风':document.body.dataset.style==='digital'?'数字人':'首页');
 if(language)language.value=prefs.lang;if(uiScale){uiScale.value=String(Math.round(prefs.uiLevel*100));uiOutput.textContent=Math.round(prefs.uiLevel*100)+'%';contentScale.value=String(Math.round(prefs.contentLevel*100));contentOutput.textContent=Math.round(prefs.contentLevel*100)+'%';}
}
let language,uiScale,contentScale,uiOutput,contentOutput,dialog,opener;
function controls(){
 const section=document.createElement('section');section.className='display-options';
 section.innerHTML=`<div class="setting-row"><label for="systemLanguage">系统语言</label><select id="systemLanguage"><option value="zh-CN">简体中文</option><option value="en">English</option></select></div>
 <div class="setting-row"><label for="uiFont">UI 字号<small>按钮、导航与标签</small></label><output id="uiFontPercent" for="uiFont">100%</output></div>
 <input id="uiFont" class="font-range" type="range" min="50" max="200" step="5" value="100" aria-label="UI 字号">
 <div class="setting-row"><label for="contentFont">内容字号<small>ASR、记忆、回复与对话记录</small></label><output id="contentFontPercent" for="contentFont">100%</output></div>
 <input id="contentFont" class="font-range" type="range" min="50" max="200" step="5" value="100" aria-label="内容字号">
 <div class="font-preview"><small>预览</small><p class="preview-asr">识别到的语音显示在这里</p><p class="preview-memory">相关记忆显示在这里</p><p class="preview-response">回复与对话记录显示在这里</p></div>
 <button type="button" id="resetDisplay">恢复默认</button>`;
 language=section.querySelector('#systemLanguage');uiScale=section.querySelector('#uiFont');uiOutput=section.querySelector('#uiFontPercent');contentScale=section.querySelector('#contentFont');contentOutput=section.querySelector('#contentFontPercent');
 language.onchange=()=>{prefs.lang=language.value;apply();};uiScale.oninput=()=>{prefs.uiLevel=Number(uiScale.value)/100;apply();};contentScale.oninput=()=>{prefs.contentLevel=Number(contentScale.value)/100;apply();};
 section.querySelector('#resetDisplay').onclick=()=>{prefs={lang:'zh-CN',uiLevel:1,contentLevel:1,schema:2};apply();};return section;
}
function openSettings(){
 opener=document.activeElement;
 if(!dialog){dialog=document.createElement('dialog');dialog.className='settings-page';dialog.setAttribute('aria-labelledby','settingsTitle');
 dialog.innerHTML=`<div class="settings-inner"><header class="settings-header"><h1 id="settingsTitle">设置</h1><button type="button" id="closeSettings">返回对话</button></header>
 <nav class="settings-tabs" role="tablist" aria-label="设置">
  <button role="tab" aria-selected="true" aria-controls="settingsStyle">1 · 风格</button>
  <button role="tab" aria-selected="false" aria-controls="settingsDisplay">2 · 语言与字体</button>
  <button role="tab" aria-selected="false" aria-controls="settingsHarness">3 · Harness</button>
  <button role="tab" aria-selected="false" aria-controls="settingsComponents">4 · 组件</button>
 </nav>
 <section class="settings-panel on" id="settingsStyle" role="tabpanel"><h2>选择模式</h2><div class="settings-modes">
  <a href="technical.html" class="mode-card mode-technical"><div class="mode-orb"></div><strong>科技风</strong><p>专注、清晰，尽在掌握</p></a>
  <a href="digital.html" class="mode-card mode-digital"><img src="assets/avatar.jpg" alt="银发数字人助手"><strong>数字人</strong><p>有回应，也有陪伴</p></a></div></section>
 <section class="settings-panel" id="settingsDisplay" role="tabpanel"></section>
 <section class="settings-panel settings-empty" id="settingsHarness" role="tabpanel" aria-label="Harness"></section>
 <section class="settings-panel" id="settingsComponents" role="tabpanel"><div class="component-board" aria-label="组件画板"></div></section></div>`;
 dialog.querySelector('#settingsDisplay').append(controls());document.body.append(dialog);
 const tabs=[...dialog.querySelectorAll('.settings-tabs button')],panels=[...dialog.querySelectorAll('.settings-panel')];
 function showPanel(index){tabs.forEach((tab,i)=>{const on=i===index;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;panels[i].classList.toggle('on',on);});}
 tabs.forEach((tab,i)=>{tab.tabIndex=i?-1:0;tab.onclick=()=>showPanel(i);tab.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;showPanel(next);tabs[next].focus();};});
 dialog.querySelector('#closeSettings').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{document.dispatchEvent(new Event('settings-close'));opener?.focus();});
 const current=dialog.querySelector('.mode-'+document.body.dataset.style);current?.setAttribute('aria-current','page');current?.addEventListener('click',e=>{e.preventDefault();dialog.close();});
 }
 apply(false);document.dispatchEvent(new Event('settings-open'));dialog.showModal();dialog.querySelector('#closeSettings').focus();
}
window.VMSettings={graphLabel(value){const labels={work:'工作',health:'健康',person:'人物',research:'研究',projects:'项目',entertainment:'娱乐',you:'你','经济':'财务'};return prefs.lang==='en'?(value==='经济'?'finance':value):labels[value]||value;},get language(){return prefs.lang;},get uiScale(){return prefs.uiLevel*UI_BASE;},get contentScale(){return prefs.contentLevel*CONTENT_BASE;},t,open:openSettings};
const btn=document.getElementById('settingsBtn');if(btn)btn.onclick=openSettings;
apply(false);
let queued=false;
if(window.MutationObserver)new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;translate();});}).observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','placeholder','alt']});
window.addEventListener('storage',e=>{if(e.key===KEY){try{prefs=JSON.parse(e.newValue)||{lang:'zh-CN',uiLevel:1,contentLevel:1,schema:2};apply(false);}catch{}}});
})();
