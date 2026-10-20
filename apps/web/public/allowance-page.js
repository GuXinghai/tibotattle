// Presentation of validated dashboard selectors. No accounting or source parsing.
import { diagnosticErrorCode } from './lib.js';
import { mountWeeklyApiChart } from './weekly-api-chart.js';

export function dashboardReadFailure(error) {
  if (error?.name === 'AbortError') return null;
  const code = diagnosticErrorCode(error?.code) || 'report_read_failed';
  const kind = error?.name === 'TimeoutError' || [408, 504].includes(error?.status) || /timeout/.test(code) ? 'timeout'
    : error instanceof SyntaxError || error?.name === 'SyntaxError' ? 'parse'
    : /stale|expired/.test(code) ? 'stale'
    : /schema|valid|mismatch|malformed/.test(code) ? 'validation'
    : /index|accounting|calculation|projection/.test(code) ? 'local'
    : 'request';
  return {copyKey: `allowance.simple.failure.${kind}`, code};
}

export function comparisonReading(points, at) {
  let selected = null;
  for (const point of points) {
    if (Number.isFinite(point.timestampMs) && point.timestampMs <= at
        && (!selected || point.timestampMs > selected.timestampMs)) selected = point;
  }
  if (!selected || at - selected.timestampMs > 3_600_000) return null;
  return selected;
}

export function retainedPageIndex(previousRows, nextRows, page, size, key) {
  const anchor = previousRows[page * size];
  const index = anchor ? nextRows.findIndex(row => key(row) === key(anchor)) : -1;
  return Math.min(Math.max(0, index >= 0 ? Math.floor(index / size) : page),
    Math.max(0, Math.ceil(nextRows.length / size) - 1));
}

// Observations can be displayed without a priced usage lane or fitted capacity.
// Keep exact timestamps, missing readings and reset boundaries; never fill gaps.
export function observedAllowancePoints(rows, {startMs, endMs}, sameReset) {
  let segment = 0, previous = null;
  return rows.map(row => ({...row, timestampMs: Date.parse(row.observedAt)}))
    .filter(row => Number.isFinite(row.timestampMs) && row.timestampMs >= startMs && row.timestampMs <= endMs)
    .sort((a,b) => a.timestampMs-b.timestampMs)
    .map(row => {
      if (previous && (!sameReset(previous.resetAt, row.resetAt)
          || row.timestampMs-previous.timestampMs > 6*3_600_000)) segment++;
      previous = row;
      return {timestamp: row.observedAt, timestampMs: row.timestampMs,
        allowanceObservedAt: row.observedAt, allowanceSegment: segment,
        allowanceRemaining: Number.isFinite(row.remainingPercent) ? row.remainingPercent : null};
    });
}

export function mountAllowancePage({ documentRef, t, formatMoney, formatPp,
  formatInstant, formatDetailInstant = formatInstant, formatPercent, formatReset, selectTime, stopPlayback, retry = () => {} }) {
  const root = documentRef.querySelector('#allowance-screen');
  if (!root) return null;
  const $ = selector => documentRef.querySelector(selector);
  const make = (tag, cls, text) => {
    const el = documentRef.createElement(tag); if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text; return el;
  };
  root.classList.add('allowance-simple');
  const capacity = $('.trends-capacity-panel'), comparison = $('.trends-comparison-panel');
  const headline = make('div', 'allowance-simple-headline');
  const current = make('strong'), reset = make('span', 'allowance-simple-muted');
  headline.append(current, reset); capacity.prepend(headline);
  const selected = make('p', 'allowance-simple-selected');
  $('#allowance-timeline-chart').after(selected);
  const controls = $('.trends-time-controls');
  selected.after(controls);
  const activityHeading = make('div', 'allowance-simple-heading');
  const activityTitle = make('h3'); activityHeading.append(activityTitle, $('#usage-group-controls'));
  $('#trends-activity-label').before(activityHeading);
  $('#usage-timeline-chart').before($('#usage-timeline-empty'));
  const comparisonHeadline = make('div', 'allowance-simple-headline');
  const difference = make('strong'); comparisonHeadline.append(difference); comparison.prepend(comparisonHeadline);
  const comparisonNotice = make('p', 'allowance-simple-muted'); comparisonNotice.setAttribute('role', 'status');
  comparisonHeadline.after(comparisonNotice);
  const comparisonTime = make('input'); comparisonTime.type = 'range'; comparisonTime.disabled = true;
  comparisonTime.className = 'allowance-simple-time';
  const comparisonSelected = make('p', 'allowance-simple-selected');
  $('#difference-timeline-chart').after(comparisonTime, comparisonSelected);
  const bars = make('div', 'allowance-simple-bars'); const barValues = [];
  for (const key of ['actual', 'expected']) {
    const row = make('div'), label = make('span'), track = make('div', 'allowance-simple-track');
    const fill = make('i'), value = make('strong'); track.append(fill); row.append(label, track, value);
    bars.append(row); barValues.push({key, label, fill, value});
  }
  comparisonHeadline.after(bars);
  const differenceTitle = make('h3'); $('#difference-timeline-chart').before(differenceTitle);
  const dialog = make('dialog', 'allowance-simple-dialog'); dialog.id = 'allowance-detail-dialog';
  const dialogHead = make('div', 'allowance-simple-dialog-heading'), title = make('h2');
  title.id = 'allowance-detail-title'; dialog.setAttribute('aria-labelledby', title.id);
  const close = make('button', 'button button-quiet compact'); close.type = 'button';
  const content = make('div'); dialogHead.append(title, close); dialog.append(dialogHead, content); root.append(dialog);
  const store = make('div'); store.hidden = true; root.append(store);
  const detailHosts = new Map();
  const detail = (key, elements) => {
    const host = make('div'); host.dataset.allowanceDetail = key;
    elements.filter(Boolean).forEach(el => { const marker = documentRef.createComment('allowance detail'); el.before(marker); host.append(el); });
    store.append(host); detailHosts.set(key, host); return host;
  };
  detail('estimate', [$('.allowance-equivalent'), $('#allowance-window-control')]);
  detail('drift', [$('.trends-drift-panel')]);
  detail('exceptions', [$('.divergence-panel')]);
  detail('comparison', [$('.trends-exact-panel')]);
  detail('method', [comparison.querySelector('.chart-heading'), $('.calibration-legend'), $('#timeline-chart'),
    $('#timeline-coverage'), $('#residual-coverage'), $('.trends-evidence-details')]);
  detail('tools', [$('#trends-replay'), $('#trends-latest'), capacity.querySelector('.chart-navigation'),
    $('#usage-timeline-summary'), $('#usage-timeline-coverage')]);
  const recordsHost = detail('records', []), resetsHost = detail('resets', []), gapsHost = detail('gaps', []);
  const intervalsHost = detail('intervals', []), hub = detail('complete', []);
  const detailComparisonNotices = ['comparison','drift','exceptions','method'].map(key => {
    const notice=make('p','allowance-simple-muted'); notice.setAttribute('role','status');
    detailHosts.get(key).prepend(notice); return notice;
  });
  const action = (host, key) => {
    const b = make('button', 'allowance-simple-link'); b.type = 'button'; b.dataset.allowanceOpen = key;
    b.onclick = () => open(key, b); host.append(b); return b;
  };
  const historyActions = make('div', 'allowance-simple-actions'); capacity.append(historyActions);
  ['records', 'resets', 'estimate', 'tools'].forEach(key => action(historyActions, key));
  const comparisonActions = make('div', 'allowance-simple-actions'); comparison.append(comparisonActions);
  ['comparison', 'drift', 'exceptions', 'method'].forEach(key => action(comparisonActions, key));
  const gapsAction = action(comparisonActions, 'gaps'); gapsAction.hidden = true;
  detail('history', [capacity]); detail('differences', [comparison]);
  const nav = make('div','allowance-simple-actions');hub.append(nav);
  ['intervals','history','differences','records','resets','estimate','drift','exceptions','comparison','method','tools','gaps']
    .forEach(key=>action(nav,key));
  const projectionStatus=make('p','allowance-simple-muted');hub.append(projectionStatus);
  const chart = mountWeeklyApiChart({documentRef,t,formatMoney,formatInstant,
    onDetails:button=>open('complete',button),onRetry:retry});
  root.prepend(chart.root);
  const planControl=$('#weekly-plan-control');
  if(planControl){$('.topbar').prepend(planControl);planControl.dataset.dashboardPage='allowance';}
  let data = {observations: [], events: [], points: [], comparisonGaps: []}, modal = null, trigger = null;
  let recordsPage = 0, eventsPage = 0, gapsPage = 0, intervalsPage = 0, selectedAt = null, scope = null, dialogScroll = new Map(), inspected = null;
  function open(key, button) {
    if(key==='intervals')key='complete';
    if (modal) dialogScroll.set(modal, dialog.scrollTop);
    if (modal) store.append(...content.childNodes);
    modal = key; trigger = button ?? trigger; title.textContent = t(`allowance.simple.${key}`);
    if(key !== 'inspect')inspected=null;
    content.append(detailHosts.get(key));
    if(key==='complete')hub.append(intervalsHost);
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = dialogScroll.get(key) ?? 0;
    documentRef.defaultView.dispatchEvent(new Event('resize'));
  }
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    if (modal) dialogScroll.set(modal, dialog.scrollTop);
    store.append(...content.childNodes); modal = null; stopPlayback();
    if (trigger?.isConnected) trigger.focus({preventScroll: true}); trigger = null;
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  function table(host, headers, rows, page, change, key, detailRow) {
    const focusedStep=host.contains(documentRef.activeElement)?documentRef.activeElement?.dataset?.allowancePageStep:null;
    const savedScroll = dialog.scrollTop; host.replaceChildren();
    const wrap = make('div', 'table-wrap'), table = make('table'), head = make('thead'), tr = make('tr');
    headers.forEach(text => { const th = make('th', '', text); th.scope = 'col'; tr.append(th); });
    head.append(tr); table.append(head); const body = make('tbody');
    for (const row of rows.slice(page * 10, page * 10 + 10)) {
      const tr = make('tr'); detailRow(row).forEach(text => tr.append(make('td', '', text)));
      if (key !== 'gaps') {
        const cell = make('td'), b = make('button', 'allowance-simple-link', t('allowance.simple.inspect'));
        b.type = 'button'; b.onclick = () => inspect(key, row); cell.append(b); tr.append(cell);
      }
      body.append(tr);
    }
    if (!rows.length) {const tr = make('tr'), td = make('td', '', t('allowance.simple.empty')); td.colSpan = headers.length; tr.append(td); body.append(tr);}
    table.append(body); wrap.append(table); host.append(wrap);
    if (rows.length > 10) {
      const pager = make('div', 'table-pagination'); const previous = make('button', 'button button-quiet compact', t('table.pagination.previous'));
      const next = make('button', 'button button-quiet compact', t('table.pagination.next'));
      previous.type = next.type = 'button'; previous.disabled = page === 0; next.disabled = (page + 1) * 10 >= rows.length;
      previous.dataset.allowancePageStep='previous';next.dataset.allowancePageStep='next';
      previous.onclick = () => change(page - 1); next.onclick = () => change(page + 1);
      pager.append(previous, make('span', '', `${page+1} / ${Math.ceil(rows.length/10)}`), next); host.append(pager);
      if(focusedStep){const target=focusedStep==='next'&&!next.disabled?next:previous.disabled?next:previous;target.focus({preventScroll:true});}
    }
    dialog.scrollTop = savedScroll;
  }
  function inspect(key, row) {
    const childKey = 'inspect'; let host = detailHosts.get(childKey);
    if (!host) host = detail(childKey, []); host.replaceChildren();
    const back = make('button', 'button button-quiet compact', t('allowance.simple.back')); back.type = 'button';
    back.onclick = () => open(key); host.append(back);
    const pairs = key === 'intervals'
      ? [[t('allowance.interval.bounds'),`${formatDetailInstant(row.startMs)} — ${formatDetailInstant(row.endMs)}`],
        [t('weekly.plan.label'),row.planType],
        [t('allowance.interval.duration'),`${((row.endMs-row.startMs)/60_000).toFixed(2)} ${t('allowance.interval.minuteUnit')}`],
        [t('allowance.interval.api'),row.apiUsd],
        [t('allowance.interval.quota'),row.quotaPp===null?'—':formatPp(row.quotaPp)],
        [t('allowance.interval.title'),row.weeklyUsd===null?'—':formatMoney(row.weeklyUsd)],
        [t('allowance.interval.formula'),row.weeklyUsd===null?'—':`${row.apiUsd} ÷ (${row.quotaPp} / 100) = ${row.weeklyUsd}`],
        [t('allowance.simple.status'),row.reason?t(`allowance.interval.reason.${row.reason}`):t('allowance.interval.valid')],
        [t('allowance.interval.events'),String(row.usageEvents)],
        [t('allowance.interval.unknownSpeed'),String(row.unknownSpeedEvents)],
        [t('allowance.interval.excludedReview'),`${row.excludedReviewEvents} · ${row.excludedReviewUsd===null?'—':formatMoney(Number(row.excludedReviewUsd))}`],
        [t('allowance.interval.prices'),row.priceCardIds.join(', ')||'—'],
        [t('allowance.interval.basis'),t('allowance.interval.basisValue')],
        [t('allowance.interval.smoothing'),chart.reading().sigma?t('allowance.interval.smoothingDetail',{value:chart.reading().sigma}):t('allowance.interval.off')],
        [t('allowance.interval.resultTime'),data.weeklyApi?.generatedAt?formatDetailInstant(data.weeklyApi.generatedAt):'—']]
      : key === 'records'
      ? [[t('format.localTime'), formatInstant(row.observedAt)], [t('allowance.simple.remaining'), formatPercent(row.remainingPercent, 0)],
        [t('weekly.window.label'), t(row.durationMinutes === 300 ? 'weekly.window.fiveHour' : 'weekly.window.sevenDay')],
        [t('allowance.simple.resetAt'), row.resetAt ? formatInstant(row.resetAt) : '—']]
      : [[t('format.localTime'), formatInstant(row.timestampMs)], [t('allowance.simple.status'), row.caption],
        [t('allowance.simple.interval'), row.intervalStartedAt ? `${formatInstant(row.intervalStartedAt)} — ${formatInstant(row.observedAt)}` : '—']];
    for (const [label, value] of pairs) {const p = make('p', 'allowance-simple-kv'); p.append(make('span','',label), make('strong','',value)); host.append(p);}
    open(childKey);
    inspected={key,startMs:row.startMs,observedAt:row.observedAt,timestampMs:row.timestampMs};
  }
  function apiRows(value) {
    const span={'24h':86_400_000,'7d':7*86_400_000,'30d':30*86_400_000}[value.period];
    return (value.weeklyApi?.rows??[]).filter(r=>r.endMs>(span?value.endMs-span:-Infinity)&&r.startMs<=value.endMs);
  }
  function renderTables() {
    const visibleApiRows=apiRows(data);
    intervalsPage=Math.min(intervalsPage,Math.max(0,Math.ceil(visibleApiRows.length/10)-1));
    table(intervalsHost,[t('allowance.interval.bounds'),t('allowance.interval.quota'),t('allowance.interval.api'),t('allowance.interval.title'),t('allowance.simple.status'),''],
      visibleApiRows,Math.min(intervalsPage,Math.max(0,Math.ceil(visibleApiRows.length/10)-1)),page=>{intervalsPage=page;renderTables();},'intervals',row=>[
        `${formatInstant(row.startMs)} — ${formatInstant(row.endMs)}`,row.quotaPp===null?'—':formatPp(row.quotaPp),formatMoney(Number(row.apiUsd)),
        row.weeklyUsd===null?'—':formatMoney(row.weeklyUsd),row.reason?t(`allowance.interval.reason.${row.reason}`):t('allowance.interval.valid')]);
    table(recordsHost, [t('format.localTime'), t('allowance.simple.remaining'), t('allowance.simple.resetAt'), ''], data.observations, recordsPage,
      page => {recordsPage = page; renderTables();}, 'records', row => [formatInstant(row.observedAt), formatPercent(row.remainingPercent, 0), row.resetAt ? formatInstant(row.resetAt) : '—']);
    table(resetsHost, [t('format.localTime'), t('allowance.simple.status'), ''], data.events, eventsPage,
      page => {eventsPage = page; renderTables();}, 'resets', row => [formatInstant(row.timestampMs), row.caption]);
    table(gapsHost, [t('allowance.simple.interval'), t('allowance.simple.status')], data.comparisonGaps ?? [], gapsPage,
      page => {gapsPage = page; renderTables();}, 'gaps', row => [
        `${formatInstant(row[0])} — ${formatInstant(row[1])}`, t(`allowance.simple.gap.${row[2]}`)]);
  }
  function select(at) {
    selectedAt = at;
    const point = comparisonReading(data.points, at);
    const comparable = Number.isFinite(point?.observed) && Number.isFinite(point?.expected);
    const delta = comparable ? point.observed - point.expected : null;
    difference.textContent = delta === null ? t('allowance.simple.notComparable') : t(delta === 0 ? 'allowance.simple.equal' : delta < 0 ? 'allowance.simple.less' : 'allowance.simple.more', {value: formatPp(Math.abs(delta))});
    const max = comparable ? Math.max(point.observed, point.expected, 1) : 1;
    barValues.forEach((bar, i) => {const value = comparable ? point[i===0?'observed':'expected'] : null;
      bar.label.textContent=t(`allowance.simple.${bar.key}`); bar.value.textContent=formatPp(value);
      bar.fill.style.width = value === null ? '0%' : `${Math.max(0,value)/max*100}%`;});
    comparisonSelected.textContent = point ? comparable && Number.isFinite(point.measurementStartedAt) && Number.isFinite(point.measurementEndedAt)
      ? `${formatInstant(point.measurementStartedAt)} — ${formatInstant(point.measurementEndedAt)}`
      : formatInstant(point.timestampMs) : t('allowance.simple.empty');
    const obs = data.observations.find(row => Date.parse(row.observedAt) <= at);
    selected.textContent = `${formatInstant(at)} · ${obs && at-Date.parse(obs.observedAt)<=3*3_600_000 ? formatPercent(obs.remainingPercent,0) : '—'}`;
    comparisonTime.value = String(at);
  }
  comparisonTime.oninput = () => {select(Number(comparisonTime.value)); selectTime(Number(comparisonTime.value));};
  const onSelected = event => {if(Number.isFinite(event.detail?.at)) select(event.detail.at);};
  documentRef.addEventListener('tibotattle:allowance-time', onSelected);
  documentRef.addEventListener('tibotattle:allowance-reset', event => {
    const row = data.events.find(row => row.timestampMs === event.detail?.timestampMs);
    if(row) {trigger = documentRef.activeElement; inspect('resets',row);}
  });
  documentRef.addEventListener('tibotattle:page-view', event => {
    if(event.detail?.page !== 'allowance') {if(dialog.open)dialog.close();return;}
    const routes = {changes:'history',differences:'differences',equivalent:'estimate',drift:'drift',divergence:'exceptions',evidence:'comparison'};
    if(routes[event.detail.view]) open(routes[event.detail.view]);
    else if(dialog.open) dialog.close();
  });
  return {
    setLoadState(state) {chart.setLoadState(state);},
    update(next) {
      if(scope===next.scope && data.generatedAt && Date.parse(next.generatedAt)<Date.parse(data.generatedAt)){
        chart.update({period:next.period,planType:next.planType,projection:next.weeklyApi,
          generatedAt:next.generatedAt,endMs:next.endMs,startMs:next.startMs});return;
      }
      if(scope===next.scope && data.weeklyApi?.status==='available' && next.weeklyApi?.status==='unavailable'
          && /^weekly_api_(source_pending|intervals_unavailable|projection_failed|resource_limit|pricing_invalid|quota_invalid)$/.test(next.weeklyApi.reason)) {
        next={...data,intervalUpdateFailure:next.weeklyApi.reason};
      }
      const changedReport=data.weeklyApi!==next.weeklyApi||data.generatedAt!==next.generatedAt;
      if(scope !== null && next.scope !== scope) {if(dialog.open)dialog.close();recordsPage=eventsPage=gapsPage=intervalsPage=0;selectedAt=null;}
      intervalsPage=retainedPageIndex(apiRows(data),apiRows(next),intervalsPage,10,row=>`${row.planType}:${row.startMs}:${row.endMs}`);
      recordsPage=retainedPageIndex(data.observations,next.observations,recordsPage,10,row=>row.observedAt);
      eventsPage=retainedPageIndex(data.events,next.events,eventsPage,10,row=>row.timestampMs);
      gapsPage=retainedPageIndex(data.comparisonGaps ?? [],next.comparisonGaps ?? [],gapsPage,10,row=>row.join(':'));
      scope=next.scope; data=next;
      chart.update({period:next.period,planType:next.planType,projection:next.weeklyApi,
        generatedAt:next.generatedAt,endMs:next.endMs,startMs:next.startMs,failure:next.intervalUpdateFailure});
      const reading=chart.reading();
      projectionStatus.textContent=[next.weeklyApi?.generatedAt?formatInstant(next.weeklyApi.generatedAt):'',
        next.weeklyApi?.status==='unavailable'?next.weeklyApi.reason:'',reading.failure??'',
        reading.sigma?t('allowance.interval.smoothingDetail',{value:reading.sigma}):t('allowance.interval.off')].filter(Boolean).join(' · ');
      current.textContent=t(next.currentIsHistorical?'allowance.simple.last':'allowance.simple.current', {value:formatPercent(next.current?.remainingPercent,0)});
      reset.textContent=next.current?.resetAt ? next.currentIsHistorical
        ? t('allowance.simple.resetValue', {value:formatInstant(next.current.resetAt)}) : formatReset(next.current.resetAt) : '—';
      const unavailable = next.comparisonAvailable === false;
      const hasGaps = (next.comparisonGaps?.length ?? 0) > 0;
      gapsAction.hidden = !hasGaps;
      comparisonNotice.hidden=!unavailable && !hasGaps && !next.comparisonFailure;
      comparisonNotice.textContent=next.comparisonFailure
        ? t('allowance.simple.comparisonFailed', {code:next.comparisonFailure})
        : unavailable ? t('allowance.simple.comparisonUnavailable') : hasGaps ? t('allowance.simple.comparisonPartial') : '';
      detailComparisonNotices.forEach(notice=>{notice.hidden=comparisonNotice.hidden;notice.textContent=comparisonNotice.textContent;});
      if (unavailable) $('#divergence-empty').hidden=true;
      differenceTitle.hidden=comparisonTime.hidden=comparisonSelected.hidden=unavailable;
      if (unavailable && $('#timeline-empty').dataset.state !== 'unavailable') $('#timeline-empty').hidden=true;
      activityTitle.textContent=t('allowance.simple.activity'); differenceTitle.textContent=t('allowance.simple.historyDifference');
      close.textContent=t('dashboard.overview.close'); comparisonTime.setAttribute('aria-label', t('trends.explore'));
      root.querySelectorAll('[data-allowance-open]').forEach(b=>{b.textContent=t(`allowance.simple.${b.dataset.allowanceOpen}`);});
      if (modal) title.textContent=t(`allowance.simple.${modal}`);
      const points=next.points.filter(p=>Number.isFinite(p.timestampMs));
      comparisonTime.disabled=!points.length;
      if(points.length){comparisonTime.min=points[0].timestampMs;comparisonTime.max=points.at(-1).timestampMs;comparisonTime.step=60_000;}
      const lastObservation=Date.parse(next.observations[0]?.observedAt);
      renderTables();
      if(changedReport&&modal==='inspect'&&inspected){
        const state=inspected;
        const source=state.key==='intervals'?next.weeklyApi?.rows:state.key==='records'?next.observations:next.events;
        const row=source?.find(row=>state.key==='intervals'?row.startMs===state.startMs:state.key==='records'?row.observedAt===state.observedAt:row.timestampMs===state.timestampMs);
        if(row){const scroll=dialog.scrollTop;inspect(state.key,row);dialog.scrollTop=scroll;}
        else open(state.key);
      }
      select(selectedAt ?? points.at(-1)?.timestampMs ?? (Number.isFinite(lastObservation) ? lastObservation : next.endMs));
    },
    close() {if(dialog.open)dialog.close();},
    open,
  };
}
