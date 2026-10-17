import test from 'node:test';
import assert from 'node:assert/strict';
import {mountWeeklyApiChart} from '../public/weekly-api-chart.js';
import {translate,SUPPORTED_LOCALES} from '../public/localization.js';
import {normalizeWeeklyApiIntervals} from '../public/weekly-api-intervals.js';

class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes=new Map();this.style={};this.dataset={};this.listeners={};this.clientWidth=900;this.value='';this.textContent='';this.isConnected=true;}
 append(...values){this.children.push(...values);}
 replaceChildren(...values){this.children=[...values];}
 setAttribute(k,v){this.attributes.set(k,String(v));}
 getAttribute(k){return this.attributes.get(k)??null;}
 addEventListener(k,f){this.listeners[k]=f;}
 querySelector(tag){return this.children.find(e=>e.tagName===tag)??null;}
 getBoundingClientRect(){return {left:0,width:900};}
}
function fixture(){
 const storage=new Map(),events=[];
 const documentRef={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),
  documentElement:{lang:'en-US'},defaultView:{addEventListener:(type,fn)=>events.push([type,fn]),
   localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)}}};
 const calls=[];const chart=mountWeeklyApiChart({documentRef,t:(key,values)=>translate(key,values,'en-US'),
  formatMoney:n=>String(n),formatInstant:n=>new Date(n).toISOString(),onDetails:()=>calls.push('details'),onRetry:()=>calls.push('retry')});
 const find=(id,e=chart.root)=>e.id===id?e:e.children.map(c=>typeof c==='object'?find(id,c):null).find(Boolean);
 return {chart,find,storage,events,calls};
}
const start=Date.parse('2026-10-10T00:00:00.000Z'),hour=3_600_000;
const rows=[{startMs:start,endMs:start+hour,weeklyUsd:100,segment:1,reason:null},
 {startMs:start+hour,endMs:start+3*hour,weeklyUsd:200,segment:1,reason:null},
 {startMs:start+3*hour,endMs:start+4*hour,weeklyUsd:null,segment:2,reason:'awaiting_change'}];
const data=(extra={})=>({period:'24h',planType:'plus',projection:{status:'available',rows},
 generatedAt:new Date(start+4*hour).toISOString(),startMs:start,endMs:start+4*hour,...extra});
test('chart publishes latest valid time, exact pixel-aligned selection and explicit gaps without a timer',()=>{
 const {chart,find,events,calls}=fixture();chart.update(data());
 assert.equal(chart.reading().sigma,30);assert.ok(chart.reading().selected<rows[2].startMs);
 const time=find('weekly-api-time');time.value='979167';time.oninput();
 assert.ok(Math.abs(chart.reading().selected-(start+3.5*hour))<100);
 const svg=chart.root.children.at(-1).children[0],guide=svg.children.at(-1);
 assert.ok(Math.abs(Number(guide.getAttribute('x1'))-(62+.979167*(900-76)))<.001);
 assert.equal(chart.root.children[1].children[0].textContent,'—');
 assert.deepEqual(events.map(e=>e[0]),['resize']);find('weekly-api-details').onclick();assert.deepEqual(calls,['details']);
});
test('sigma is display-only, remembered by period, and explicit off survives switching and refresh',()=>{
 const {chart,find,storage}=fixture();chart.update(data());const sigma=find('weekly-api-sigma');
 sigma.value='0';sigma.onchange();assert.equal(chart.reading().sigma,0);
 chart.update(data({period:'7d'}));assert.equal(chart.reading().sigma,60);
 sigma.value='240';sigma.onchange();chart.update(data());assert.equal(chart.reading().sigma,0);
 assert.match(storage.get('tibotattle.weekly-api-sigma'),/"24h":0/);
 chart.update(data({projection:{status:'available',rows:[...rows]},generatedAt:new Date(start+5*hour).toISOString(),endMs:start+5*hour}));
 assert.equal(chart.reading().sigma,0);
});
test('regressed responses preserve previous plot; invalid smoothing and unavailable data stay visible',()=>{
 const {chart,find}=fixture();chart.update(data());const canvas=chart.root.children.at(-1),svg=canvas.children[0];
 const before=svg.children;chart.update(data({generatedAt:new Date(start).toISOString()}));
 assert.equal(chart.reading().failure,'weekly_api_report_regressed');assert.equal(svg.children,before);
 chart.update(data({projection:{status:'unavailable',reason:'weekly_api_source_mismatch',rows:[]}}));
 const sigma=find('weekly-api-sigma');sigma.value='15';sigma.onchange();
 assert.equal(chart.reading().failure,'weekly_api_source_mismatch');
 chart.update(data({projection:{status:'available',rows:[rows[0],{...rows[1],startMs:start+1}]}}));
 assert.equal(chart.reading().failure,'weekly_api_smoothing_invalid');
});
test('the closed browser contract rejects malformed evidence and every new status is translated',()=>{
 assert.equal(normalizeWeeklyApiIntervals(undefined).reason,'weekly_api_intervals_unavailable');
 assert.equal(normalizeWeeklyApiIntervals({rows:[],privatePath:'synthetic'}).reason,'weekly_api_validation_failed');
 for(const locale of SUPPORTED_LOCALES)for(const name of ['title','details','off','smoothing','reason.review_origin_unresolved',
  'failure.smoothing','failure.validation','failure.stale','failure.resource','failure.pending','failure.projection']){
  const key=`allowance.interval.${name}`;assert.notEqual(translate(key,{code:'synthetic',value:30},locale),key);
 }
});
