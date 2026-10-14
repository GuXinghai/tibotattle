import test from "node:test";
import assert from "node:assert/strict";
import {normalizeOverviewWorkload,renderOverviewWorkload} from "../public/overview-workload.js";
import {translate} from "../public/localization.js";
function documentFixture(){const doc={};class Element{
  constructor(tag){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.dataset={};this.style={};this.attrs={};this.classList={add:(x)=>{this.className=(this.className??"")+" "+x;}};}
  append(...nodes){this.children.push(...nodes);}replaceChildren(){this.children=[];}setAttribute(k,v){this.attrs[k]=v;}
  set textContent(v){this.text=v;this.children=[];}get textContent(){return(this.text??"")+this.children.map(x=>x.textContent).join("");}
  all(){return this.children.flatMap(x=>[x,...x.all()]);}}
  doc.createElement=tag=>new Element(tag);doc.createElementNS=(_,tag)=>new Element(tag);doc.createTextNode=text=>{const n=new Element("text-node");n.textContent=text;return n;};
  return new Element("div");}
const payload=()=>({schemaVersion:"overview-workload-v1",status:"available",generatedAt:"2026-10-15T12:00:00.000Z",errors:[],
  allowance:{remainingPercent:66,points:[]},workHours:[{level:"heavy",hours:22},{level:"medium",hours:44},{level:"light",hours:132},{level:"composite",hours:38.6}],
  daily:[{date:"2026-10-15",covered:true,heavy:2,medium:1,light:1,unclassified:0}],
  current:{state:"working",level:"heavy",ratePpPerHour:4.2,hours:15.7},comparison:{points:[]}});
const render=(root,value)=>renderOverviewWorkload(root,normalizeOverviewWorkload(value),{translate:(key,values)=>translate(key,values,"zh-Hans"),locale:"zh-CN"});
test("approved overview contains exactly five cards and common-scale hour bars",()=>{
  const root=documentFixture();render(root,payload());
  assert.equal(root.all().filter(x=>x.dataset.workloadCard).length,5);
  assert.ok(root.textContent.includes("当前66%"));
  const rows=root.all().filter(x=>x.dataset.level);
  assert.deepEqual(rows.map(x=>x.dataset.level),["heavy","medium","light","composite"]);
  assert.equal(rows[0].children[1].children[0].style.width,`${100*22/132}%`);
  assert.equal(rows[2].children[1].children[0].style.width,"100%");
  assert.equal(root.all().filter(x=>x.tagName==="rect").length,3);
  assert.ok(root.all().filter(x=>x.tagName==="rect").every(x=>x.attrs["shape-rendering"]==="crispEdges"));
  assert.doesNotMatch(root.textContent,/包含今天|换算说明|模型运行|最近 15 分钟|本段累计/u);
});
test("idle hides current rate and hours but retains historical hour rows",()=>{
  const root=documentFixture(),p=payload();p.current={state:"idle"};render(root,p);
  const current=root.all().find(x=>x.dataset.workloadCard==="current");
  assert.ok(current.textContent.includes("无负载"));assert.ok(!current.textContent.includes("当前速率"));
  assert.equal(root.all().filter(x=>x.dataset.level).length,4);
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
