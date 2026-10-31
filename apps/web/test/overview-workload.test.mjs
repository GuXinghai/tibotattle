import test from "node:test";
import assert from "node:assert/strict";
import {normalizeOverviewWorkload,renderOverviewWorkload} from "../public/overview-workload.js";
import {translate} from "../public/localization.js";
import {normalizeDashboardPayload} from '../public/data-client.js';
function documentFixture(){const doc={};class Element{
  constructor(tag){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.dataset={};this.style={};this.attrs={};this.classList={add:(x)=>{this.className=(this.className??"")+" "+x;}};}
  append(...nodes){this.children.push(...nodes);}replaceChildren(){this.children=[];}setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(type,listener){this.listeners??={};this.listeners[type]=listener;}focus(){doc.activeElement=this;}
  contains(n){return this===n||this.all().includes(n);}
  querySelector(selector){if(selector.startsWith('[data-workload-diagnostic-focus=')){const k=selector.match(/="([^"]+)"/)[1];return this.all().find(n=>n.dataset.workloadDiagnosticFocus===k);}
    if(selector==='button:not(:disabled)')return this.all().find(n=>n.tagName==='button'&&!n.disabled);return null;}
  set textContent(v){this.text=v;this.children=[];}get textContent(){return(this.text??"")+this.children.map(x=>x.textContent).join("");}
  all(){return this.children.flatMap(x=>[x,...x.all()]);}}
  doc.createElement=tag=>new Element(tag);doc.createElementNS=(_,tag)=>new Element(tag);doc.createTextNode=text=>{const n=new Element("text-node");n.textContent=text;return n;};
  return new Element("div");}
const payload=()=>({schemaVersion:"overview-workload-v2",status:"available",generatedAt:"2026-10-15T12:00:00.000Z",errors:[],
  allowance:{remainingPercent:66,points:[]},workHours:[{level:"heavy",hours:22},{level:"medium",hours:44},{level:"light",hours:132},{level:"composite",hours:38.6}],
  daily:[{date:"2026-10-15",covered:true,heavy:2,medium:1,light:1,unclassified:0}],
  current:{state:"working",level:"heavy",ratePpPerHour:4.2,hours:15.7},comparison:{startedAtMs:Date.parse("2026-10-15T10:00:00Z"),actualPp:2,expectedPp:1}});
const render=(root,value)=>renderOverviewWorkload(root,normalizeOverviewWorkload(value),{translate:(key,values)=>translate(key,values,"zh-Hans"),locale:"zh-CN"});
const currentPayload=()=>({...payload(),schemaVersion:'overview-workload-v9',
  unallocated:{totalIntervals:0,plans:[],records:[],truncated:false},
  current:{windowMinutes:15,state:'available',level:'heavy',usdPerHour:4.2,ratePpPerHour:4.2,hours:15.7},
  trend:{windowMinutes:60,state:'available',ratePpPerHour:1,usdPerHour:4.2,level:'medium',observedFrom:'2026-10-15T11:40:00Z',
    observedThrough:'2026-10-15T12:00:00Z',coveredMinutes:20,inferred:false}});

test('current quota renders independently while historical statistics are old or absent',()=>{
  const normalized=normalizeDashboardPayload({overview:{quota:{status:'available',observedAt:'2026-10-15T12:00:00Z'},
    quotaWindows:[{limitId:'codex',durationMinutes:10080,usedPercent:21,remainingPercent:79}]}});
  for(const data of [null,normalizeOverviewWorkload(payload())]){
    const root=documentFixture();
    renderOverviewWorkload(root,data,{translate:(key,values)=>translate(key,values,'zh-Hans'),locale:'zh-CN',
      currentQuota:{status:normalized.quotaWindows.length?'available':'unavailable',windows:normalized.quotaWindows}});
    const card=root.all().find(x=>x.dataset.workloadCard==='allowance');
    assert.match(card.textContent,/79%/u);
    assert.doesNotMatch(card.textContent,/66%/u);
  }
  const root=documentFixture();
  renderOverviewWorkload(root,normalizeOverviewWorkload(payload()),{translate:(key,values)=>translate(key,values,'zh-Hans'),
    currentQuota:{status:'unavailable',windows:[]}});
  assert.doesNotMatch(root.all().find(x=>x.dataset.workloadCard==='allowance').textContent,/66%/u);
});

test('missing allowance observations never claim that collection is running',()=>{
  for(const status of ['available','partial','stale','unavailable']){
    for(const points of [[],[{at:'2026-10-15T12:00:00Z',remainingPercent:null}]]){
      const root=documentFixture(),p=currentPayload();
      render(root,{...p,status,allowance:{...p.allowance,points}});
      const card=root.all().find(x=>x.dataset.workloadCard==='allowance');
      assert.match(card.textContent,/暂无可用额度观测/u);
      assert.doesNotMatch(card.textContent,/正在采集|采集中/u);
      assert.equal(card.all().filter(x=>x.tagName==='polyline'||x.tagName==='circle').length,0);
    }
  }
  const root=documentFixture(),p=currentPayload();
  render(root,{...p,allowance:{...p.allowance,points:[{at:'2026-10-15T12:00:00Z',remainingPercent:0}]}});
  const card=root.all().find(x=>x.dataset.workloadCard==='allowance');
  assert.doesNotMatch(card.textContent,/暂无可用额度观测/u);
  assert.equal(card.all().filter(x=>x.tagName==='circle').length,1);
});

test('both loads place a shared three-tier grade above their API-equivalent rate with distinct time units',()=>{
  const root=documentFixture();render(root,currentPayload());
  assert.equal(root.all().filter(x=>x.dataset.workloadCard).length,5);
  const current=root.all().find(x=>x.dataset.workloadCard==='current');
  const windows=current.all().filter(x=>x.dataset.workloadWindow);
  assert.deepEqual(windows.map(x=>x.dataset.workloadWindow),['shortTerm','trend']);
  assert.match(windows[0].textContent,/短期负载（15分钟）重度/);
  assert.match(windows[1].textContent,/额度消耗趋势（60分钟）中度额度换算等值 API 速率约 US\$4.2／小时/);
  assert.equal(windows[1].children[1].style.color,'var(--workload-medium)');
  assert.equal(windows[1].children[2].title,'1 点／小时');
  assert.equal(windows[0].children[0].children[0].tagName,'span');
  assert.equal(windows[1].children[0].children[0].tagName,'span');
  assert.match(windows[0].children[2].textContent,/等值 API 换算速率US\$4.2／小时/);
  assert.match(current.textContent,/按短期速率预计剩余时间15.7 小时/);
  assert.doesNotMatch(current.textContent,/66 小时/);
  const p=currentPayload();p.trend.inferred=true;render(root,p);
  assert.equal(root.all().find(x=>x.dataset.workloadWindow==='trend').children[2].children[1].textContent,'约 US$4.2／小时 *');
});

test('v9 sanitizes each recent window and never relabels old or stale grades',()=>{
  const p=currentPayload();p.current.secret='never-project';
  assert.doesNotMatch(JSON.stringify(normalizeOverviewWorkload(p)),/never-project/);
  for(const patch of [{status:'stale'},{status:'unavailable'},
    {schemaVersion:'overview-workload-v5'},{schemaVersion:'overview-workload-v6'},{schemaVersion:'overview-workload-v7'},{schemaVersion:'overview-workload-v8'},{current:{...p.current,windowMinutes:5}}]){
    const v=normalizeOverviewWorkload({...p,...patch});
    assert.equal(v.current.state,'unknown');assert.equal(v.current.level,null);assert.equal(v.current.ratePpPerHour,null);
  }
  const old=normalizeOverviewWorkload({...p,schemaVersion:'overview-workload-v5'});
  assert.equal(old.status,'stale');assert.equal(old.trend.ratePpPerHour,null);
  const partial=normalizeOverviewWorkload({...p,status:'partial',trend:{windowMinutes:60,state:'unknown',level:'heavy',hours:8}});
  assert.equal(partial.current.level,'heavy');assert.equal(partial.trend.ratePpPerHour,null);
  assert.ok(!Object.hasOwn(partial.trend,'hours'));assert.equal(partial.trend.level,null);
  assert.equal(normalizeOverviewWorkload({...p,current:{...p.current,hours:Infinity}}).current.hours,null);
});

test('missing recent values show only dashes while concrete errors remain visible',()=>{
  const root=documentFixture(),p=currentPayload();p.current.level='unclassified';p.current.usdPerHour=null;p.current.ratePpPerHour=null;
  p.trend={windowMinutes:60,state:'unknown'};p.errors=[{code:'quota_history_read_failed',stage:'quota'},{code:'price_missing',stage:'pricing'}];render(root,p);
  const windows=root.all().filter(x=>x.dataset.workloadWindow);
  for(const w of windows){assert.equal(w.children[1].textContent,'-');assert.ok(w.all().every(x=>!x.style.color));}
  assert.doesNotMatch(root.textContent,/数据不足|无负载|尚未观测/);
  assert.match(root.textContent,/quota_history_read_failed/);assert.match(root.textContent,/price_missing/);
  for(const locale of ['en-US','zh-Hans','es'])for(const key of ['workload.shortTerm','workload.trend','workload.windowMinutes','workload.quotaRateValue'])
    assert.notEqual(translate(key,{minutes:15,value:2},locale),key);
});

test('unclassified API intensity retains observed values including zero without an invented grade',()=>{
  const root=documentFixture(),p=currentPayload();p.current.level='unclassified';p.current.hours=null;
  for(const value of [0,2.5]){
    p.current.usdPerHour=value;render(root,p);
    const current=root.all().find(x=>x.dataset.workloadCard==='current');
    const main=current.all().find(x=>x.dataset.workloadWindow==='shortTerm').children[1];
    assert.equal(main.textContent,'-');assert.ok(!main.style.color);
    assert.equal(current.all().find(x=>x.dataset.workloadWindow==='shortTerm').children[2].children[1].textContent,`US$${value}／小时`);
    assert.doesNotMatch(current.textContent,/数据不足|未分类/);
  }
  assert.match(root.all().find(x=>x.dataset.workloadCard==='hours').textContent,/当前套餐时段/);
});

test('quota trend refuses invalid coverage and stale values without hiding specific failures',()=>{
  const p=currentPayload();p.errors=[{code:'quota_observation_conflict',stage:'quota'}];
  const root=documentFixture();
  for(const patch of [{windowMinutes:15},{ratePpPerHour:0},{ratePpPerHour:Infinity},
    {observedFrom:'2026-10-15T10:59:59Z'},{observedThrough:'2026-10-15T12:00:01Z'},
    {observedFrom:p.trend.observedThrough},{coveredMinutes:60}]){
    render(root,{...p,trend:{...p.trend,...patch}});
    assert.equal(root.all().find(x=>x.dataset.workloadWindow==='trend').children[1].textContent,'-');
    assert.match(root.textContent,/quota_observation_conflict/);
  }
});

test('all three grades share colours while missing conversion preserves raw quota rate below an unknown grade',()=>{
  const root=documentFixture(),p=currentPayload();
  for(const level of ['light','medium','heavy']){
    p.current.level=level;p.trend.level=level;render(root,p);
    for(const section of root.all().filter(x=>x.dataset.workloadWindow))
      assert.equal(section.children[1].style.color,`var(--workload-${level})`);
  }
  for(const usdPerHour of [null,0,-1,Infinity]){
    render(root,{...p,trend:{...p.trend,usdPerHour}});
    const trend=root.all().find(x=>x.dataset.workloadWindow==='trend');
    assert.equal(trend.children[1].textContent,'-');assert.ok(!trend.children[1].style.color);
    assert.equal(trend.children[2].textContent,'实际额度消耗速率1 点／小时');
  }
  p.trend.level='unclassified';render(root,p);
  const trend=root.all().find(x=>x.dataset.workloadWindow==='trend');
  assert.equal(trend.children[1].textContent,'-');assert.match(trend.children[2].textContent,/约 US\$4.2／小时/);
});
test("overview SVG and inline colours follow the document theme without rerendering evidence",()=>{
  const root=documentFixture(),p=payload();
  p.allowance.points=[{at:"2026-10-15T11:00:00Z",remainingPercent:70},{at:"2026-10-15T12:00:00Z",remainingPercent:66}];
  render(root,p);
  const nodes=root.all();
  const paints=nodes.flatMap(n=>[n.attrs.fill,n.attrs.stroke,n.style.backgroundColor,n.style.color]).filter(Boolean);
  assert.ok(paints.includes("var(--neutral-ink)"));
  assert.ok(paints.includes("var(--neutral-muted)"));
  assert.ok(paints.includes("var(--neutral-line)"));
  for(const paint of paints) assert.match(paint,/^(?:none|var\(--(?:neutral|workload)-[a-z]+\))$/u);
  for(const level of ["heavy","medium","light"]) assert.ok(paints.includes(`var(--workload-${level})`));
});
test("approved overview contains exactly five cards and common-scale hour bars",()=>{
  const root=documentFixture();render(root,payload());
  assert.equal(root.all().filter(x=>x.dataset.workloadCard).length,5);
  assert.ok(root.textContent.includes("当前66%"));
  const rows=root.all().filter(x=>x.dataset.level);
  assert.deepEqual(rows.map(x=>x.dataset.level),["heavy","medium","light","composite"]);
  assert.equal(rows[0].children[1].children[0].style.width,`${100*22/132}%`);
  assert.equal(rows[2].children[1].children[0].style.width,"100%");
  const daily=root.all().find(x=>x.dataset.workloadCard==="daily");
  assert.equal(daily.all().filter(x=>x.tagName==="rect").length,3);
  assert.ok(daily.all().filter(x=>x.tagName==="rect").every(x=>x.attrs["shape-rendering"]==="crispEdges"));
  assert.doesNotMatch(root.textContent,/包含今天|换算说明|模型运行|本段累计/u);
});
test("startup comparison has two common-scale cylinders, explicit zero and missing values",()=>{
  const root=documentFixture(),p=payload();p.comparison.startedAtMs=new Date(2026,9,23,3,34).getTime();render(root,p);
  const card=root.all().find(x=>x.dataset.workloadCard==="comparison");
  assert.equal(card.children[0].tagName,'h3');
  assert.equal(card.children[0].children[0].tagName,'small');
  assert.equal(card.children[0].children[0].textContent,'自10/23 03:34');
  assert.doesNotMatch(card.textContent,/启动后累计/);assert.ok(card.textContent.includes("实际消耗"));assert.ok(card.textContent.includes("预期消耗"));
  assert.equal(card.all().filter(x=>x.tagName==="polyline").length,0);
  const bars=card.all().filter(x=>x.tagName==="rect");assert.equal(bars.length,2);
  assert.equal(Number(bars[0].attrs.height),2*Number(bars[1].attrs.height));
  p.comparison.actualPp=0;p.comparison.expectedPp=null;render(root,p);
  const sparse=root.all().find(x=>x.dataset.workloadCard==="comparison");
  assert.ok(sparse.textContent.includes("0 百分点"));assert.ok(sparse.textContent.includes("—"));
  assert.equal(sparse.all().filter(x=>x.tagName==="rect").length,0);
  assert.equal(normalizeOverviewWorkload({...p,schemaVersion:"overview-workload-v1"}),null);
});
test("idle shows a dash, hides pace rows and retains historical hour rows",()=>{
  const root=documentFixture(),p={...payload(),schemaVersion:'overview-workload-v9',
    unallocated:{totalIntervals:0,plans:[],records:[],truncated:false},
    current:{windowMinutes:15,state:'idle'},trend:{windowMinutes:60,state:'unknown'}};render(root,p);
  const current=root.all().find(x=>x.dataset.workloadCard==="current");
  assert.equal(current.all().filter(x=>x.dataset.workloadWindow)[0].children[1].textContent,'-');
  assert.doesNotMatch(current.textContent,/无负载|数据不足|US\$/);
  assert.equal(root.all().filter(x=>x.dataset.level).length,4);
});

test('startup comparison discloses inherited plan attribution and projects only its boolean marker',()=>{
  const root=documentFixture(),p=currentPayload();
  p.comparison={...p.comparison,inferred:true,accountKey:'never-render'};
  const normalized=normalizeOverviewWorkload(p);
  assert.equal(normalized.comparison.inferred,true);assert.doesNotMatch(JSON.stringify(normalized),/never-render/);
  render(root,p);
  const card=root.all().find(x=>x.dataset.workloadCard==='comparison');
  assert.match(card.textContent,/含按套餐时段推定的归属/);
  for(const inferred of [undefined,false,'true']){
    p.comparison.inferred=inferred;render(root,p);
    assert.doesNotMatch(root.all().find(x=>x.dataset.workloadCard==='comparison').textContent,/含按套餐时段推定/);
  }
});

test('pricing diagnostics stay below every card, disclose real fields, paginate and retain state on refresh',()=>{
 const root=documentFixture(),p=payload();p.status='partial';p.errors=[{code:'price_missing',stage:'pricing'}];
 p.pricingDetails={total:11,records:Array.from({length:11},(_,i)=>({at:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),model:'unknown',reason:'model_unknown',tokens:100+i,inputUncached:20,cacheRead:70,output:10})),capture:{status:'available'}};
 render(root,p);let details=root.children.at(-1);assert.equal(details.tagName,'details');assert.equal(root.children[0].className,'workload-grid');
 assert.match(details.children[0].textContent,/11 条用量未计价/u);assert.match(details.textContent,/缺少可确认的请求模型/u);
 assert.doesNotMatch(details.textContent,/计价暂不可用|synthetic-response|private-path/u);
 details.open=true;details.listeners.toggle();const next=details.all().find(n=>n.dataset.workloadDiagnosticFocus==='next');next.focus();next.listeners.click();
 assert.match(details.textContent,/2 \/ 2/u);render(root,p);details=root.children.at(-1);assert.equal(details.open,true);assert.match(details.textContent,/2 \/ 2/u);
 assert.equal(details.all().filter(n=>n.tagName==='tbody').flatMap(n=>n.children).length,1);
});

test('runtime evidence checkpoints describe recorded coverage rather than active work',()=>{
  for(const [status,expected] of [['pending','尚无检查记录'],['catching_up','尚有记录未处理']]){
    const root=documentFixture(),p=currentPayload();
    p.errors=[{code:'price_missing',stage:'pricing'}];
    p.pricingDetails={total:0,records:[],capture:{status,checkedAt:p.generatedAt}};
    render(root,p);
    assert.match(root.textContent,new RegExp(expected,'u'));
    assert.doesNotMatch(root.textContent,/正在补采|等待本地索引/u);
  }
});

test('pricing detail normalization drops arbitrary fields and retains missing numeric values',()=>{
 const p=payload();p.pricingDetails={total:1,records:[{at:p.generatedAt,model:'<script>private</script>',reason:'private text',tokens:null,cacheRead:NaN,path:'private-path'}],capture:{status:'invented'}};
 const out=normalizeOverviewWorkload(p).pricingDetails;assert.equal(out.records[0].tokens,null);assert.equal(out.records[0].cacheRead,null);
 assert.equal(out.records[0].model,'unknown');assert.equal(out.capture.status,'pending');assert.doesNotMatch(JSON.stringify(out),/private|script/u);
});

test("v3 partial comparison keeps cylinders and error details without the removed coverage paragraph",()=>{
  const root=documentFixture(),p=payload();p.schemaVersion="overview-workload-v3";
  p.comparison.coverage="partial";p.status="partial";p.errors=[{code:"comparison_reset_gap",stage:"quota"}];
  render(root,p);
  const card=root.all().find(x=>x.dataset.workloadCard==="comparison");
  assert.equal(card.all().filter(x=>x.tagName==="rect").length,2);
  assert.doesNotMatch(card.textContent,/仅显示已确认的累计|部分区间尚未计入/);assert.ok(root.textContent.includes("comparison_reset_gap"));
  assert.ok(card.textContent.includes("2 百分点"));
  assert.equal(normalizeOverviewWorkload({...p,schemaVersion:"overview-workload-v6"}),null);
});

test('v4 plan groups retain inferred labels, separate same-day plans and qualify estimated hours',()=>{
  const root=documentFixture(),p=payload();p.schemaVersion='overview-workload-v4';
  p.planAttribution={estimationPlanType:'pro',inferredObservations:2,secret:'never-render'};
  p.workHours=p.workHours.map(x=>({...x,inferred:true}));
  p.daily[0].inferred=true;p.daily[0].plans=[
    {planType:'prolite',covered:true,inferred:true,heavy:4,medium:0,light:0,unclassified:0},
    {planType:'pro',covered:true,inferred:false,heavy:1,medium:0,light:0,unclassified:0}];
  const n=normalizeOverviewWorkload(p);assert.doesNotMatch(JSON.stringify(n),/never-render/);render(root,p);
  const daily=root.all().find(x=>x.dataset.workloadCard==='daily'),hours=root.all().find(x=>x.dataset.workloadCard==='hours');
  assert.match(hours.textContent,/预计剩余工时|当前套餐时段/);assert.match(hours.textContent,/Pro/);assert.doesNotMatch(hours.textContent,/10×/);
  assert.match(hours.textContent,/\*/);assert.match(daily.textContent,/100\*/);assert.match(daily.textContent,/Pro 200/);assert.doesNotMatch(daily.textContent,/\d+×/);
  assert.doesNotMatch(hours.textContent,/含按套餐时段推定/);
  assert.equal(daily.all().filter(x=>x.tagName==='p').length,0);const bars=daily.all().filter(x=>x.tagName==='rect');
  assert.equal(bars.length,2);assert.notEqual(bars[0].attrs.x,bars[1].attrs.x);
  assert.equal(Number(bars[0].attrs.height),4*Number(bars[1].attrs.height));
  p.workHours=[];render(root,p);
  const emptyHours=root.all().find(x=>x.dataset.workloadCard==='hours');
  assert.ok(emptyHours.textContent.includes(translate('workload.estimateUnavailable',{},'zh-Hans')));
  assert.doesNotMatch(emptyHours.textContent,/正在采集|采集中/u);
  p.daily[0].plans[0].planType='<script>secret';
  assert.equal(normalizeOverviewWorkload(p).daily[0].plans[0].planType,'unknown');
  for(const locale of['en-US','zh-Hans','es'])for(const key of['workload.inferred','workload.planGroups','workload.estimateScope','workload.estimateUnavailable'])
    assert.notEqual(translate(key,{plan:'synthetic'},locale),key);
});
test("stale results keep timestamp and classified errors visible",()=>{
  const root=documentFixture(),p=payload();p.status="stale";p.errors=[{stage:"index",code:"source_unreadable",private:"never display"}];render(root,p);
  assert.ok(root.textContent.includes("source_unreadable"));assert.ok(root.textContent.includes("保留"));assert.ok(!root.textContent.includes("never display"));
  const summary=root.all().find(x=>x.dataset.workloadDiagnosticFocus==='summary');
  assert.equal(summary.textContent,`${translate('workload.error.index',{},'zh-Hans')} · ${translate('workload.diagnostics.view',{},'zh-Hans')}`);
  assert.doesNotMatch(summary.textContent,/更新失败|采集失败/u);
});
test("old schema with no classified error describes retained results without claiming failure",()=>{
  const root=documentFixture(),p={...currentPayload(),schemaVersion:'overview-workload-v8',errors:[]};
  const normalized=normalizeOverviewWorkload(p);
  assert.equal(normalized.status,'stale');
  render(root,p);
  const summary=root.all().find(x=>x.dataset.workloadDiagnosticFocus==='summary');
  assert.equal(summary.textContent,translate('workload.diagnostics.retained',{},'zh-Hans'));
  assert.doesNotMatch(summary.textContent,/更新失败|失败/u);
  assert.doesNotMatch(root.textContent,/更新失败/u);
});
test("non-finite hour values remain unavailable and every locale has the new labels",()=>{
  const p=payload();p.workHours[0].hours=Infinity;assert.equal(normalizeOverviewWorkload(p).workHours[0].hours,null);
  for(const locale of["en-US","zh-Hans","es"])for(const key of["workload.title.hours","workload.title.comparison","workload.idle"])
    assert.notEqual(translate(key,{},locale),key);
});

const unallocated=(count=1)=>({totalIntervals:count,plans:[{planType:'pro',pp:count,intervals:count}],
  records:Array.from({length:Math.min(20,count)},()=>({from:'2026-10-14T23:00:00Z',to:'2026-10-15T01:00:00Z',
    planType:'pro',pp:1,reason:'price_missing',inferred:true,secret:'never-project'})),truncated:count>20});

test('v5 unallocated summary is last, compact, collapsible and focus-stable through refresh',()=>{
  const root=documentFixture(),p={...payload(),schemaVersion:'overview-workload-v5',unallocated:unallocated(21)};
  p.errors=[{code:'price_missing',stage:'pricing'}];p.pricingDetails={total:1,records:[]};
  const normalized=normalizeOverviewWorkload(p);assert.doesNotMatch(JSON.stringify(normalized),/never-project/);
  render(root,p);let footer=root.children.at(-1);
  assert.equal(footer.tagName,'details');assert.match(footer.className,/workload-unallocated/);
  assert.match(footer.children[0].textContent,/跨天未分配.*21 百分点.*21 个区间/);
  assert.equal(footer.open,false);assert.match(footer.textContent,/20 \/ 21/);
  assert.equal(root.children[0].className,'workload-grid');assert.equal(root.children.at(-2).tagName,'details');
  footer.open=true;footer.listeners.toggle();footer.children[0].focus();render(root,p);footer=root.children.at(-1);
  assert.equal(footer.open,true);assert.equal(root.ownerDocument.activeElement,footer.children[0]);
  p.unallocated={totalIntervals:0,plans:[],records:[],truncated:false};render(root,p);
  assert.ok(!root.all().some(n=>n.className?.includes('workload-unallocated')));
});

test('v5 refuses malformed unallocated totals, timestamps and reasons, and old caches remain visibly stale',()=>{
  const p={...payload(),schemaVersion:'overview-workload-v5',unallocated:unallocated()};
  assert.equal(normalizeOverviewWorkload(p).status,'stale');
  for(const bad of [{...unallocated(),totalIntervals:2},{...unallocated(),plans:[{planType:'pro',pp:2,intervals:1}]},
    {...unallocated(),records:[{...unallocated().records[0],reason:'private-error'}]},
    {...unallocated(),records:[{...unallocated().records[0],to:'invalid'}]},
    {...unallocated(),plans:[{planType:'pro',pp:Infinity,intervals:1}]}])
    assert.equal(normalizeOverviewWorkload({...p,unallocated:bad}),null);
  for(const version of ['overview-workload-v2','overview-workload-v3','overview-workload-v4']){
    const old=normalizeOverviewWorkload({...p,schemaVersion:version});assert.equal(old.status,'stale');assert.equal(old.unallocated,null);
  }
  for(const locale of ['en-US','zh-Hans','es'])for(const key of ['workload.unallocated.title','workload.unallocated.group',
    'workload.unallocated.history_incomplete','workload.unallocated.price_missing','workload.unallocated.usage_missing','workload.unallocated.limited'])
    assert.notEqual(translate(key,{},locale),key);
});
