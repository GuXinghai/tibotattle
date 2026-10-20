import test from "node:test";
import assert from "node:assert/strict";
import {normalizeOverviewWorkload,renderOverviewWorkload} from "../public/overview-workload.js";
import {translate} from "../public/localization.js";
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
  assert.doesNotMatch(root.textContent,/包含今天|换算说明|模型运行|最近 15 分钟|本段累计/u);
});
test("startup comparison has two common-scale cylinders, explicit zero and missing values",()=>{
  const root=documentFixture(),p=payload();render(root,p);
  const card=root.all().find(x=>x.dataset.workloadCard==="comparison");
  assert.ok(card.textContent.includes("启动后累计"));assert.ok(card.textContent.includes("实际消耗"));assert.ok(card.textContent.includes("预期消耗"));
  assert.equal(card.all().filter(x=>x.tagName==="polyline").length,0);
  const bars=card.all().filter(x=>x.tagName==="rect");assert.equal(bars.length,2);
  assert.equal(Number(bars[0].attrs.height),2*Number(bars[1].attrs.height));
  p.comparison.actualPp=0;p.comparison.expectedPp=null;render(root,p);
  const sparse=root.all().find(x=>x.dataset.workloadCard==="comparison");
  assert.ok(sparse.textContent.includes("0 百分点"));assert.ok(sparse.textContent.includes("—"));
  assert.equal(sparse.all().filter(x=>x.tagName==="rect").length,0);
  assert.equal(normalizeOverviewWorkload({...p,schemaVersion:"overview-workload-v1"}),null);
});
test("idle hides current rate and hours but retains historical hour rows",()=>{
  const root=documentFixture(),p=payload();p.current={state:"idle"};render(root,p);
  const current=root.all().find(x=>x.dataset.workloadCard==="current");
  assert.ok(current.textContent.includes("无负载"));assert.ok(!current.textContent.includes("当前速率"));
  assert.equal(root.all().filter(x=>x.dataset.level).length,4);
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

test('pricing detail normalization drops arbitrary fields and retains missing numeric values',()=>{
 const p=payload();p.pricingDetails={total:1,records:[{at:p.generatedAt,model:'<script>private</script>',reason:'private text',tokens:null,cacheRead:NaN,path:'private-path'}],capture:{status:'invented'}};
 const out=normalizeOverviewWorkload(p).pricingDetails;assert.equal(out.records[0].tokens,null);assert.equal(out.records[0].cacheRead,null);
 assert.equal(out.records[0].model,'unknown');assert.equal(out.capture.status,'pending');assert.doesNotMatch(JSON.stringify(out),/private|script/u);
});

test("v3 partial comparison keeps confirmed cylinders and visibly qualifies incomplete coverage",()=>{
  const root=documentFixture(),p=payload();p.schemaVersion="overview-workload-v3";
  p.comparison.coverage="partial";p.status="partial";p.errors=[{code:"comparison_reset_gap",stage:"quota"}];
  render(root,p);
  const card=root.all().find(x=>x.dataset.workloadCard==="comparison");
  assert.equal(card.all().filter(x=>x.tagName==="rect").length,2);
  assert.ok(card.textContent.includes("仅显示已确认的累计"));assert.ok(root.textContent.includes("comparison_reset_gap"));
  assert.ok(card.textContent.includes("2 百分点"));
  assert.equal(normalizeOverviewWorkload({...p,schemaVersion:"overview-workload-v5"}),null);
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
  assert.match(hours.textContent,/预计剩余工时|当前套餐时段/);assert.match(hours.textContent,/Pro 10×/);
  assert.match(hours.textContent,/\*/);assert.match(daily.textContent,/5×\*/);assert.match(daily.textContent,/10×/);
  assert.doesNotMatch(hours.textContent,/含按套餐时段推定/);
  assert.equal(daily.all().filter(x=>x.tagName==='p').length,0);const bars=daily.all().filter(x=>x.tagName==='rect');
  assert.equal(bars.length,2);assert.notEqual(bars[0].attrs.x,bars[1].attrs.x);
  assert.equal(Number(bars[0].attrs.height),4*Number(bars[1].attrs.height));
  p.workHours=[];render(root,p);assert.match(root.textContent,/正在采集当前套餐时段的样本/);
  p.daily[0].plans[0].planType='<script>secret';
  assert.equal(normalizeOverviewWorkload(p).daily[0].plans[0].planType,'unknown');
  for(const locale of['en-US','zh-Hans','es'])for(const key of['workload.inferred','workload.planGroups','workload.estimateScope','workload.estimateCollecting'])
    assert.notEqual(translate(key,{plan:'synthetic'},locale),key);
});
test("stale results keep timestamp and classified errors visible",()=>{
  const root=documentFixture(),p=payload();p.status="stale";p.errors=[{stage:"index",code:"source_unreadable",private:"never display"}];render(root,p);
  assert.ok(root.textContent.includes("source_unreadable"));assert.ok(root.textContent.includes("保留"));assert.ok(!root.textContent.includes("never display"));
});
test("non-finite hour values remain unavailable and every locale has the new labels",()=>{
  const p=payload();p.workHours[0].hours=Infinity;assert.equal(normalizeOverviewWorkload(p).workHours[0].hours,null);
  for(const locale of["en-US","zh-Hans","es"])for(const key of["workload.title.hours","workload.title.comparison","workload.idle"])
    assert.notEqual(translate(key,{},locale),key);
});
