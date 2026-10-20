const COLORS = {heavy:"var(--workload-heavy)",medium:"var(--workload-medium)",light:"var(--workload-light)",composite:"var(--neutral-ink)",unclassified:"var(--neutral-muted)"};
const LEVELS=["heavy","medium","light","composite"];
const PLAN_LABELS={free:'Free',go:'Go',plus:'Plus',pro:'Pro 10×',prolite:'Pro 5×',promax:'Pro Max 25×',team:'Team',business:'Business',enterprise:'Enterprise',edu:'Edu'};
const finite=(v)=>typeof v==="number"&&Number.isFinite(v);
const instant=(v)=>typeof v==="string"&&Number.isFinite(Date.parse(v));
const views=new WeakMap();
// Closed projection: never spread companion records into DOM-facing state.
export function normalizeOverviewWorkload(value) {
  if(!value||!["overview-workload-v2","overview-workload-v3","overview-workload-v4"].includes(value.schemaVersion))return null;
  const scalar=(x)=>finite(x)&&x>=0?x:null;
  const rows=(x)=>Array.isArray(x)?x:[];
  const plan=(x)=>Object.hasOwn(PLAN_LABELS,x)?x:'unknown';
  const levels=x=>Object.fromEntries(["heavy","medium","light","unclassified"].map(k=>[k,scalar(x[k])]));
  return {schemaVersion:value.schemaVersion,status:["available","partial","stale","unavailable"].includes(value.status)?value.status:"unavailable",
    generatedAt:instant(value.generatedAt)?value.generatedAt:null,
    pricingDetails:{total:Number.isSafeInteger(value.pricingDetails?.total)&&value.pricingDetails.total>=0?value.pricingDetails.total:0,
      truncated:value.pricingDetails?.truncated===true,
      capture:{status:['pending','available','catching_up','unavailable','partial','failed'].includes(value.pricingDetails?.capture?.status)?value.pricingDetails.capture.status:'pending',
        checkedAt:instant(value.pricingDetails?.capture?.checkedAt)?value.pricingDetails.capture.checkedAt:null,
        coverageGap:value.pricingDetails?.capture?.coverageGap===true},
      records:rows(value.pricingDetails?.records).slice(0,2000).filter(x=>instant(x?.at)).map(x=>({at:x.at,
        model:/^gpt-[0-9][a-zA-Z0-9_.-]{0,95}$/u.test(x.model??'')?x.model:'unknown',
        reason:['model_unknown','price_incomplete'].includes(x.reason)?x.reason:'price_incomplete',
        tokens:scalar(x.tokens),inputUncached:scalar(x.inputUncached),cacheRead:scalar(x.cacheRead),output:scalar(x.output)}))},
    errors:rows(value.errors).slice(0,20).filter((x)=>/^[a-z][a-z0-9_]{0,79}$/u.test(x?.code??"")).map((x)=>({code:x.code,
      stage:["work","quota","pricing","index","aggregation","publish"].includes(x.stage)?x.stage:"index"})),
    allowance:{remainingPercent:scalar(value.allowance?.remainingPercent),observedAt:instant(value.allowance?.observedAt)?value.allowance.observedAt:null,
      points:rows(value.allowance?.points).filter(x=>instant(x?.at)).map(x=>({at:x.at,remainingPercent:scalar(x.remainingPercent),breakBefore:x.breakBefore===true}))},
    planAttribution:{estimationPlanType:plan(value.planAttribution?.estimationPlanType),
      inferredObservations:Number.isSafeInteger(value.planAttribution?.inferredObservations)&&value.planAttribution.inferredObservations>=0?value.planAttribution.inferredObservations:0},
    workHours:LEVELS.map(level=>{const x=rows(value.workHours).find(x=>x.level===level);return {level,hours:scalar(x?.hours),inferred:x?.inferred===true};}),
    daily:rows(value.daily).slice(-7).filter(x=>/^\d{4}-\d{2}-\d{2}$/u.test(x?.date??"")).map(x=>({date:x.date,covered:x.covered===true,
      ...levels(x),inferred:x.inferred===true,
      plans:rows(x.plans).slice(0,10).filter(p=>p&&typeof p==='object').map(p=>({planType:plan(p.planType),covered:p.covered===true,inferred:p.inferred===true,...levels(p)}))})),
    current:{state:["working","idle","unknown"].includes(value.current?.state)?value.current.state:"unknown",
      level:["heavy","medium","light","unclassified"].includes(value.current?.level)?value.current.level:null,
      hours:scalar(value.current?.hours),ratePpPerHour:scalar(value.current?.ratePpPerHour)},
    comparison:{startedAtMs:Number.isSafeInteger(value.comparison?.startedAtMs)&&value.comparison.startedAtMs>=0?value.comparison.startedAtMs:null,
      coverage:["complete","partial","unavailable"].includes(value.comparison?.coverage)?value.comparison.coverage:null,
      observedFrom:instant(value.comparison?.observedFrom)?value.comparison.observedFrom:null,
      observedThrough:instant(value.comparison?.observedThrough)?value.comparison.observedThrough:null,
      actualPp:scalar(value.comparison?.actualPp),expectedPp:scalar(value.comparison?.expectedPp)}};
}

export function renderOverviewWorkload(root,data,{translate:t,locale="en-US"}={}) {
  const doc=root.ownerDocument;
  const focused=root.contains?.(doc.activeElement)?doc.activeElement?.dataset?.workloadDiagnosticFocus:null;
  const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const num=(x,digits=1)=>finite(x)?new Intl.NumberFormat(locale,{maximumFractionDigits:digits}).format(x):"—";
  const hour=(x)=>finite(x)?t("workload.hours",{value:num(x)}):"—";
  const planLabel=p=>PLAN_LABELS[p]??t('workload.unknown');
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
    for(let i=0;i<=4;i++){const val=min+(max-min)*i/4,yy=y(val);svg.append(svgNode("line",{x1:46,x2:622,y1:yy,y2:yy,stroke:"var(--neutral-line)"}));
      const label=svgNode("text",{x:38,y:yy+4,"text-anchor":"end"});label.textContent=`${num(val)}%`;svg.append(label);}
    let segment=[];
    const flush=()=>{if(segment.length)svg.append(svgNode("polyline",{points:segment.join(" "),stroke:"var(--neutral-ink)","stroke-width":2.5,fill:"none"}));segment=[];};
    for(const p of points){if(p.breakBefore||!finite(p[valueKey]))flush();if(!finite(p[valueKey]))continue;
      segment.push(`${x(p)},${y(p[valueKey])}`);
      const dot=svgNode("circle",{cx:x(p),cy:y(p[valueKey]),r:3,fill:"var(--neutral-ink)"});
      const title=svgNode("title");title.textContent=`${new Date(p.at).toLocaleString(locale)} · ${num(p[valueKey])}%`;dot.append(title);svg.append(dot);}
    flush();
    for(const [at,xx,anchor]of[[points[0].at,46,"start"],[points.at(-1).at,622,"end"]]){
      const label=svgNode("text",{x:xx,y:202,"text-anchor":anchor});label.textContent=key==="allowance"?new Date(at).toLocaleDateString(locale,{month:"numeric",day:"numeric"}):time(at);svg.append(label);}
    return svg;
  }
  root.replaceChildren();root.className="workload-overview";
  const w=data;
  const grid=node("div","workload-grid");root.append(grid);
  const allowance=card("allowance"),value=node("div","workload-remaining");value.append(node("span","",t("workload.current")),node("strong","",w?.allowance?.remainingPercent===null||!w?"—":`${num(w.allowance.remainingPercent)}%`));
  allowance.append(value,lineChart(w?.allowance?.points??[],"allowance","remainingPercent",[0,100]));grid.append(allowance);
  const workHours=card("hours"),maxHours=Math.max(0,...(w?.workHours??[]).map(x=>x.hours??0));
  for(const level of LEVELS){const item=w?.workHours?.find(x=>x.level===level),val=item?.hours??null;
    const row=node("div",`workload-hours-row ${level==="composite"?"is-composite":""}`);row.dataset.level=level;
    const track=node("div","workload-hour-track"),fill=node("i");fill.style.width=`${maxHours>0&&val!==null?100*val/maxHours:0}%`;fill.style.backgroundColor=COLORS[level];track.append(fill);
    row.append(node("span","",t(`workload.level.${level}`)),track,node("strong","",`${hour(val)}${item?.inferred&&val!==null?' *':''}`));workHours.append(row);}
  if(w?.schemaVersion==='overview-workload-v4'){
    workHours.append(node('p','',t('workload.estimateScope',{plan:planLabel(w.planAttribution.estimationPlanType)})));
    if(w.workHours.every(x=>x.hours===null))workHours.append(node('p','',t('workload.estimateCollecting')));
  }
  grid.append(workHours);
  const daily=card("daily"),svg=svgNode("svg",{viewBox:"0 0 640 210",role:"img","aria-label":t("workload.title.daily")});
  const days=w?.daily??[],groups=d=>d.plans?.length?d.plans:[d],total=d=>["heavy","medium","light","unclassified"].reduce((s,k)=>s+(d[k]??0),0),max=Math.max(1,...days.flatMap(d=>groups(d).map(total)));
  for(let i=0;i<=4;i++){const yy=174-i*154/4;svg.append(svgNode("line",{x1:46,x2:622,y1:yy,y2:yy,stroke:"var(--neutral-line)"}));const label=svgNode("text",{x:38,y:yy+4,"text-anchor":"end"});label.textContent=num(max*i/4);svg.append(label);}
  const unit=svgNode("text",{x:46,y:12});unit.textContent=t("workload.points");svg.append(unit);
  days.forEach((d,i)=>{const x=60+i*80;
    if(d.covered){const plans=groups(d),width=42/plans.length;
      plans.forEach((p,j)=>{let top=174;
        for(const level of["light","medium","heavy","unclassified"]){const h=(p[level]??0)/max*154;if(h<=0)continue;
          const rect=svgNode("rect",{x:x+j*width,y:top-h,width:Math.max(1,width-1),height:h,fill:COLORS[level],"shape-rendering":"crispEdges"});
          const title=svgNode("title");title.textContent=`${d.date} · ${p.planType?planLabel(p.planType)+' · ':''}${t(`workload.level.${level}`)} ${num(p[level])} ${t("workload.points")}${p.inferred?' · '+t('workload.inferred'):''}`;
          rect.append(title);svg.append(rect);top-=h;}
        if(p.planType){const label=svgNode('text',{x:x+(j+.5)*width,y:187,'text-anchor':'middle','font-size':plans.length>1?9:11});
          label.textContent=planLabel(p.planType).replace('Pro ','')+(p.inferred?'*':'');svg.append(label);}
      });}
    else{const missing=svgNode("text",{x:x+21,y:164,"text-anchor":"middle"});missing.textContent="—";svg.append(missing);}
    const label=svgNode("text",{x:x+21,y:202,"text-anchor":"middle"});label.textContent=d.date.slice(5);svg.append(label);});
  daily.append(svg);const legend=node("div","workload-legend");
  for(const level of["heavy","medium","light","unclassified"]){const label=node("span"),dot=node("i");dot.style.backgroundColor=COLORS[level];label.append(dot,doc.createTextNode(t(`workload.level.${level}`)));legend.append(label);}daily.append(legend);
  grid.append(daily);
  const current=card("current"),c=w?.current;
  const label=c?.state==="idle"?t("workload.idle"):c?.state==="working"?t(`workload.level.${c.level??"unclassified"}`):t("workload.unknown");
  const main=node("strong","workload-current-value",label);if(c?.state==="working")main.style.color=COLORS[c.level]??"var(--neutral-ink)";current.append(main);
  if(c?.state==="working"){
    const rate=node("p","workload-current-rate");rate.append(node("span","",t("workload.rate")),node("strong","",finite(c.ratePpPerHour)?t("workload.rateValue",{value:num(c.ratePpPerHour)}):"—"));current.append(rate);
    const rest=node("p","workload-current-hours");rest.append(node("span","",t("workload.canWork")),node("strong","",hour(c.hours)));current.append(rest);}
  grid.append(current);
  const comparison=card("comparison");comparison.classList.add("workload-wide");
  const totals=w?.comparison;
  if(totals?.startedAtMs!==null&&totals?.startedAtMs!==undefined)comparison.append(node("p","workload-comparison-period",
    t("workload.sinceStartup",{time:new Date(totals.startedAtMs).toLocaleString(locale,{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})})));
  if(totals?.coverage==="partial")comparison.append(node("p","workload-comparison-partial",t("workload.comparisonPartial")));
  const columns=svgNode("svg",{viewBox:"0 0 640 240",role:"img","aria-label":t("workload.title.comparison")});
  const values=[totals?.actualPp??null,totals?.expectedPp??null],scale=Math.max(1,...values.map(x=>x??0));
  for(let i=0;i<=4;i++){const yy=174-i*134/4;columns.append(svgNode("line",{x1:46,x2:622,y1:yy,y2:yy,stroke:"var(--neutral-line)"}));
    const label=svgNode("text",{x:38,y:yy+4,"text-anchor":"end"});label.textContent=num(scale*i/4);columns.append(label);}
  const pp=svgNode("text",{x:46,y:16});pp.textContent=t("workload.points");columns.append(pp);
  values.forEach((v,i)=>{const cx=220+i*230,h=v===null?0:v/scale*134,top=174-h,color=i===0?"var(--neutral-ink)":"var(--neutral-muted)";
    const column=svgNode("g",{"data-comparison-column":i===0?"actual":"expected"});
    if(v!==null&&v>0){column.append(svgNode("rect",{x:cx-46,y:top,width:92,height:h,fill:color}),
      svgNode("ellipse",{cx,cy:174,rx:46,ry:6,fill:color}),svgNode("ellipse",{cx,cy:top,rx:46,ry:6,fill:color,stroke:"var(--neutral-surface)","stroke-width":1}));}
    const amount=svgNode("text",{x:cx,y:top-15,"text-anchor":"middle","font-weight":"bold"});amount.textContent=v===null?"—":`${num(v,2)} ${t("workload.points")}`;
    const label=svgNode("text",{x:cx,y:216,"text-anchor":"middle"});label.textContent=t(i===0?"workload.actualConsumption":"workload.expectedConsumption");
    column.append(amount,label);columns.append(column);});
  comparison.append(columns);grid.append(comparison);
  if(w?.status==='stale'||w?.errors?.length){
    const view=views.get(root)??{open:false,page:0};views.set(root,view);
    const details=node('details','workload-alert');details.open=view.open;
    details.addEventListener?.('toggle',()=>{view.open=details.open;});
    const primary=w.errors[0];
    const summary=node('summary','',w.pricingDetails?.total
      ?t('workload.diagnostics.unpriced',{count:num(w.pricingDetails.total,0)}):primary
        ?`${t(primary.code.startsWith('runtime_evidence_')?'workload.diagnostics.captureFailed':`workload.error.${primary.stage}`)} · ${t('workload.diagnostics.view')}`
        :t('workload.diagnostics.failed'));
    summary.dataset.workloadDiagnosticFocus='summary';
    const otherErrors=w.errors.filter(e=>e.code!=='price_missing').length;
    if(w.pricingDetails?.total&&otherErrors)summary.append(doc.createTextNode(t('workload.diagnostics.other',{count:otherErrors})));
    details.append(summary);const body=node('div','workload-diagnostics-body');details.append(body);
    if(w.status==='stale')body.append(node('p','',t('workload.stale',{time:w.generatedAt?new Date(w.generatedAt).toLocaleString(locale):'—'})));
    for(const e of w.errors)body.append(node('p','',`${t(e.code==='price_missing'?'workload.diagnostics.priceMissing':`workload.error.${e.stage}`)} · ${e.code}`));
    const pricing=w.pricingDetails;
    if(pricing?.records.length){
      body.append(node('p','',t('workload.diagnostics.impact')));
      const tableRoot=node('div','workload-diagnostic-scroll');body.append(tableRoot);
      const pages=Math.ceil(pricing.records.length/10);view.page=Math.min(view.page,pages-1);
      function page(){
        tableRoot.replaceChildren();const table=node('table'),head=node('tr');
        for(const key of ['time','model','tokens','input','cache','output','reason'])head.append(node('th','',t(`workload.diagnostics.${key}`)));
        const thead=node('thead');thead.append(head);table.append(thead);const tbody=node('tbody');
        for(const record of pricing.records.slice(view.page*10,view.page*10+10)){
          const tr=node('tr');
          for(const text of [new Date(record.at).toLocaleString(locale),record.model==='unknown'?t('workload.unknown'):record.model,
            num(record.tokens,0),num(record.inputUncached,0),num(record.cacheRead,0),num(record.output,0),t(`workload.diagnostics.${record.reason}`)])tr.append(node('td','',text));
          tbody.append(tr);
        }table.append(tbody);tableRoot.append(table);
        if(pages>1){const nav=node('nav','workload-diagnostic-pages');
          for(const [key,step]of [['previous',-1],['next',1]]){const button=node('button','',t(`workload.diagnostics.${key}`));button.type='button';
            button.disabled=step<0?view.page===0:view.page===pages-1;
            button.dataset.workloadDiagnosticFocus=key;
            button.addEventListener?.('click',()=>{view.page+=step;page();tableRoot.querySelector?.('button:not(:disabled)')?.focus();});nav.append(button);}
          nav.append(node('span','',`${view.page+1} / ${pages}`));tableRoot.append(nav);}
      }page();
    }
    if(pricing?.truncated)body.append(node('p','',t('workload.diagnostics.limited',{count:num(pricing.records.length,0),total:num(pricing.total,0)})));
    if(pricing?.capture){body.append(node('p','',`${t('workload.diagnostics.capture')} · ${t(`workload.capture.${pricing.capture.status}`)}`));
      if(pricing.capture.checkedAt)body.append(node('p','',new Date(pricing.capture.checkedAt).toLocaleString(locale)));
      if(pricing.capture.coverageGap)body.append(node('p','',t('workload.diagnostics.captureGap')));
      body.append(node('p','',t('workload.diagnostics.captureBoundary')));}
    root.append(details);
    if(['summary','previous','next'].includes(focused))root.querySelector?.(`[data-workload-diagnostic-focus="${focused}"]`)?.focus({preventScroll:true});
  }
}
