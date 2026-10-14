const COLORS = {heavy:"#dc2626",medium:"#eab308",light:"#16a34a",composite:"#111",unclassified:"#888"};
const LEVELS=["heavy","medium","light","composite"];
const finite=(v)=>typeof v==="number"&&Number.isFinite(v);
const instant=(v)=>typeof v==="string"&&Number.isFinite(Date.parse(v));
// Closed projection: never spread companion records into DOM-facing state.
export function normalizeOverviewWorkload(value) {
  if(!value||value.schemaVersion!=="overview-workload-v1")return null;
  const scalar=(x)=>finite(x)&&x>=0?x:null;
  const rows=(x)=>Array.isArray(x)?x:[];
  return {schemaVersion:value.schemaVersion,status:["available","partial","stale","unavailable"].includes(value.status)?value.status:"unavailable",
    generatedAt:instant(value.generatedAt)?value.generatedAt:null,
    errors:rows(value.errors).slice(0,20).filter((x)=>/^[a-z][a-z0-9_]{0,79}$/u.test(x?.code??"")).map((x)=>({code:x.code,
      stage:["work","quota","pricing","index","aggregation","publish"].includes(x.stage)?x.stage:"index"})),
    allowance:{remainingPercent:scalar(value.allowance?.remainingPercent),observedAt:instant(value.allowance?.observedAt)?value.allowance.observedAt:null,
      points:rows(value.allowance?.points).filter(x=>instant(x?.at)).map(x=>({at:x.at,remainingPercent:scalar(x.remainingPercent),breakBefore:x.breakBefore===true}))},
    workHours:LEVELS.map(level=>{const x=rows(value.workHours).find(x=>x.level===level);return {level,hours:scalar(x?.hours)};}),
    daily:rows(value.daily).slice(-7).filter(x=>/^\d{4}-\d{2}-\d{2}$/u.test(x?.date??"")).map(x=>({date:x.date,covered:x.covered===true,
      ...Object.fromEntries(["heavy","medium","light","unclassified"].map(k=>[k,scalar(x[k])]))})),
    current:{state:["working","idle","unknown"].includes(value.current?.state)?value.current.state:"unknown",
      level:["heavy","medium","light","unclassified"].includes(value.current?.level)?value.current.level:null,
      hours:scalar(value.current?.hours),ratePpPerHour:scalar(value.current?.ratePpPerHour)},
    comparison:{points:rows(value.comparison?.points).filter(x=>instant(x?.at)).map(x=>({at:x.at,value:finite(x.value)?x.value:null}))}};
}

export function renderOverviewWorkload(root,data,{translate:t,locale="en-US"}={}) {
  const doc=root.ownerDocument;
  const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const num=(x,digits=1)=>finite(x)?new Intl.NumberFormat(locale,{maximumFractionDigits:digits}).format(x):"—";
  const hour=(x)=>finite(x)?t("workload.hours",{value:num(x)}):"—";
  const svgNode=(name,attrs={})=>{const el=doc.createElementNS("http://www.w3.org/2000/svg",name);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,String(v));return el;};
  const time=(at)=>new Intl.DateTimeFormat(locale,{hour:"2-digit",minute:"2-digit"}).format(new Date(at));
  const card=(key)=>{const c=node("article","workload-card");c.dataset.workloadCard=key;c.append(node("h3","",t(`workload.title.${key}`)));return c;};
  function lineChart(points,key,valueKey,range=null){
    const svg=svgNode("svg",{viewBox:"0 0 640 210",role:"img","aria-label":t(`workload.title.${key}`)});
    const valid=points.filter(p=>finite(p[valueKey]));
    if(!valid.length){const label=svgNode("text",{x:320,y:100,"text-anchor":"middle"});label.textContent=t("workload.collecting");svg.append(label);return svg;}
    const times=points.map(p=>Date.parse(p.at)),lo=Math.min(...times),hi=Math.max(lo+1,...times);
    const values=valid.map(p=>p[valueKey]);
    let min=range?.[0]??Math.min(0,...values),max=range?.[1]??Math.max(0,...values);
    if(max===min)max=min+1;
    const x=(v)=>46+(Date.parse(v.at)-lo)/(hi-lo)*576;
    const y=(v)=>174-(v-min)/(max-min)*154;
    for(let i=0;i<=4;i++){const val=min+(max-min)*i/4,yy=y(val);svg.append(svgNode("line",{x1:46,x2:622,y1:yy,y2:yy,stroke:"#ddd"}));
      const label=svgNode("text",{x:38,y:yy+4,"text-anchor":"end"});label.textContent=`${num(val)}%`;svg.append(label);}
    let segment=[];
    const flush=()=>{if(segment.length)svg.append(svgNode("polyline",{points:segment.join(" "),stroke:"#111","stroke-width":2.5,fill:"none"}));segment=[];};
    for(const p of points){if(p.breakBefore||!finite(p[valueKey]))flush();if(!finite(p[valueKey]))continue;
      segment.push(`${x(p)},${y(p[valueKey])}`);
      const dot=svgNode("circle",{cx:x(p),cy:y(p[valueKey]),r:3,fill:"#111"});
      const title=svgNode("title");title.textContent=`${new Date(p.at).toLocaleString(locale)} · ${num(p[valueKey])}%`;dot.append(title);svg.append(dot);}
    flush();
    for(const [at,xx,anchor]of[[points[0].at,46,"start"],[points.at(-1).at,622,"end"]]){
      const label=svgNode("text",{x:xx,y:202,"text-anchor":anchor});label.textContent=key==="allowance"?new Date(at).toLocaleDateString(locale,{month:"numeric",day:"numeric"}):time(at);svg.append(label);}
    return svg;
  }
  root.replaceChildren();root.className="workload-overview";
  const w=data;
  if(w?.status==="stale"||w?.errors?.length){const alert=node("div","workload-alert");alert.setAttribute("role","alert");
    if(w.status==="stale")alert.append(node("p","",t("workload.stale",{time:w.generatedAt?new Date(w.generatedAt).toLocaleString(locale):"—"})));
    for(const e of w.errors)alert.append(node("p","",`${t(`workload.error.${e.stage}`)} · ${e.code}`));root.append(alert);}
  const grid=node("div","workload-grid");root.append(grid);
  const allowance=card("allowance"),value=node("div","workload-remaining");value.append(node("span","",t("workload.current")),node("strong","",w?.allowance?.remainingPercent===null||!w?"—":`${num(w.allowance.remainingPercent)}%`));
  allowance.append(value,lineChart(w?.allowance?.points??[],"allowance","remainingPercent",[0,100]));grid.append(allowance);
  const workHours=card("hours"),maxHours=Math.max(0,...(w?.workHours??[]).map(x=>x.hours??0));
  for(const level of LEVELS){const val=w?.workHours?.find(x=>x.level===level)?.hours??null;
    const row=node("div",`workload-hours-row ${level==="composite"?"is-composite":""}`);row.dataset.level=level;
    const track=node("div","workload-hour-track"),fill=node("i");fill.style.width=`${maxHours>0&&val!==null?100*val/maxHours:0}%`;fill.style.backgroundColor=COLORS[level];track.append(fill);
    row.append(node("span","",t(`workload.level.${level}`)),track,node("strong","",hour(val)));workHours.append(row);}
  grid.append(workHours);
  const daily=card("daily"),svg=svgNode("svg",{viewBox:"0 0 640 210",role:"img","aria-label":t("workload.title.daily")});
  const days=w?.daily??[],total=d=>["heavy","medium","light","unclassified"].reduce((s,k)=>s+(d[k]??0),0),max=Math.max(1,...days.map(total));
  for(let i=0;i<=4;i++){const yy=174-i*154/4;svg.append(svgNode("line",{x1:46,x2:622,y1:yy,y2:yy,stroke:"#ddd"}));const label=svgNode("text",{x:38,y:yy+4,"text-anchor":"end"});label.textContent=num(max*i/4);svg.append(label);}
  const unit=svgNode("text",{x:46,y:12});unit.textContent=t("workload.points");svg.append(unit);
  days.forEach((d,i)=>{let top=174;const x=60+i*80;
    if(d.covered){for(const level of["light","medium","heavy","unclassified"]){const h=(d[level]??0)/max*154;if(h<=0)continue;
      const rect=svgNode("rect",{x,y:top-h,width:42,height:h,fill:COLORS[level],"shape-rendering":"crispEdges"});const title=svgNode("title");title.textContent=`${d.date} · ${t(`workload.level.${level}`)} ${num(d[level])} ${t("workload.points")}`;rect.append(title);svg.append(rect);top-=h;}}
    else{const missing=svgNode("text",{x:x+21,y:164,"text-anchor":"middle"});missing.textContent="—";svg.append(missing);}
    const label=svgNode("text",{x:x+21,y:202,"text-anchor":"middle"});label.textContent=d.date.slice(5);svg.append(label);});
  daily.append(svg);const legend=node("div","workload-legend");
  for(const level of["heavy","medium","light"]){const label=node("span"),dot=node("i");dot.style.backgroundColor=COLORS[level];label.append(dot,doc.createTextNode(t(`workload.level.${level}`)));legend.append(label);}daily.append(legend);grid.append(daily);
  const current=card("current"),c=w?.current;
  const label=c?.state==="idle"?t("workload.idle"):c?.state==="working"?t(`workload.level.${c.level??"unclassified"}`):t("workload.unknown");
  const main=node("strong","workload-current-value",label);if(c?.state==="working")main.style.color=COLORS[c.level]??"#111";current.append(main);
  if(c?.state==="working"){
    const rate=node("p","workload-current-rate");rate.append(node("span","",t("workload.rate")),node("strong","",finite(c.ratePpPerHour)?t("workload.rateValue",{value:num(c.ratePpPerHour)}):"—"));current.append(rate);
    const rest=node("p","workload-current-hours");rest.append(node("span","",t("workload.canWork")),node("strong","",hour(c.hours)));current.append(rest);}
  grid.append(current);
  const comparison=card("comparison");comparison.classList.add("workload-wide");comparison.append(lineChart(w?.comparison?.points??[],"comparison","value"));grid.append(comparison);
}
