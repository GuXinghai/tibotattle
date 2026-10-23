import { SIGMAS, createWeeklyApiSmoother, intervalAt, weeklyApiDomain } from './weekly-api-intervals.js';

export function mountWeeklyApiChart({documentRef,t,formatMoney,formatInstant,onDetails,onRetry}){
  const make=(tag,cls,text)=>{const el=documentRef.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const root=make('section','weekly-api-primary dashboard-section');root.id='weekly-api-primary';
  root.dataset.dashboardPage='allowance';root.setAttribute('data-requires-evidence','');
  const head=make('div','weekly-api-heading'),title=make('h2'),controls=make('div','weekly-api-controls');
  title.id='weekly-api-title';root.setAttribute('aria-labelledby',title.id);
  const label=make('label'),labelText=make('span'),sigma=make('select');sigma.id='weekly-api-sigma';
  label.htmlFor=sigma.id;label.append(labelText,sigma);
  const details=make('button','allowance-simple-link');details.type='button';details.id='weekly-api-details';
  details.onclick=()=>onDetails(details);controls.append(label,details);head.append(title,controls);
  const value=make('strong','weekly-api-value'),qualifier=make('span','weekly-api-qualifier');
  const summary=make('div','weekly-api-summary');summary.append(value,qualifier);
  const notice=make('p','weekly-api-notice');notice.setAttribute('role','status');
  const retry=make('button','allowance-simple-link');retry.type='button';retry.onclick=()=>onRetry();
  const error=make('div','weekly-api-error');error.setAttribute('role','status');error.append(notice,retry);error.hidden=true;
  const canvas=make('div','weekly-api-canvas'),svg=documentRef.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('role','img');svg.setAttribute('aria-labelledby',title.id);
  const statePanel=make('div','weekly-api-state'),stateText=make('p');statePanel.setAttribute('role','status');
  const stateRetry=make('button','allowance-simple-link');stateRetry.type='button';stateRetry.id='weekly-api-state-retry';
  stateRetry.dataset.dashboardRetry='true';
  stateRetry.onclick=()=>onRetry();statePanel.append(stateText,stateRetry);
  const slider=make('input','weekly-api-time');slider.id='weekly-api-time';slider.type='range';
  slider.min='0';slider.max='1000000';slider.step='1';
  canvas.append(svg,slider,statePanel);root.append(head,summary,error,canvas);
  const ns=(tag,attrs,text)=>{const el=documentRef.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [k,v]of Object.entries(attrs))el.setAttribute(k,String(v));if(text!==undefined)el.textContent=text;return el;};
  let data=null,rows=[],domain=null,selected=null,selectionScope=null,smoother=null,renderError=null;
  let width=900,guide=null,publishedAt=null,locale=null,labelLocale=null,loadState='loading';const preferences=new Map();
  const preferenceKey='tibotattle.weekly-api-sigma';
  try{
    const saved=JSON.parse(documentRef.defaultView.localStorage.getItem(preferenceKey)??'{}');
    for(const period of ['24h','7d','30d','all'])if(SIGMAS.includes(saved?.[period]))preferences.set(period,saved[period]);
  }catch{/* Display preferences do not participate in evidence or accounting. */}
  const currentSigma=()=>Number(sigma.value);
  const latestValid=()=>rows.findLast(r=>r.reason===null);
  const atX=at=>62+(at-domain.start)/(domain.end-domain.start)*(width-76);
  const pending=code=>/^weekly_api_(source_pending|intervals_unavailable)$/.test(code??'');
  const canSmooth=()=>!renderError||pending(renderError);
  function showError(code){
    renderError=code;error.hidden=!code;
    const kind=code==='weekly_api_source_unavailable'?'sourceUnavailable'
      :code==='weekly_api_source_mismatch'?'sourceMismatch'
      :/smoothing/.test(code??'')?'smoothing':/mismatch|valid/.test(code??'')?'validation'
      :/regressed|stale/.test(code??'')?'stale':/resource/.test(code??'')?'resource'
      :/intervals_unavailable|source_pending/.test(code??'')?'pending':'projection';
    notice.textContent=code?t(`allowance.interval.failure.${kind}`):'';
    retry.textContent=t('allowance.interval.retry');
  }
  function labels(){
    title.textContent=t('allowance.interval.title');labelText.textContent=t('allowance.interval.smoothing');details.textContent=t('allowance.interval.details');
    slider.setAttribute('aria-label',t('trends.explore'));stateRetry.textContent=t('allowance.interval.retry');
    const selectedSigma=sigma.value;
    sigma.replaceChildren(...SIGMAS.map(n=>{const option=make('option','',n?t('allowance.interval.minutes',{value:n}):t('allowance.interval.off'));option.value=n;return option;}));
    sigma.value=selectedSigma||'60';labelLocale=documentRef.documentElement.lang;
    showError(renderError);
  }
  function read(at){
    selected=Math.max(domain.start,Math.min(domain.end,at));
    const row=intervalAt(rows,selected),raw=row?.reason===null?row.weeklyUsd:null;
    let smooth=raw;
    try{if(canSmooth()&&smoother)smooth=smoother(selected,currentSigma());}
    catch(e){showError(e.code??'weekly_api_smoothing_failed');}
    value.textContent=smooth===null?'—':formatMoney(smooth);
    qualifier.replaceChildren();
    if(currentSigma()&&canSmooth())qualifier.append(make('span','',t('allowance.interval.smoothed')));
    if(row){
      const text=row.reason?t(`allowance.interval.reason.${row.reason}`)
        :currentSigma()?`${t('allowance.interval.raw')}: ${formatMoney(raw)}`:'';
      if(text)qualifier.append(make('span','',text));
      qualifier.append(make('span','',`${formatInstant(row.startMs)} — ${formatInstant(row.endMs)}`));
      if(row.unknownSpeedEvents)qualifier.append(make('span','',t('allowance.interval.speedUnknown',{count:row.unknownSpeedEvents})));
    }
    if(guide){guide.setAttribute('x1',atX(selected));guide.setAttribute('x2',atX(selected));}
    slider.value=String(Math.round((selected-domain.start)/(domain.end-domain.start)*1e6));
    slider.setAttribute('aria-valuetext',`${formatInstant(selected)} · ${value.textContent}`);
  }
  function draw(){
    width=Math.max(244,canvas.clientWidth||900);svg.setAttribute('viewBox',`0 0 ${width} 300`);
    svg.replaceChildren();guide=null;
    const visible=domain?rows.filter(r=>r.endMs>domain.start&&r.startMs<domain.end):[],valid=visible.filter(r=>r.reason===null);
    const unavailable=data?.projection?.status!=='available';
    const noPlot=unavailable||!valid.length;
    const loading=(pending(renderError)||!data)&&loadState==='loading';
    // Keep the plot's viewBox and summary space, but never draw a fabricated
    // zero axis, selection thumb or empty-data verdict for unavailable evidence.
    let state='ready';
    if(noPlot){
      if(loading)state='loading';
      else if((renderError&&!pending(renderError))||(loadState==='error'&&unavailable))state='error';
      else state=unavailable?'unavailable':'empty';
    }
    root.dataset.state=state;
    root.setAttribute('aria-busy',String(loading));
    summary.style.visibility=noPlot?'hidden':'';summary.setAttribute('aria-hidden',String(noPlot));
    statePanel.hidden=!noPlot;svg.setAttribute('aria-hidden',String(noPlot));
    slider.hidden=noPlot;slider.disabled=noPlot;sigma.disabled=noPlot;details.disabled=!data;
    error.hidden=noPlot||!renderError;
    retry.hidden=loadState==='loading'&&pending(renderError);
    if(!unavailable&&pending(renderError))notice.textContent=t(loadState==='loading'
      ?'allowance.interval.updating':'allowance.interval.failure.stale');
    if(noPlot){
      stateText.textContent=t(state==='loading'?(data&&pending(renderError)
        ?'allowance.interval.recalculating':'allowance.interval.loading')
        :state==='empty'?'allowance.interval.empty'
        :state==='error'&&(!renderError||pending(renderError))?'allowance.interval.readFailed'
        :'allowance.interval.failure.pending');
      if(state==='error'&&renderError&&!pending(renderError))stateText.textContent=notice.textContent;
      stateRetry.hidden=!['error','unavailable'].includes(state)||loadState==='loading';
      stateRetry.disabled=loadState==='loading';
      value.textContent='—';qualifier.replaceChildren();return;
    }
    const maximum=valid.reduce((v,r)=>Math.max(v,r.weeklyUsd),1)*1.08;
    const y=v=>252-v/maximum*218;
    for(let i=0;i<=4;i++){
      const v=maximum*i/4,yy=y(v);
      svg.append(ns('line',{x1:62,x2:width-14,y1:yy,y2:yy,class:'weekly-api-grid'}),
        ns('text',{x:54,y:yy+4,'text-anchor':'end'},`$${new Intl.NumberFormat(documentRef.documentElement.lang||'en',{notation:'compact',maximumFractionDigits:1}).format(v)}`));
    }
    const tickCount=width<500?1:2;
    for(let i=0;i<=tickCount;i++){
      const at=domain.start+(domain.end-domain.start)*i/tickCount;
      svg.append(ns('text',{x:atX(at),y:281,'text-anchor':i===0?'start':i===tickCount?'end':'middle'},
        new Intl.DateTimeFormat(documentRef.documentElement.lang||'en',{month:'numeric',day:'numeric',...(data.period==='24h'?{hour:'2-digit',minute:'2-digit'}:{})}).format(at)));
    }
    let path='',prior=null;
    for(const row of valid){
      const start=Math.max(row.startMs,domain.start),end=Math.min(row.endMs,domain.end);
      path+=`${prior&&prior.segment===row.segment&&prior.endMs===row.startMs?'L':'M'}${atX(start)},${y(row.weeklyUsd)}H${atX(end)}`;prior=row;
    }
    svg.append(ns('path',{d:path,fill:'none',class:currentSigma()&&canSmooth()?'weekly-api-raw':'weekly-api-line'}));
    if(currentSigma()&&canSmooth()&&smoother){
      try{
        let smoothed='';const sampleCount=Math.min(1200,Math.max(240,Math.ceil(width)));
        // Each segment has its own path. Include its exact endpoints even if
        // shorter than a screen pixel; do not join across unavailable evidence.
        const groups=new Map();for(const row of valid){const list=groups.get(row.segment)??[];list.push(row);groups.set(row.segment,list);}
        for(const list of groups.values()){
          const start=Math.max(domain.start,list[0].startMs),end=Math.min(domain.end,list.at(-1).endMs);
          const n=Math.max(1,Math.ceil((end-start)/(domain.end-domain.start)*sampleCount));
          for(let i=0;i<=n;i++){
            const at=start+(end-start)*i/n;
            // At a segment's right boundary, sample its left-hand limit.
            const v=smoother(i===n?Math.max(start,at-.001):at,currentSigma());
            if(v===null)throw Object.assign(new Error(),{code:'weekly_api_smoothing_failed'});
            smoothed+=`${i?'L':'M'}${atX(at)},${y(v)}`;
          }
        }
        svg.append(ns('path',{d:smoothed,fill:'none',class:'weekly-api-line'}));
      }catch(e){showError(e.code??'weekly_api_smoothing_failed');svg.querySelector('path')?.setAttribute('class','weekly-api-line');}
    }
    guide=ns('line',{x1:atX(selected??domain.end),x2:atX(selected??domain.end),y1:24,y2:252,class:'weekly-api-guide'});svg.append(guide);
    read(selected??domain.end);
  }
  slider.oninput=()=>{if(!slider.disabled)read(domain.start+Number(slider.value)/1e6*(domain.end-domain.start));};
  svg.addEventListener('pointerdown',event=>{
    if(!domain||slider.disabled)return;const rect=svg.getBoundingClientRect();
    read(domain.start+Math.max(0,Math.min(1,((event.clientX-rect.left)*width/rect.width-62)/(width-76)))*(domain.end-domain.start));
  });
  sigma.onchange=()=>{
    if(!data||sigma.disabled)return;
    preferences.set(data.period,currentSigma());
    try{documentRef.defaultView.localStorage.setItem(preferenceKey,JSON.stringify(Object.fromEntries(preferences)));}catch{/* Optional display preference. */}
    showError(data.failure??(data.projection?.status==='unavailable'?data.projection.reason:null));draw();
  };
  const resize=()=>{if(root.isConnected&&canvas.clientWidth&&Math.abs(canvas.clientWidth-width)>1)draw();};
  documentRef.defaultView.addEventListener('resize',resize);
  if(documentRef.defaultView.ResizeObserver)new documentRef.defaultView.ResizeObserver(resize).observe(canvas);
  labels();draw();
  return {root,setLoadState(state){
    if(loadState===state&&labelLocale===documentRef.documentElement.lang)return;
    loadState=state;labels();draw();
  },update(next){
    const scope=`${next.period}:${next.planType}`;
    if(selectionScope===scope&&publishedAt&&next.generatedAt&&Date.parse(next.generatedAt)<Date.parse(publishedAt)){
      showError('weekly_api_report_regressed');if(root.dataset.state!=='ready')draw();return;
    }
    if(data&&data.projection===next.projection&&selectionScope===scope&&data.endMs===next.endMs
      &&data.startMs===next.startMs&&data.failure===next.failure&&locale===documentRef.documentElement.lang)return;
    const follow=selected===null||domain&&selected>=Math.min(domain.end,latestValid()?.endMs??domain.end)-.01;
    if(selectionScope!==scope)selected=null;
    data=next;selectionScope=scope;publishedAt=next.generatedAt;locale=documentRef.documentElement.lang;
    rows=next.projection?.rows??[];
    labels();
    sigma.value=String(preferences.get(next.period)??(next.period==='24h'?30:next.period==='7d'?60:120));
    slider.setAttribute('aria-label',t('trends.explore'));
    domain=weeklyApiDomain(next.period,next.endMs,next.startMs);
    showError(next.failure??(next.projection?.status==='unavailable'?next.projection.reason:null));
    try{smoother=createWeeklyApiSmoother(rows);}catch(e){smoother=null;showError(e.code??'weekly_api_smoothing_failed');}
    if(selected===null||follow)selected=Math.min(domain.end,(latestValid()?.endMs??domain.end)-.001);
    draw();
  },reading:()=>({selected,sigma:currentSigma(),failure:renderError})};
}
