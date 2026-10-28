import assert from 'node:assert/strict';
import test from 'node:test';
import {formatXClocks,mountXReader,mountXSettings,normalizeXPost,validateXSettings} from '../public/x-reader.js';
import {loadLocalXHls,mountDesktopXReader} from '../public/x-reader-integration.js';
import {translate} from '../public/localization.js';

const post=(id='123',extra={})=>({id,author:{name:'Tibo',handle:'thsottiaux'},createdAt:'2026-10-19T14:59:00.000Z',text:'A post',complete:true,kind:'post',media:[],...extra});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('first entry checks login without flashing the chooser while status and cached content arrive independently',async()=>{
  for(const cacheFirst of [false,true]){
    const fixture=dom();let finishStatus,finishList;
    const reader=mountXReader({container:fixture.container,bridge:bridge({getXStatus:()=>new Promise(resolve=>finishStatus=resolve),listXPosts:()=>new Promise(resolve=>finishList=resolve)})});
    const showing=reader.show();
    const panel=walk(fixture.container).find(el=>el.className==='x-reader-login');
    assert.equal(panel.hidden,true);assert.ok(fixture.container.textContent.includes('正在检查登录'));
    assert.equal(find(fixture.container,'网页登录'),undefined);
    if(cacheFirst){finishList({items:[post()],source:'cache',status:{auth:'restoring',operation:'idle'}});await flush();assert.ok(fixture.container.textContent.includes('A post'));assert.equal(panel.hidden,true);}
    finishStatus({auth:'ready',operation:'idle'});await flush();assert.equal(panel.hidden,true);
    finishList({items:[post()],source:'live',status:{auth:'ready',operation:'idle'}});await showing;
    assert.equal(panel.hidden,true);assert.equal(find(fixture.container,'网页登录'),undefined);assert.ok(fixture.container.textContent.includes('A post'));reader.dispose();
  }
});

test('cached author and quote avatars wait for session readiness and manual refresh retries failures immediately',async()=>{
  const f=dom();let finishStatus,auth='restoring';
  const avatar='usagemonitor-x-media://resource/11111111-1111-4111-8111-111111111111';
  const value=post('123',{author:{name:'Example',handle:'example',avatar},quotedPost:post('124',{author:{name:'Quote',handle:'quote',avatar}})});
  const reader=mountXReader({container:f.container,bridge:bridge({getXStatus:()=>new Promise(resolve=>finishStatus=resolve),listXPosts:async()=>({items:[value],source:'cache',status:{auth,operation:'idle'}})})});
  const showing=reader.show();await flush();
  const images=walk(f.container).filter(el=>el.className==='x-reader-avatar');assert.equal(images.length,2);
  for(const image of images){assert.equal(image.src,undefined);assert.equal(image.hidden,true);}
  auth='ready';finishStatus({auth,operation:'idle'});await showing;
  for(const image of images){assert.equal(image.src,avatar);await image.dispatch('error');assert.equal(image.hidden,true);}
  reader.handleUpdate({auth:'ready',operation:'idle'});await flush();
  for(const image of images)assert.equal(image.hidden,true,'ordinary status polls do not retry failures');
  const refresh=walk(f.container).find(el=>el.getAttribute('aria-label')==='刷新');
  await refresh.dispatch('click');await flush();
  for(const image of images){assert.equal(image.hidden,false);await image.dispatch('error');}
  await refresh.dispatch('click');await flush();
  for(const image of images){assert.equal(image.hidden,false,'manual refresh is not exhausted after two failures');await image.dispatch('error');}
  reader.handleUpdate({auth:'ready',operation:'idle'});await flush();
  for(const image of images)assert.equal(image.hidden,true,'ordinary status polls retain the fallback');
  reader.hide();reader.handleUpdate({auth:'ready',operation:'idle'});await flush();
  for(const image of images)assert.equal(image.hidden,true,'hidden cards cannot restart image requests');reader.dispose();
});

test('automatic avatar retries use capped exponential backoff and preserve loaded images',async()=>{
  const f=dom();let now=0,round=0;
  const avatar='usagemonitor-x-media://resource/11111111-1111-4111-8111-111111111111';
  const value=post('123',{author:{name:'Author',handle:'author',avatar},quotedPost:post('124',{author:{name:'Quote',handle:'quote',avatar}})});
  const reader=mountXReader({container:f.container,clock:()=>now,bridge:bridge({listXPosts:async()=>({items:[value]})})});
  await reader.show();const images=walk(f.container).filter(el=>el.className==='x-reader-avatar');
  const [failed,loaded]=images;let requests=1,loadedRequests=1;
  Object.defineProperty(failed,'src',{get:()=>avatar,set:()=>{requests++;},configurable:true});
  Object.defineProperty(loaded,'src',{get:()=>avatar,set:()=>{loadedRequests++;},configurable:true});
  await failed.dispatch('error');await loaded.dispatch('load');
  const refresh=async()=>{reader.handleUpdate({auth:'ready',operation:'idle',lastUpdated:new Date(Date.UTC(2026,9,28)+ ++round*1000).toISOString()});await flush();};
  for(const delay of [60000,120000,240000,480000,960000,1800000,1800000]){
    const before=requests;now+=delay-1;await refresh();assert.equal(requests,before);
    now++;await refresh();assert.equal(requests,before+1);
    await refresh();assert.equal(requests,before+1,'overlapping refreshes share the pending image');
    await failed.dispatch('error');assert.equal(failed.hidden,true);
  }
  let before=requests;now+=1800000;
  reader.handleUpdate({auth:'ready',operation:'idle'});await flush();assert.equal(requests,before,'elapsed time alone does not turn a poll into a refresh');
  assert.equal(loadedRequests,1);assert.equal(loaded.hidden,false);
  assert.equal(walk(f.container).find(el=>el.className==='x-reader-avatar'),failed,'unchanged cards remain mounted');
  f.doc.hidden=true;await refresh();assert.equal(requests,before,'background documents cannot retry');
  f.doc.hidden=false;await refresh();assert.equal(requests,before+1);await failed.dispatch('error');before=requests;
  reader.handleUpdate({auth:'disconnected',operation:'idle'});await flush();
  await walk(f.container).find(el=>el.getAttribute('aria-label')==='刷新').dispatch('click');await flush();assert.equal(requests,before,'logout stops retries');
  reader.hide();await refresh();assert.equal(requests,before,'hidden readers stop retries');reader.dispose();
});

test('manual detail refresh retries failed avatars before waiting for post fetching',async()=>{
  const f=dom();let finish;
  const avatar='usagemonitor-x-media://resource/11111111-1111-4111-8111-111111111111';
  const value=post('123',{author:{name:'Author',handle:'author',avatar}});
  const reader=mountXReader({container:f.container,bridge:bridge({getXPost:async({force})=>force?new Promise(resolve=>finish=resolve):{post:value,replies:[],status:{auth:'ready',operation:'idle'}}})});
  await reader.show();await reader.openPost('123');
  const image=walk(f.container).find(el=>el.className==='x-reader-avatar');await image.dispatch('error');
  const refreshing=walk(f.container).find(el=>el.getAttribute('aria-label')==='刷新').dispatch('click');await flush();assert.equal(image.hidden,false);
  finish({post:value,replies:[],status:{auth:'ready',operation:'idle'}});await refreshing;
  assert.equal(walk(f.container).find(el=>el.className==='x-reader-avatar'),image);reader.dispose();
});

test('a successful avatar replaces its decorative fallback and disposed cards ignore late events',async()=>{
  const f=dom(),avatar='usagemonitor-x-media://resource/11111111-1111-4111-8111-111111111111';
  const reader=mountXReader({container:f.container,bridge:bridge({listXPosts:async()=>({items:[post('123',{author:{name:'Example',handle:'example',avatar}})]})})});
  await reader.show();const image=walk(f.container).find(el=>el.className==='x-reader-avatar'),fallback=walk(f.container).find(el=>el.className==='x-reader-avatar-fallback');
  await image.dispatch('load');assert.equal(image.hidden,false);assert.equal(fallback.hidden,true);
  reader.dispose();await image.dispatch('error');assert.equal(fallback.hidden,true);assert.equal(f.listeners.size,0);
});

test('a confirmed missing session shows login, while initial status read failure exposes retry without assuming logout',async()=>{
  for(const failed of [false,true]){
    const fixture=dom();let finishStatus,failStatus,finishList;
    const reader=mountXReader({container:fixture.container,bridge:bridge({getXStatus:()=>new Promise((resolve,reject)=>{finishStatus=resolve;failStatus=reject;}),listXPosts:()=>new Promise(resolve=>finishList=resolve)})});
    const showing=reader.show();const panel=walk(fixture.container).find(el=>el.className==='x-reader-login');assert.equal(panel.hidden,true);
    if(failed)failStatus(new Error('synthetic'));else finishStatus({auth:'disconnected',operation:'idle'});
    await flush();assert.equal(panel.hidden,failed);if(failed)assert.ok(find(fixture.container,'重试'));else assert.ok(find(panel,'网页登录'));
    finishList({items:[]});await showing;reader.dispose();
  }
});

test('login failures stay visible in reader and settings and clear after recovery',async()=>{
  for(const[error,message]of Object.entries({login_failed:'未能完成 X 登录',login_timeout:'登录超时',import_failed:'X 会话导入失败',offline:'无法连接 X',proxy_failed:'无法通过代理',invalid_import:'导入的会话无效',no_logged_in_session:'未找到 Chrome'})){
    const fixture=dom();const api=bridge({getXStatus:async()=>({auth:'disconnected',operation:'idle',error}),listXPosts:async()=>({items:[]})});
    const reader=mountXReader({container:fixture.container,bridge:api});reader.show();await flush();
    assert.ok(fixture.container.textContent.includes(message),error);
    reader.handleUpdate({auth:'ready',operation:'idle',error:null});await flush();assert.equal(fixture.container.textContent.includes(message),false,error);reader.dispose();
    const settingsFixture=dom();const settings=mountXSettings({container:settingsFixture.container,bridge:api});await flush();assert.ok(settingsFixture.container.textContent.includes(message),error);settings.dispose();
  }
});

test('IPC login errors render only closed messages, never raw error content',async()=>{
  const fixture=dom();const reader=mountXReader({container:fixture.container,bridge:bridge({getXStatus:async()=>({auth:'disconnected',operation:'idle'}),listXPosts:async()=>({items:[]}),beginXLogin:async()=>{throw new Error('IPC: login_timeout private-synthetic-secret');}})});
  reader.show();await flush();await find(fixture.container,'网页登录').dispatch('click');await flush();
  assert.ok(fixture.container.textContent.includes('登录超时'));assert.equal(fixture.container.textContent.includes('private-synthetic-secret'),false);reader.dispose();
});
function dom(){
  const timers=new Map(),listeners=new Map();let timer=0;
  const doc={documentElement:{lang:'zh-Hans'},defaultView:{setTimeout(callback){timers.set(++timer,callback);return timer;},clearTimeout(id){timers.delete(id);},confirm:()=>true},
    addEventListener(name,handler){listeners.set(name,handler);},removeEventListener(name){listeners.delete(name);}};
  class Element{
    constructor(tag){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.attributes=new Map();this.events=new Map();this.hidden=false;this.scrollTop=0;this._text='';this.className='';this.classList={toggle:()=>{}};}
    set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    append(...items){for(const item of items){if(item.parentElement)item.remove();item.parentElement=this;this.children.push(item);}}
    insertBefore(item,before){if(item===before)return;if(item.parentElement)item.remove();const index=before===null?this.children.length:this.children.indexOf(before);assert.ok(index>=0);item.parentElement=this;this.children.splice(index,0,item);}
    replaceChildren(...items){for(const child of this.children)child.parentElement=null;this.children=[];this._text='';this.append(...items);}
    setAttribute(name,value){this.attributes.set(name,String(value));}getAttribute(name){return this.attributes.get(name);}removeAttribute(name){this.attributes.delete(name);}
    addEventListener(name,callback){const handlers=this.events.get(name)??[];handlers.push(callback);this.events.set(name,handlers);}
    get offsetHeight(){return this.className==='x-reader-page-footer'?200:0;}
    removeEventListener(name,callback){this.events.set(name,(this.events.get(name)??[]).filter(handler=>handler!==callback));}
    async dispatch(name,event={}){for(const callback of this.events.get(name)??[])await callback({target:this,key:'',preventDefault(){},stopPropagation(){},...event});}
    remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}}
    querySelector(selector){return walk(this).find(el=>el.tagName===selector)??null;}focus(){doc.activeElement=this;}pause(){this.paused=true;}load(){}canPlayType(){return '';}
  }
  doc.createElement=tag=>new Element(tag);return{doc,container:new Element('main'),timers,listeners};
}
function walk(root){return root.children.flatMap(child=>[child,...walk(child)]);}
function find(root,text){return walk(root).find(el=>el.tagName==='button'&&el.textContent===text);}
function bridge(overrides={}){return{getXStatus:async()=>({auth:'ready',operation:'idle'}),listXPosts:async()=>({items:[post()],nextCursor:null}),getXPost:async({id})=>({post:post(id),replies:[]}),refreshX:async()=>({status:{auth:'ready',operation:'idle'}}),beginXLogin:async()=>({auth:'authorizing',operation:'idle'}),cancelXLogin:async()=>{},configureXImport:async()=>({extensionDirectory:'C:\\synthetic\\extension'}),getXSettings:async()=>({refreshMinutes:5,proxyMode:'system',proxyPort:10809,notifyPosts:false,notifyReplies:false}),setXSettings:async value=>value,logoutX:async()=>{},clearXCache:async()=>{},...overrides};}

test('manual reader refresh targets each active tab and a forced discussion without global refresh',async()=>{
  const fixture=dom(),refreshes=[],queries=[];
  const reader=mountXReader({container:fixture.container,bridge:bridge({refreshX:async query=>{refreshes.push(query);return{status:{auth:'ready',operation:'idle'}};},getXPost:async query=>{queries.push(query);return{post:post(query.id),replies:[post('125'),post('124')],outcome:'live'};}})});
  await reader.show();const refresh=walk(fixture.container).find(el=>el.getAttribute('aria-label')==='刷新');
  for(const[label,tab]of[['帖子','posts'],['回复','replies'],['转帖','reposts'],['媒体','media']]){await find(fixture.container,label).dispatch('click');await flush();await refresh.dispatch('click');await flush();assert.deepEqual(refreshes.at(-1),{tab});}
  const before=refreshes.length;await reader.openPost('123');const content=walk(fixture.container).find(el=>el.className==='x-reader-scroll');content.scrollTop=900;
  await refresh.dispatch('click');await flush();assert.deepEqual(queries.at(-1),{id:'123',force:true});assert.equal(refreshes.length,before);assert.equal(content.scrollTop,0);
  assert.deepEqual(walk(content).filter(el=>el.tagName==='article').map(el=>el.textContent.includes('A post')), [true,true,true]);reader.dispose();
});

test('forced detail refresh retains the old view on failure, replaces order on success and ignores late navigation results',async()=>{
  const fixture=dom();let finish;
  const reader=mountXReader({container:fixture.container,bridge:bridge({getXPost:async query=>query.force?new Promise(resolve=>finish=resolve):{post:post(query.id),replies:[post('124',{text:'Old reply'}),post('125',{text:'Second reply'})],nextCursor:'old-page',outcome:'live'}})});
  await reader.show();await reader.openPost('123');const content=walk(fixture.container).find(el=>el.className==='x-reader-scroll'),refresh=walk(fixture.container).find(el=>el.getAttribute('aria-label')==='刷新');content.scrollTop=900;
  await refresh.dispatch('click');await flush();assert.ok(content.textContent.includes('Old reply'));assert.equal(content.scrollTop,900);
  assert.equal(walk(content).filter(el=>el.className==='x-reader-replies-status'&&el.textContent==='正在加载评论…').length,1);assert.equal(walk(content.children.at(-1)).some(el=>el.tagName==='button'),false);
  finish({outcome:'failed',post:post('123',{text:'Unapplied result'}),replies:[],status:{auth:'ready',operation:'offline'}});await flush();assert.ok(content.textContent.includes('Old reply'));assert.equal(content.textContent.includes('Unapplied result'),false);assert.equal(find(content,'加载更多回复'),undefined);assert.equal(content.scrollTop,900);
  await refresh.dispatch('click');finish({post:post(),replies:[post('125',{text:'New first'}),post('124',{text:'New second'})],outcome:'live',status:{auth:'ready',operation:'idle'}});await flush();
  const articles=walk(content).filter(el=>el.tagName==='article');assert.ok(articles[1].textContent.includes('New first'));assert.ok(articles[2].textContent.includes('New second'));assert.equal(content.scrollTop,0);
  await refresh.dispatch('click');await find(fixture.container,'媒体').dispatch('click');await flush();finish({post:post('123',{text:'Late refresh'}),replies:[],outcome:'live'});await flush();assert.equal(content.textContent.includes('Late refresh'),false);reader.dispose();
});

test('a late tab refresh cannot read or replace the newly selected tab',async()=>{
  const fixture=dom(),reads=[];let finish;
  const reader=mountXReader({container:fixture.container,bridge:bridge({refreshX:()=>new Promise(resolve=>finish=resolve),listXPosts:async({tab})=>{reads.push(tab);return{items:[post(tab==='posts'?'123':'124',{text:tab})]};}})});
  await reader.show();await walk(fixture.container).find(el=>el.getAttribute('aria-label')==='刷新').dispatch('click');await find(fixture.container,'回复').dispatch('click');await flush();const before=reads.length;
  finish({status:{auth:'ready',operation:'idle'}});await flush();assert.equal(reads.length,before);assert.deepEqual(reads.at(-1),'replies');reader.dispose();
});

test('automatic pagination loads near the bottom once, shows progress, and stops on failure until manual retry',async()=>{
  const fixture=dom();let finish,calls=0,fail=true;
  const reader=mountXReader({container:fixture.container,bridge:bridge({listXPosts:async({cursor})=>{
    if(!cursor)return{items:[post()],nextCursor:'next'};
    calls++;if(fail)return new Promise(resolve=>finish=resolve);
    return{items:[post('122')],nextCursor:null,hasMore:false};
  }})});
  await reader.show();const content=walk(fixture.container).find(el=>el.className==='x-reader-scroll');content.clientHeight=600;content.scrollHeight=1800;
  await content.dispatch('scroll');await flush();assert.equal(calls,0);
  const footer=content.children.at(-1);assert.equal(footer.className,'x-reader-page-footer');
  content.scrollTop=999;await content.dispatch('scroll');await flush();assert.equal(calls,0);
  content.scrollTop=1000;await content.dispatch('scroll');await content.dispatch('scroll');await flush();assert.equal(calls,1);
  assert.equal(content.children.at(-1),footer);
  assert.equal(walk(content).find(el=>el.className==='x-reader-more').getAttribute('aria-busy'),'true');
  finish({items:[],nextCursor:'next',hasMore:true,outcome:'failed'});await flush();
  await content.dispatch('scroll');await flush();assert.equal(calls,1);assert.ok(find(content,'加载更多'));
  fail=false;await find(content,'加载更多').dispatch('click');await flush();assert.equal(calls,2);assert.equal(walk(content).filter(el=>el.tagName==='article').length,2);
  assert.equal(content.children.at(-1),footer);assert.equal(footer.children.length,0);
  reader.dispose();await content.dispatch('scroll');assert.equal(calls,2);assert.equal(content.events.get('scroll').length,0);
});

test('service terminal pages with no continuation never refetch on repeated scrolling',async()=>{
  const fixture=dom();let listCalls=0,replyCalls=0;
  const reader=mountXReader({container:fixture.container,bridge:bridge({
    listXPosts:async()=>{listCalls++;return{items:[post()],hasMore:false,nextCursor:null};},
    getXPost:async({id})=>{replyCalls++;return{post:post(id),replies:[post('124')],repliesExhausted:true,nextCursor:null};}
  })});
  await reader.show();const content=walk(fixture.container).find(el=>el.className==='x-reader-scroll');content.clientHeight=600;content.scrollHeight=800;content.scrollTop=0;
  const initialListCalls=listCalls;
  for(let i=0;i<5;i++){await content.dispatch('scroll');await flush();}
  assert.equal(listCalls,initialListCalls);assert.equal(find(content,'加载更多'),undefined);
  await reader.openPost('123');assert.equal(replyCalls,1);
  for(let i=0;i<5;i++){await content.dispatch('scroll');await flush();}
  assert.equal(replyCalls,1);assert.equal(find(content,'加载更多回复'),undefined);assert.ok(content.textContent.includes('当前可见回复已加载完'));reader.dispose();
});

test('automatic reply pagination fills a short viewport and pauses duplicate pages without claiming the end',async()=>{
  const fixture=dom();let calls=0;
  const reader=mountXReader({container:fixture.container,bridge:bridge({getXPost:async({id,cursor})=>{
    if(!cursor)return{post:post(id),replies:[post('124')],nextCursor:'first'};
    calls++;return{post:post(id),replies:[post('124'),post('125')],nextCursor:calls===1?'second':'third',repliesExhausted:false};
  }})});
  await reader.show();const content=walk(fixture.container).find(el=>el.className==='x-reader-scroll');content.clientHeight=600;content.scrollHeight=500;
  await reader.openPost('123');await flush();assert.equal(calls,2);assert.equal(walk(content).filter(el=>el.tagName==='article').length,3);
  assert.ok(content.textContent.includes('未能继续加载回复'));assert.equal(content.textContent.includes('当前可见回复已加载完'),false);
  await content.dispatch('scroll');await flush();assert.equal(calls,2);
  reader.hide();await content.dispatch('scroll');await flush();assert.equal(calls,2);reader.dispose();
});

test('reply pages are single-flight, retryable, deduplicated and show only explicit end',async()=>{
  const fixture=dom();let finish,calls=0;
  const reader=mountXReader({container:fixture.container,bridge:bridge({getXPost:async query=>{if(!query.cursor)return{post:post(),replies:[post('124')],nextCursor:'reply-page',repliesExhausted:false};calls++;return new Promise(resolve=>{finish=resolve;});}})});
  await reader.show();await reader.openPost('123');assert.equal(find(fixture.container,'加载更多回复'),undefined);
  const content=walk(fixture.container).find(el=>el.className==='x-reader-scroll'),footer=content.children.at(-1);
  assert.equal(footer.children.length,0);content.clientHeight=600;content.scrollHeight=1800;content.scrollTop=1000;
  await content.dispatch('scroll');await content.dispatch('scroll');await flush();assert.equal(calls,1);
  assert.equal(walk(content).filter(el=>el.textContent==='正在加载评论…'&&el.className==='x-reader-replies-status').length,1);
  assert.equal(walk(footer).some(el=>el.tagName==='button'),false);assert.equal(content.children.at(-1),footer);
  finish({post:post(),replies:[post('124')],nextCursor:'reply-page',outcome:'failed',error:'pagination_pending'});await flush();assert.ok(find(footer,'重试'));assert.ok(fixture.container.textContent.includes('未能继续加载回复'));assert.equal(fixture.container.textContent.includes('当前可见回复已加载完'),false);
  await content.dispatch('scroll');await flush();assert.equal(calls,1);
  const retry=find(footer,'重试');reader.handleUpdate({auth:'ready',operation:'loading'});await flush();assert.equal(retry.textContent,'重试');assert.equal(Boolean(retry.disabled),false);
  reader.handleUpdate({auth:'ready',operation:'idle'});await retry.dispatch('click');await retry.dispatch('click');await flush();assert.equal(calls,2);assert.equal(find(footer,'重试'),undefined);
  finish({post:post(),replies:[post('124'),post('125')],nextCursor:null,repliesExhausted:true});await flush();
  assert.equal(walk(fixture.container).filter(el=>el.tagName==='article').length,3);assert.ok(fixture.container.textContent.includes('当前可见回复已加载完'));assert.equal(Boolean(find(fixture.container,'加载更多回复')),false);assert.equal(content.children.at(-1),footer);await content.dispatch('scroll');await flush();assert.equal(calls,2);reader.dispose();
});

test('reply branches keep independent pages and restore parent scroll, ignoring late page UI',async()=>{
  const fixture=dom();let finish;
  const reader=mountXReader({container:fixture.container,bridge:bridge({getXPost:async query=>query.cursor?new Promise(resolve=>{finish=resolve;}):{post:post(query.id,{text:query.id==='124'?'Parent reply':'A post'}),replies:query.id==='123'?[post('124',{text:'Parent reply'})]:[post('126',{text:'Branch child'})],nextCursor:query.id==='123'?'parent-page':null,repliesExhausted:query.id!=='123'}})});
  await reader.show();await reader.openPost('123');const content=walk(fixture.container).find(el=>el.className==='x-reader-scroll');content.clientHeight=600;content.scrollHeight=1800;content.scrollTop=1000;
  await content.dispatch('scroll');await flush();content.scrollTop=777;await reader.openPost('124');assert.ok(fixture.container.textContent.includes('Branch child'));assert.equal(Boolean(find(fixture.container,'加载更多回复')),false);
  finish({post:post(),replies:[post('999',{text:'Late parent reply'})],nextCursor:null,repliesExhausted:true});await flush();assert.equal(fixture.container.textContent.includes('Late parent reply'),false);
  await walk(fixture.container).find(el=>el.getAttribute('aria-label')==='返回').dispatch('click');assert.equal(content.scrollTop,777);assert.ok(fixture.container.textContent.includes('Parent reply'));assert.equal(find(fixture.container,'加载更多回复'),undefined);reader.dispose();
});

test('publication clocks use exact UTC, device timezone and Pacific DST',()=>{
  assert.equal(formatXClocks('2026-10-19T14:59:00.000Z','Asia/Tokyo'),'JST 23:59 10/19   PDT 07:59 10/19');
  assert.equal(formatXClocks('2026-12-19T14:59:00.000Z','Asia/Tokyo'),'JST 23:59 12/19   PST 06:59 12/19');
  assert.equal(formatXClocks('invalid'),null);
});
test('X messages reach the real canonical browser localization facade',()=>{
  assert.equal(translate('x.posts',{},'zh-Hans'),'帖子');assert.equal(translate('x.title',{},'en-US'),'X updates');assert.equal(translate('x.refresh',{},'es'),'Actualizar');
});

test('reader and settings show each local session failure while retaining readable cache',async()=>{
  const messages={session_profile_limit:'X 会话超出安全处理范围',session_permission_failed:'无法访问已保存',session_write_failed:'无法写入',session_persist_failed:'无法将 X 会话保存',session_read_failed:'无法读取已保存',session_decrypt_failed:'解密不可用',session_restore_failed:'无法恢复已保存',session_clear_failed:'未能完整清除'};
  for(const[error,message]of Object.entries(messages)){
    const status={auth:'disconnected',operation:'error',error};
    const f=dom();const b=bridge({getXStatus:async()=>status,listXPosts:async()=>({items:[post()],source:'cache',status})});
    const reader=mountXReader({container:f.container,bridge:b,translate:key=>translate(key,{},'zh-Hans')});
    await reader.show();await flush();assert.ok(f.container.textContent.includes(message),error);assert.ok(f.container.textContent.includes('A post'));reader.dispose();
    const settings=mountXSettings({container:f.container,bridge:b,translate:key=>translate(key,{},'zh-Hans')});await flush();assert.ok(f.container.textContent.includes(message),error);settings.dispose();
  }
});
test('browser has no desktop X integration and HLS uses a single local lazy script',async()=>{
  const fixture=dom();assert.equal(mountDesktopXReader({documentRef:fixture.doc,windowRef:{}}),null);
  fixture.doc.head=fixture.doc.createElement('head');const windowRef={};const first=loadLocalXHls({documentRef:fixture.doc,windowRef}),second=loadLocalXHls({documentRef:fixture.doc,windowRef});
  assert.equal(first,second);assert.equal(fixture.doc.head.children.length,1);assert.equal(fixture.doc.head.children[0].src,'./vendor/hls.light.min.js');
  const Hls=class{};windowRef.Hls=Hls;fixture.doc.head.children[0].onload();assert.equal(await first,Hls);
});
test('post projection retains text as data and rejects external or arbitrary resource addresses',()=>{
  const projected=normalizeXPost(post('123',{text:'<img onerror="unsafe()">',secret:'no',media:[
    {id:'1',type:'image',src:'usagemonitor-x-media://resource/opaque-1'},
    {id:'2',type:'image',src:'https://remote.invalid/image'},
    {id:'3',type:'image',src:'usagemonitor-x-media://other/path'},
    {id:'4',type:'image',src:'usagemonitor-x-media://resource/id?file=C:/secret'},
  ]}));
  assert.equal(projected.text,'<img onerror="unsafe()">');assert.equal(projected.media.length,1);assert.equal('secret' in projected,false);
  assert.equal(normalizeXPost(post('../bad')),null);assert.equal(normalizeXPost(post('1',{createdAt:'invalid'})),null);
});
test('reader preserves tab scroll, renders plain text, releases media and owns one polling timer',async()=>{
  const fixture=dom(),calls=[];const mounted=mountXReader({container:fixture.container,bridge:bridge({listXPosts:async({tab})=>{calls.push(tab);return{items:[post('123',{text:'<script>untrusted</script>',media:[{id:'v',type:'video',src:'usagemonitor-x-media://resource/video',mimeType:'video/mp4'}]})]};}})});
  await mounted.show();await flush();assert.equal(fixture.timers.size,1);
  assert.ok(fixture.container.textContent.includes('<script>untrusted</script>'));assert.equal(walk(fixture.container).some(el=>el.tagName==='script'),false);
  const content=walk(fixture.container).find(el=>el.className==='x-reader-scroll');content.scrollTop=180;
  await find(fixture.container,'回复').dispatch('click');await flush();await find(fixture.container,'帖子').dispatch('click');await flush();assert.equal(content.scrollTop,180);
  mounted.refreshLocale({locale:'en-US'});assert.ok(find(fixture.container,'Posts'));assert.equal(content.scrollTop,180);mounted.refreshLocale({locale:'zh-Hans'});
  const video=walk(fixture.container).find(el=>el.tagName==='video');mounted.hide();assert.equal(video.paused,true);assert.equal(fixture.timers.size,0);
  await mounted.show();await flush();assert.equal(fixture.timers.size,1);mounted.dispose();assert.equal(fixture.timers.size,0);assert.equal(fixture.listeners.size,0);assert.equal(fixture.container.children.length,0);
});
test('late page results cannot replace the current tab or a hidden reader',async()=>{
  const fixture=dom();let resolveOld;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({getXStatus:async()=>({auth:'disconnected',operation:'idle'}),listXPosts:({tab})=>tab==='posts'?new Promise(resolve=>resolveOld=resolve):Promise.resolve({items:[post('222',{text:'Reply page'})]})})});
  const showing=mounted.show();await flush();await find(fixture.container,'回复').dispatch('click');await flush();assert.ok(fixture.container.textContent.includes('Reply page'));
  resolveOld({items:[post('111',{text:'Late stale result'})]});await showing;await flush();assert.ok(!fixture.container.textContent.includes('Late stale result'));
  mounted.hide();mounted.handleUpdate({status:{auth:'expired',operation:'idle'}});assert.equal(fixture.timers.size,0);mounted.dispose();
});

test('background updates and pagination preserve mounted playback; removed players are released',async()=>{
  const fixture=dom(),videoPost=post('123',{media:[{id:'v',type:'video',src:'usagemonitor-x-media://resource/video',mimeType:'video/mp4'}]});let rows=[videoPost],more=false;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({listXPosts:async({cursor})=>({items:cursor?[post('100')]:rows,nextCursor:more&&!cursor?'next':null})})});
  await mounted.show();await flush();const video=walk(fixture.container).find(el=>el.tagName==='video');let resets=0;video.load=()=>resets++;video.paused=false;video.currentTime=12;
  mounted.handleUpdate({auth:'ready',operation:'loading'});await flush();assert.equal(walk(fixture.container).find(el=>el.tagName==='video'),video);assert.equal(video.paused,false);assert.equal(resets,0);
  rows=[post('124'),{...videoPost,text:'Expanded in place'}];more=true;mounted.handleUpdate({auth:'ready',operation:'idle'});await flush();
  assert.equal(walk(fixture.container).find(el=>el.tagName==='video'),video);assert.equal(video.currentTime,12);assert.ok(fixture.container.textContent.includes('Expanded in place'));
  await find(fixture.container,'加载更多').dispatch('click');await flush();assert.equal(walk(fixture.container).find(el=>el.tagName==='video'),video);assert.equal(resets,0);
  rows=[];mounted.handleUpdate({auth:'ready',operation:'idle'});await flush();assert.equal(video.paused,true);assert.equal(resets,1);assert.equal(walk(fixture.container).includes(video),false);mounted.dispose();
});

test('late detail replies do not reset a main video started while the detail was loading',async()=>{
  const fixture=dom(),videoPost=post('123',{media:[{id:'v',type:'video',src:'usagemonitor-x-media://resource/video',mimeType:'video/mp4'}]});let finish;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({listXPosts:async()=>({items:[videoPost]}),getXPost:()=>new Promise(resolve=>finish=resolve)})});
  await mounted.show();const opening=mounted.openPost('123');await flush();const video=walk(fixture.container).find(el=>el.tagName==='video');let resets=0;video.load=()=>resets++;video.paused=false;video.currentTime=3;
  finish({post:videoPost,replies:[post('124',{text:'A reply'})]});await opening;
  assert.equal(walk(fixture.container).find(el=>el.tagName==='video'),video);assert.equal(resets,0);assert.equal(video.paused,false);assert.equal(video.currentTime,3);assert.ok(fixture.container.textContent.includes('A reply'));
  await walk(fixture.container).find(el=>el.getAttribute('aria-label')==='返回').dispatch('click');assert.equal(video.paused,true);assert.equal(resets,1);mounted.dispose();
});

test('detail comments expose loading, empty and retry states with a fixed return control and no repeated heading',async()=>{
  const fixture=dom();let finish;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({getXPost:()=>new Promise(resolve=>finish=resolve)})});await mounted.show();
  assert.equal(walk(fixture.container).some(el=>el.tagName==='h2'),false);
  const opening=mounted.openPost('123');await flush();assert.ok(fixture.container.textContent.includes('正在加载评论…'));
  const back=walk(fixture.container).find(el=>el.getAttribute('aria-label')==='返回');assert.equal(back.parentElement.className,'x-reader-back-slot');assert.equal(back.parentElement.parentElement.className,'x-reader-toolbar');assert.equal(back.hidden,false);
  const content=walk(fixture.container).find(el=>el.className==='x-reader-scroll');content.scrollTop=900;assert.equal(back.parentElement===content,false);
  finish({post:post(),replies:[],source:'cache',outcome:'failed',error:'offline',status:{auth:'ready',operation:'offline'}});await opening;
  assert.ok(fixture.container.textContent.includes('评论加载失败'));assert.equal(fixture.container.textContent.includes('暂无评论'),false);
  const retry=walk(fixture.container).find(el=>el.className==='x-reader-replies-status').children.find(el=>el.tagName==='button');await retry.dispatch('click');await flush();assert.ok(fixture.container.textContent.includes('正在加载评论…'));
  finish({post:post(),replies:[],source:'live',status:{auth:'ready',operation:'idle'}});await flush();assert.ok(fixture.container.textContent.includes('暂无评论'));assert.equal(fixture.container.textContent.includes('正在加载评论…'),false);
  await back.dispatch('click');assert.equal(back.hidden,true);mounted.dispose();
});

test('cached detail replies remain readable without inheriting unrelated operation failures',async()=>{
  for(const operation of ['loading','offline','error','parser_changed']){
    const fixture=dom();const mounted=mountXReader({container:fixture.container,bridge:bridge({getXPost:async()=>({post:post(),replies:[post('124',{text:'Saved reply'})],source:'cache',status:{auth:'ready',operation}})})});
    await mounted.show();await mounted.openPost('123');await flush();
    assert.ok(fixture.container.textContent.includes('Saved reply'));
    const replyStatus=walk(fixture.container).find(el=>el.className==='x-reader-replies-status');
    assert.equal(replyStatus.textContent,'显示已保存的内容');assert.equal(replyStatus.children.some(el=>el.tagName==='button'),false);
    assert.equal(fixture.container.textContent.includes('评论加载失败'),false);mounted.dispose();
  }
});

test('live detail outcome ignores shared background errors and explicit detail failure retains saved replies',async()=>{
  const fixture=dom();let fail=false;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({getXPost:async()=>({post:post(),replies:[post('124',{text:'Readable reply'})],source:fail?'cache':'live',outcome:fail?'failed':'live',error:fail?'offline':null,status:{auth:'ready',operation:'error'}})})});
  await mounted.show();await mounted.openPost('123');
  assert.equal(fixture.container.textContent.includes('评论加载失败'),false);
  fail=true;await mounted.openPost('123');
  assert.ok(fixture.container.textContent.includes('Readable reply'));assert.ok(fixture.container.textContent.includes('评论加载失败'));
  assert.ok(find(fixture.container,'重试'));mounted.dispose();
});

test('returning during a comment request ignores late replies',async()=>{
  const fixture=dom();let finish;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({getXPost:()=>new Promise(resolve=>finish=resolve)})});await mounted.show();const opening=mounted.openPost('123');await flush();
  await walk(fixture.container).find(el=>el.getAttribute('aria-label')==='返回').dispatch('click');finish({post:post(),replies:[post('124',{text:'Late comment'})]});await opening;
  assert.equal(fixture.container.textContent.includes('Late comment'),false);mounted.dispose();
});

test('load more is single-flight, remains retryable on no progress, and retains the tail across head updates',async()=>{
  const fixture=dom(),calls=[];let finish,step=0;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({listXPosts:async({cursor})=>{
    calls.push(cursor??'head');if(!cursor)return {items:[post('123')],nextCursor:'first'};
    if(step++===0)return new Promise(resolve=>finish=resolve);
    if(cursor==='first')return {items:[post('122')],nextCursor:'tail'};
    return {items:[],nextCursor:null,hasMore:false};
  }})});
  await mounted.show();await flush();const button=find(fixture.container,'加载更多');await button.dispatch('click');await flush();assert.equal(button.disabled,true);await button.dispatch('click');assert.equal(calls.filter(value=>value==='first').length,1);
  finish({items:[],nextCursor:'first',hasMore:true,status:{auth:'ready',operation:'error',error:'pagination_pending'}});await flush();assert.ok(find(fixture.container,'加载更多'));assert.equal(find(fixture.container,'加载更多').disabled,false);
  await find(fixture.container,'加载更多').dispatch('click');await flush();assert.ok(fixture.container.textContent.includes('A post'));
  mounted.handleUpdate({auth:'ready',operation:'idle'});await flush();assert.equal(walk(fixture.container).filter(el=>el.tagName==='article').length,2);
  await find(fixture.container,'加载更多').dispatch('click');await flush();assert.equal(calls.at(-1),'tail');assert.equal(find(fixture.container,'加载更多'),undefined);mounted.dispose();
});

test('load more transport failure leaves its continuation available to retry',async()=>{
  const fixture=dom();let fail=true;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({listXPosts:async({cursor})=>{if(!cursor)return {items:[post()],nextCursor:'next'};if(fail)throw new Error('Synthetic');return {items:[post('122')],nextCursor:null,hasMore:false};}})});
  await mounted.show();await find(fixture.container,'加载更多').dispatch('click');await flush();assert.ok(find(fixture.container,'加载更多'));assert.equal(find(fixture.container,'加载更多').disabled,false);
  fail=false;await find(fixture.container,'加载更多').dispatch('click');await flush();assert.equal(walk(fixture.container).filter(el=>el.tagName==='article').length,2);assert.equal(find(fixture.container,'加载更多'),undefined);mounted.dispose();
});

test('leaving during pagination does not block a fresh read or accept a late page on return',async()=>{
  const fixture=dom();let finish;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({listXPosts:async({cursor})=>cursor?new Promise(resolve=>finish=resolve):{items:[post()],nextCursor:'next'}})});
  await mounted.show();await find(fixture.container,'加载更多').dispatch('click');await flush();mounted.hide();await mounted.show();await flush();
  assert.equal(find(fixture.container,'加载更多').disabled,false);finish({items:[post('122',{text:'Late page'})],nextCursor:null,hasMore:false});await flush();assert.equal(fixture.container.textContent.includes('Late page'),false);assert.ok(find(fixture.container,'加载更多'));mounted.dispose();
});
test('login choice can cancel and switch without exposing credentials',async()=>{
  const fixture=dom(),methods=[];let cancelled=0;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({getXStatus:async()=>({auth:'disconnected',operation:'idle'}),listXPosts:async()=>({items:[]}),beginXLogin:async({method})=>{methods.push(method);return{auth:'authorizing',operation:'idle'};},cancelXLogin:async()=>{cancelled++;}})});
  await mounted.show();assert.equal(fixture.container.textContent.split('选择登录方式').length-1,1);assert.ok(!fixture.container.textContent.includes('暂无动态'));assert.equal(find(fixture.container,'登录'),undefined);
  await find(fixture.container,'Session 登录').dispatch('click');await flush();assert.deepEqual(methods,['session']);
  await find(fixture.container,'返回，选择其他方式').dispatch('click');await flush();assert.equal(cancelled,1);
  await find(fixture.container,'网页登录').dispatch('click');assert.deepEqual(methods,['session','web']);mounted.dispose();
});
test('import bridge codes have precise UI states and a false configure result remains visible',async()=>{
  for(const[code,label]of [['bridge_ready','本机桥接已就绪'],['import_ready','等待从 Chrome 导入会话'],['bridge_unavailable','本机桥接配置失败'],['not_configured','尚未配置本机桥接']]){
    const fixture=dom();const mounted=mountXReader({container:fixture.container,translate:key=>translate(key,{},'zh-Hans'),bridge:bridge({getXStatus:async()=>({auth:'authorizing',loginMethod:'session',operation:'idle',import:{code}}),listXPosts:async()=>({items:[]}),configureXImport:async()=>({configured:false,code:'bridge_ready'})})});
    await mounted.show();assert.ok(fixture.container.textContent.includes(label),code);await find(fixture.container,'配置 Chrome 导入').dispatch('click');assert.ok(fixture.container.textContent.includes('本机桥接配置失败'));mounted.dispose();
  }
});
test('Session login distinguishes waiting for Chrome from verifying the delivered session',async()=>{
  const fixture=dom();let code='import_ready';
  const mounted=mountXReader({container:fixture.container,bridge:bridge({getXStatus:async()=>({auth:'authorizing',loginMethod:'session',operation:'idle',import:{configured:true,code,pending:code==='import_ready'}}),listXPosts:async()=>({items:[]})})});
  await mounted.show();assert.ok(fixture.container.textContent.includes('等待从 Chrome 导入会话'));
  assert.ok(!fixture.container.textContent.includes('请在 X 窗口完成登录'));
  code='verification_pending';mounted.handleUpdate({auth:'authorizing',loginMethod:'session',operation:'idle',import:{configured:true,code,pending:false}});
  assert.ok(fixture.container.textContent.includes('验证 X 登录'));
  assert.ok(!fixture.container.textContent.includes('等待从 Chrome 导入会话'));
  mounted.dispose();
});

test('Session progress renders precise steps in reader and settings, with challenge action and failed step',async()=>{
  const fixture=dom(),settingsFixture=dom();let status={auth:'authorizing',loginMethod:'session',operation:'idle',loginStage:'waiting_import',import:{configured:true,code:'import_ready',pending:true}};const methods=[];
  const api=bridge({getXStatus:async()=>status,listXPosts:async()=>({items:[]}),beginXLogin:async({method})=>{methods.push(method);return status;}});
  const reader=mountXReader({container:fixture.container,bridge:api}),settings=mountXSettings({container:settingsFixture.container,bridge:api});await reader.show();await flush();
  for(const[stage,label]of Object.entries({checking_bridge:'检查本机桥接',waiting_import:'点击“导入当前 X 会话”',validating:'校验导入数据',preparing:'准备独立登录会话',writing:'写入候选会话',connecting:'连接 X',verifying:'验证 X 登录',saving:'保存登录状态',challenge:'需要在 X 完成验证'})){
    status={...status,auth:stage==='challenge'?'challenge':'authorizing',loginStage:stage};reader.handleUpdate(status);settings.handleUpdate(status);
    assert.ok(fixture.container.textContent.includes(label),stage);assert.ok(settingsFixture.container.textContent.includes(label),stage);
    if(['connecting','verifying','saving','challenge'].includes(stage))assert.equal(Boolean(find(fixture.container,'配置 Chrome 导入')),false,stage);
  }
  await find(fixture.container,'打开 X 窗口').dispatch('click');await flush();assert.deepEqual(methods,['web']);
  status={auth:'disconnected',operation:'error',error:'offline',loginMethod:null,loginStage:null,loginFailureStage:'connecting'};reader.handleUpdate(status);settings.handleUpdate(status);
  for(const container of [fixture.container,settingsFixture.container])assert.ok(container.textContent.includes('失败步骤：连接 X · 无法连接 X'));
  reader.handleUpdate({auth:'ready',operation:'idle',loginStage:'complete',error:null});await flush();assert.equal(fixture.container.textContent.includes('失败步骤'),false);
  reader.dispose();settings.dispose();
});

test('Chrome validation failure is visible without claiming X authentication failed',async()=>{
  const fixture=dom();const reader=mountXReader({container:fixture.container,bridge:bridge({getXStatus:async()=>({auth:'authorizing',loginMethod:'session',operation:'idle',loginStage:'waiting_import',import:{configured:true,pending:true,failure:'no_logged_in_session'}}),listXPosts:async()=>({items:[]})})});
  await reader.show();assert.ok(fixture.container.textContent.includes('失败步骤：校验导入数据'));assert.ok(fixture.container.textContent.includes('未找到 Chrome 中已登录的 X 会话'));
  reader.dispose();
});

test('full text prefetch has at most two concurrent requests and ignores hidden completion',async()=>{
  const fixture=dom(),pending=[];let inflight=0,max=0;
  const mounted=mountXReader({container:fixture.container,bridge:bridge({listXPosts:async()=>({items:['11','22','33','44'].map(id=>post(id,{complete:false}))}),getXPost:({id})=>new Promise(resolve=>{inflight++;max=Math.max(max,inflight);pending.push(()=>{inflight--;resolve({post:post(id,{text:'Expanded'}),replies:[]});});})})});
  await mounted.show();await flush();assert.equal(pending.length,2);pending.shift()();await flush();assert.equal(max,2);assert.equal(pending.length,2);
  mounted.hide();for(const resolve of pending)resolve();await flush();assert.equal(max,2);mounted.dispose();
});
test('settings reject invalid scheduling and keep proxy and notification controls explicit',async()=>{
  const value={refreshMinutes:5,proxyMode:'system',proxyPort:10809,notifyPosts:false,notifyReplies:false};assert.equal(validateXSettings(value),true);
  for(const refreshMinutes of [0,1.5,-2,NaN])assert.equal(validateXSettings({...value,refreshMinutes}),false);
  assert.equal(validateXSettings({...value,refreshMinutes:-1}),true);assert.equal(validateXSettings({...value,proxyPort:65536}),false);
  const fixture=dom(),saved=[];const mounted=mountXSettings({container:fixture.container,bridge:bridge({setXSettings:async value=>{saved.push(value);return value;}})});await flush();
  const interval=walk(fixture.container).find(el=>el.id==='x-setting-refreshMinutes');interval.value='-1';await find(fixture.container,'保存').dispatch('click');assert.equal(saved[0].refreshMinutes,-1);
  interval.value='8';mounted.refreshLocale({locale:'en-US'});assert.equal(interval.value,'8');assert.ok(find(fixture.container,'Save'));mounted.refreshLocale({locale:'zh-Hans'});
  interval.value='0';await find(fixture.container,'保存').dispatch('click');assert.equal(saved.length,1);mounted.dispose();
});
