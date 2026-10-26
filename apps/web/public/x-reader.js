// The desktop service owns authentication, fetching, storage and resource authorization.
// This module only renders its closed DTOs; provider HTML never enters this DOM.
export const X_READER_COPY = {
  'en-US': {
    moreReplies:"Load more replies",
    repliesMoreFailed:"Could not load more replies. Retry or refresh the post.",
    repliesEnd:"All currently visible replies have been loaded",
    repliesUnknown:"No replies read yet. You can continue loading.",
    sessionBridge:"Check the local bridge",
    sessionWaiting:"In your signed-in Chrome X tab, click “Import current X session”.",
    sessionValidating:"Validate imported data",
    sessionPreparing:"Prepare an isolated login session",
    sessionWriting:"Write the candidate session",
    sessionConnecting:"Connect to X",
    sessionVerifying:"Verify X login",
    sessionSaving:"Save login state",
    sessionComplete:"Login successful",
    sessionChallenge:"Complete verification in X",
    sessionOpen:"Open X window",
    sessionFailureAt:"Failed step: ",
    import_expired:"Import authorization expired. Select Session login again.",
    import_bridge_failed:"The local bridge is unavailable. Check the extension and bridge setup.",
    login_failed:"Could not complete X login. Try again or choose another method.",
    login_timeout:"Login timed out. Try again or choose another method.",import_failed:"Could not import the X session.",invalid_import:"The imported session is invalid.",no_logged_in_session:"No signed-in X session was found in Chrome.",proxy_failed:"Could not connect through the X proxy.",
    session_permission_failed:"Cannot access the saved X session. Its folder permissions need repair.",
    session_profile_limit:"The X session exceeds its safe preparation limit or cache cleanup is incomplete. Retry; saved login and posts are preserved.",
    session_write_failed:"Could not write the X session. The previous login is preserved.",
    session_persist_failed:"Could not save the X session to disk. Login may not survive a restart.",
    session_read_failed:"Could not read the saved X session. Saved posts are still available.",
    session_decrypt_failed:"X session decryption is unavailable. The saved session has been preserved.",
    session_restore_failed:"Could not restore the saved X session. The cause could not be determined; it has not been treated as an expired login.",
    session_clear_failed:"Could not fully clear the local X session. Please retry.",
    storage_unavailable:"X local storage is unavailable. Saved data has been preserved.",
    title:'X updates', posts:'Posts', replies:'Replies', reposts:'Reposts', media:'Media', settings:'Settings', refresh:'Refresh',
    loading:'Loading…', empty:'No posts yet', failed:'Could not read updates', offline:'Cannot connect to X. Check the network or proxy.',
    rate_limited:'Requests paused due to rate limiting', parser_changed:'X changed its page format', stale:'Showing saved posts',
    disconnected:'Choose a login method', restoring:'Checking login…', authorizing:'Complete login in the X window',
    expired:'Login expired', challenge:'Verification required', ready:'Connected', login:'Log in', web:'Web login', session:'Session login',
    sessionHint:'Import from a signed-in Chrome profile', back:'Back', otherLogin:'Back, choose another method', retry:'Retry',
    importSetup:'Configure Chrome import', importHint:'Load the extension in Chrome, check the local connection, then import from your signed-in X tab.',
    importBridgeReady:'Local bridge is ready',importWaiting:'Waiting for Chrome session import',importFailed:'Could not configure the local bridge',importNotConfigured:'Local bridge is not configured',
    newPosts:'New updates', more:'Load more', fullLoading:'Fetching full text…', fullFailed:'Could not fetch full text', repliesLoading:'Loading replies…', repliesFailed:'Could not load replies', repliesEmpty:'No replies yet',
    close:'Close', image:'View image', mediaFailed:'Could not load media', unknownTime:'Time unavailable',
    logout:'Log out', interval:'Refresh interval', intervalHint:'-1 disables automatic refresh', minutes:'minutes',
    proxy:'Proxy', system:'System proxy', local:'Local port', port:'Local proxy port', notifyPosts:'Post notifications',
    notifyReplies:'Reply notifications', cache:'Cache', clearCache:'Clear cache', save:'Save', saved:'Saved',
    invalid:'Enter positive whole minutes or -1, and a port from 1 to 65535.', confirmClear:'Clear saved X posts? Your login is kept.',
    confirmLogout:'Log out of X in this app? Chrome is unaffected.', cacheUnknown:'Size unavailable', notificationUnavailable:'System notifications unavailable',
  },
  'zh-Hans': {
    moreReplies:"加载更多回复",
    repliesMoreFailed:"未能继续加载回复，请重试或刷新帖子。",
    repliesEnd:"当前可见回复已加载完",
    repliesUnknown:"尚未读取到回复，可继续加载。",
    sessionBridge:"检查本机桥接",
    sessionWaiting:"请在已登录的 Chrome X 标签页中点击“导入当前 X 会话”。",
    sessionValidating:"校验导入数据",
    sessionPreparing:"准备独立登录会话",
    sessionWriting:"写入候选会话",
    sessionConnecting:"连接 X",
    sessionVerifying:"验证 X 登录",
    sessionSaving:"保存登录状态",
    sessionComplete:"登录成功",
    sessionChallenge:"需要在 X 完成验证",
    sessionOpen:"打开 X 窗口",
    sessionFailureAt:"失败步骤：",
    import_expired:"导入授权已过期，请重新选择 Session 登录。",
    import_bridge_failed:"本机桥接不可用，请检查扩展与桥接配置。",
    login_failed:"未能完成 X 登录，请重试或选择其他方式。",
    login_timeout:"登录超时，请重试或选择其他方式。",import_failed:"X 会话导入失败。",invalid_import:"导入的会话无效。",no_logged_in_session:"未找到 Chrome 中已登录的 X 会话。",proxy_failed:"无法通过代理连接 X。",
    session_permission_failed:"无法访问已保存的 X 会话，请修复会话目录权限。",
    session_profile_limit:"X 会话超出安全处理范围，或缓存清理尚未完成。请重试；已保存的登录和动态仍保留。",
    session_write_failed:"无法写入 X 会话，已保留原有登录。",
    session_persist_failed:"无法将 X 会话保存到磁盘，重启后可能无法恢复登录。",
    session_read_failed:"无法读取已保存的 X 会话，仍可阅读已缓存的内容。",
    session_decrypt_failed:"X 会话解密不可用，已保留保存的会话。",
    session_restore_failed:"无法恢复已保存的 X 会话，原因尚不明确，未将其判定为登录过期。",
    session_clear_failed:"未能完整清除本机 X 会话，请重试。",
    storage_unavailable:"X 本地存储不可用，已保留原有数据。",
    title:'X 动态', posts:'帖子', replies:'回复', reposts:'转帖', media:'媒体', settings:'设置', refresh:'刷新',
    loading:'正在加载…', empty:'暂无动态', failed:'读取失败', offline:'无法连接 X，请检查网络或代理。',
    rate_limited:'请求受限，已暂停获取', parser_changed:'X 页面结构发生变化，暂时无法读取', stale:'显示已保存的内容',
    disconnected:'选择登录方式', restoring:'正在检查登录…', authorizing:'请在 X 窗口完成登录',
    expired:'登录已失效', challenge:'需要完成验证', ready:'已连接', login:'登录', web:'网页登录', session:'Session 登录',
    sessionHint:'从已登录的 Chrome 导入', back:'返回', otherLogin:'返回，选择其他方式', retry:'重试',
    importSetup:'配置 Chrome 导入', importHint:'在 Chrome 加载扩展，点击扩展内的“检查本机连接”，再从已登录的 X 标签页导入。',
    importBridgeReady:'本机桥接已就绪',importWaiting:'等待从 Chrome 导入会话',importFailed:'本机桥接配置失败',importNotConfigured:'尚未配置本机桥接',
    newPosts:'有新动态', more:'加载更多', fullLoading:'正在获取全文…', fullFailed:'全文获取失败', repliesLoading:'正在加载评论…', repliesFailed:'评论加载失败', repliesEmpty:'暂无评论',
    close:'关闭', image:'查看图片', mediaFailed:'媒体加载失败', unknownTime:'时间未知',
    logout:'退出登录', interval:'刷新间隔', intervalHint:'-1 不自动刷新', minutes:'分钟',
    proxy:'代理', system:'系统代理', local:'独立端口', port:'本地代理端口', notifyPosts:'发帖通知',
    notifyReplies:'回复通知', cache:'缓存', clearCache:'清除缓存', save:'保存', saved:'已保存',
    invalid:'请输入正整数分钟或 -1，端口为 1–65535。', confirmClear:'清除已保存的 X 内容？登录会保留。',
    confirmLogout:'退出本应用的 X 登录？Chrome 不受影响。', cacheUnknown:'占用未知', notificationUnavailable:'系统通知不可用',
  },
  es: {
    moreReplies:"Cargar más respuestas",
    repliesMoreFailed:"No se pudieron cargar más respuestas. Reintenta o actualiza la publicación.",
    repliesEnd:"Se han cargado todas las respuestas visibles actualmente",
    repliesUnknown:"Aún no se han leído respuestas. Puedes seguir cargando.",
    sessionBridge:"Comprobar el puente local",
    sessionWaiting:"En tu pestaña X de Chrome con sesión iniciada, pulsa «Importar sesión X actual».",
    sessionValidating:"Validar los datos importados",
    sessionPreparing:"Preparar una sesión aislada",
    sessionWriting:"Escribir la sesión candidata",
    sessionConnecting:"Conectar a X",
    sessionVerifying:"Verificar el inicio de sesión X",
    sessionSaving:"Guardar la sesión",
    sessionComplete:"Inicio de sesión correcto",
    sessionChallenge:"Completa la verificación en X",
    sessionOpen:"Abrir ventana de X",
    sessionFailureAt:"Paso fallido: ",
    import_expired:"La autorización ha caducado. Elige de nuevo la importación de sesión.",
    import_bridge_failed:"El puente local no está disponible. Comprueba la extensión y su configuración.",
    login_failed:"No se pudo completar el inicio de sesión X. Reintenta o elige otro método.",
    login_timeout:"El inicio de sesión agotó el tiempo. Reintenta o elige otro método.",import_failed:"No se pudo importar la sesión X.",invalid_import:"La sesión importada no es válida.",no_logged_in_session:"No se encontró una sesión X iniciada en Chrome.",proxy_failed:"No se pudo conectar a X mediante el proxy.",
    session_permission_failed:"No se puede acceder a la sesión X guardada. Es necesario reparar los permisos de su carpeta.",
    session_profile_limit:"La sesión X supera el límite seguro o la limpieza de caché está incompleta. Reintenta; se conservan el inicio de sesión y las publicaciones.",
    session_write_failed:"No se pudo escribir la sesión X. Se conserva el inicio de sesión anterior.",
    session_persist_failed:"No se pudo guardar la sesión X en disco. Es posible que no se restaure al reiniciar.",
    session_read_failed:"No se pudo leer la sesión X guardada. El contenido guardado sigue disponible.",
    session_decrypt_failed:"El descifrado de la sesión X no está disponible. Se conserva la sesión guardada.",
    session_restore_failed:"No se pudo restaurar la sesión X. Se desconoce la causa; no se ha considerado caducada.",
    session_clear_failed:"No se pudo borrar por completo la sesión X local. Vuelve a intentarlo.",
    storage_unavailable:"El almacenamiento local de X no está disponible. Se conservan los datos.",
    title:'Novedades de X',posts:'Publicaciones',replies:'Respuestas',reposts:'Republicaciones',media:'Multimedia',settings:'Ajustes',refresh:'Actualizar',
    loading:'Cargando…',empty:'Todavía no hay publicaciones',failed:'No se pudieron leer las novedades',offline:'No se puede conectar a X. Comprueba la red o el proxy.',
    rate_limited:'Solicitudes pausadas por el límite de frecuencia',parser_changed:'X cambió el formato de su página',stale:'Mostrando contenido guardado',
    disconnected:'Elige cómo iniciar sesión',restoring:'Comprobando la sesión…',authorizing:'Completa el inicio de sesión en la ventana de X',
    expired:'La sesión ha caducado',challenge:'Se requiere verificación',ready:'Conectado',login:'Iniciar sesión',web:'Inicio de sesión web',session:'Importar sesión',
    sessionHint:'Importar desde un perfil de Chrome con sesión iniciada',back:'Volver',otherLogin:'Volver y elegir otro método',retry:'Reintentar',
    importSetup:'Configurar importación de Chrome',importHint:'Carga la extensión en Chrome, comprueba la conexión local e importa desde tu pestaña de X con sesión iniciada.',
    importBridgeReady:'El puente local está listo',importWaiting:'Esperando la importación de la sesión de Chrome',importFailed:'No se pudo configurar el puente local',importNotConfigured:'El puente local no está configurado',
    newPosts:'Hay novedades',more:'Cargar más',fullLoading:'Obteniendo el texto completo…',fullFailed:'No se pudo obtener el texto completo',repliesLoading:'Cargando respuestas…',repliesFailed:'No se pudieron cargar las respuestas',repliesEmpty:'Todavía no hay respuestas',
    close:'Cerrar',image:'Ver imagen',mediaFailed:'No se pudo cargar el contenido multimedia',unknownTime:'Hora no disponible',
    logout:'Cerrar sesión',interval:'Intervalo de actualización',intervalHint:'-1 desactiva la actualización automática',minutes:'minutos',
    proxy:'Proxy',system:'Proxy del sistema',local:'Puerto independiente',port:'Puerto del proxy local',notifyPosts:'Avisos de publicaciones',
    notifyReplies:'Avisos de respuestas',cache:'Caché',clearCache:'Borrar caché',save:'Guardar',saved:'Guardado',
    invalid:'Introduce minutos enteros positivos o -1, y un puerto del 1 al 65535.',confirmClear:'¿Borrar las publicaciones guardadas de X? Se conservará la sesión.',
    confirmLogout:'¿Cerrar la sesión de X en esta aplicación? No afecta a Chrome.',cacheUnknown:'Tamaño no disponible',notificationUnavailable:'Avisos del sistema no disponibles',
  },
};
const TABS = ['posts','replies','reposts','media'];
const AUTH = ['disconnected','restoring','authorizing','ready','expired','challenge'];
const OPERATIONS = ['idle','loading','offline','rate_limited','error','parser_changed'];
const SESSION_ERRORS = new Set(['session_profile_limit','session_permission_failed','session_write_failed','session_persist_failed','session_read_failed','session_decrypt_failed','session_restore_failed','session_clear_failed','storage_unavailable']);
const STATUS_ERRORS = new Set([...SESSION_ERRORS,'import_expired','import_bridge_failed','login_failed','login_timeout','import_failed','invalid_import','no_logged_in_session','proxy_failed','offline','rate_limited','expired','challenge','parser_changed','pagination_pending']);
const errorCopy = code => code==='pagination_pending'?'failed':STATUS_ERRORS.has(code)?code:null;
function sessionFailureKey(value) {
  if (STATUS_ERRORS.has(value?.code)) return errorCopy(value.code);
  // IPC errors may retain only their fixed message, with Electron's prefix.
  const match = typeof value?.message === 'string' ? value.message.match(/\b(session_profile_limit|session_permission_failed|session_write_failed|session_persist_failed|session_read_failed|session_decrypt_failed|session_restore_failed|session_clear_failed|storage_unavailable|import_expired|import_bridge_failed|login_failed|login_timeout|import_failed|invalid_import|no_logged_in_session|proxy_failed|offline|rate_limited|expired|challenge|parser_changed|pagination_pending)\b/u) : null;
  return errorCopy(match?.[1]);
}
const LOGIN_STAGE_COPY = Object.freeze({checking_bridge:'sessionBridge',waiting_import:'sessionWaiting',validating:'sessionValidating',preparing:'sessionPreparing',writing:'sessionWriting',connecting:'sessionConnecting',verifying:'sessionVerifying',challenge:'sessionChallenge',saving:'sessionSaving',complete:'sessionComplete'});
const loginError = value => errorCopy(value.error) ?? (value.auth==='authorizing'&&value.loginMethod==='session'?errorCopy(value.import?.failure):null);
const failedStage = value => loginError(value) ? LOGIN_STAGE_COPY[value.loginFailureStage] ?? (value.auth==='authorizing'&&value.loginMethod==='session'&&value.import?.failure ? 'sessionValidating' : null) : null;
const ID = /^[0-9]{1,25}$/u;
function translator(options) {
  return key => {const locale=String(options.locale??options.documentRef?.documentElement?.lang??'zh-Hans');return options.translate?.(`x.${key}`)??X_READER_COPY[locale.startsWith('zh')?'zh-Hans':locale.startsWith('es')?'es':'en-US'][key]??key;};
}
function safeResource(value) {
  if(typeof value !== 'string' || value.length > 2048) return null;
  try { const url=new URL(value); return url.protocol==='usagemonitor-x-media:' && url.hostname==='resource' && /^\/[a-zA-Z0-9_-]{1,160}$/u.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash ? value : null; } catch { return null; }
}
export function normalizeXPost(value, depth=0) {
  if(!value || !ID.test(value.id ?? '') || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.text!=='string' || !value.author || depth>1) return null;
  const media=(Array.isArray(value.media)?value.media:[]).slice(0,12).flatMap(item=>{
    const src=safeResource(item?.src);
    return src && ['image','video','gif'].includes(item.type) ? [{id:String(item.id??'').slice(0,128),type:item.type,src,poster:safeResource(item.poster),mimeType:['video/mp4','application/x-mpegURL','application/vnd.apple.mpegurl','image/gif','image/jpeg','image/png','image/webp'].includes(item.mimeType)?item.mimeType:null}] : [];
  });
  return {id:value.id,createdAt:new Date(value.createdAt).toISOString(),text:value.text.slice(0,100000),complete:value.complete===true,
    kind:['post','reply','repost'].includes(value.kind)?value.kind:'post', author:{name:String(value.author.name??'').slice(0,160),handle:String(value.author.handle??'').replace(/^@/u,'').slice(0,64),avatar:safeResource(value.author.avatar)},media,
    quotedPost:depth===0?normalizeXPost(value.quotedPost,1):null};
}
export function formatXClocks(instant, deviceZone=Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const date=new Date(instant); if(!Number.isFinite(date.getTime())) return null;
  const clock=zone=>{
    const fields=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));
    const zoneLabel=zone==='Asia/Tokyo'?'JST':fields.timeZoneName;
    return `${zoneLabel} ${fields.hour}:${fields.minute} ${fields.month}/${fields.day}`;
  };
  try {return `${clock(deviceZone)}   ${clock('America/Los_Angeles')}`;} catch {return null;}
}
export function validateXSettings(value) {
  return !!value && Number.isSafeInteger(value.refreshMinutes) && (value.refreshMinutes===-1 || value.refreshMinutes>0) &&
    ['system','local'].includes(value.proxyMode) && Number.isInteger(value.proxyPort) && value.proxyPort>=1 && value.proxyPort<=65535 &&
    typeof value.notifyPosts==='boolean' && typeof value.notifyReplies==='boolean';
}
function helpers(documentRef) {
  const node=(tag,cls,text)=>{const result=documentRef.createElement(tag);if(cls)result.className=cls;if(text!==undefined)result.textContent=text;return result;};
  const button=(text,run,cls='')=>{const result=node('button',cls,text);result.type='button';result.addEventListener('click',run);return result;};
  return {node,button};
}
export function mountXReader(options) {
  const {container,bridge,onOpenSettings=()=>{},documentRef=container.ownerDocument,loadHls}=options;
  const translationOptions={...options,documentRef},t=translator(translationOptions),{node,button}=helpers(documentRef),win=documentRef.defaultView??globalThis;
  const root=node('section','x-reader'),toolbar=node('div','x-reader-toolbar'),tabs=node('div','x-reader-tabs'),statusLine=node('div','x-reader-status'),loginPanel=node('div','x-reader-login'),content=node('div','x-reader-scroll');
  const pageFooter=node('div','x-reader-page-footer');
  root.setAttribute('aria-label',t('title'));tabs.setAttribute('role','tablist');statusLine.setAttribute('role','status');statusLine.setAttribute('aria-live','polite');
  const iconButton=(key,run,cls)=>{const control=button('',run,`x-reader-icon ${cls}`);control.title=t(key);control.setAttribute('aria-label',t(key));return control;};
  const refresh=iconButton('refresh',()=>void refreshVisible(),'x-reader-refresh');
  const settings=iconButton('settings',onOpenSettings,'x-reader-settings'),newPosts=button(t('newPosts'),()=>{pendingItems=null;content.scrollTop=0;void loadList();},'x-reader-new');newPosts.hidden=true;
  const backSlot=node('div','x-reader-back-slot'),back=iconButton('back',()=>{const parent=detailTrail.pop();detail=parent?.detail??null;++detailRequest;renderContent();content.scrollTop=parent?.scroll??detailScroll;},'x-reader-back');back.hidden=true;backSlot.append(back);
  toolbar.append(backSlot,tabs,refresh,settings);root.append(toolbar,statusLine,loginPanel,newPosts,content);container.append(root);
  const records=new Map(TABS.map(tab=>[tab,{items:[],cursor:null,scroll:0,loaded:false}])),full=new Map(),fullFailed=new Set(),autoTried=new Set(),queued=new Set(),mediaCleanups=new Set(),renderedPosts=new Map();
  // Until the first service response, login is unknown rather than absent.
  let active='posts',shown=false,disposed=false,status={auth:'restoring',operation:'idle'},generation=0,listRequest=0,detailRequest=0,detail=null,detailScroll=0,detailTrail=[],pollTimer=null,fullActive=0,loginMethod=null,loginChoiceOpen=false,importSetupError=false,pendingItems=null,updatedAt=null,loading=false,viewer=null;
  const tabButtons=new Map();
  for(const tab of TABS){const control=button(t(tab),()=>switchTab(tab),'x-reader-tab');control.setAttribute('role','tab');control.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?TABS.length-1:(TABS.indexOf(active)+(event.key==='ArrowRight'?1:TABS.length-1))%TABS.length;switchTab(TABS[next]);tabButtons.get(TABS[next]).focus();});tabButtons.set(tab,control);tabs.append(control);}
  function stopMedia(){for(const cleanup of mediaCleanups)cleanup();mediaCleanups.clear();closeViewer();}
  function closeViewer(){viewer?.remove();viewer=null;}
  function escape(event){if(event.key==='Escape'&&viewer)closeViewer();}
  documentRef.addEventListener('keydown',escape);
  // Check the actual scrollport after layout/state changes, sharing the same
  // single-flight and request-generation guards as manual pagination.
  // Pagination authority stays upstream: desktop-x-page-adapter interprets X's
  // main-timeline vs branch termination, and desktop-x-service turns that into
  // opaque continuation handles (or null when nothing remains to deliver).
  // These are service handles, not raw X cursors: X can return a nonempty cursor
  // alongside an explicit end, and the service may still have cached list pages
  // to deliver after the upstream timeline ends. Do not resolve those cases
  // again here using hasMore/repliesExhausted or raw-response heuristics. A
  // second renderer policy would drift from the service and could skip cached
  // pages or repeatedly request a completed timeline. Fix contradictions at the
  // adapter/service boundary and test that contract there. The renderer only
  // follows the returned handle; repliesExhausted controls the end message,
  // while moreFailed/no-progress pauses retries without declaring a new end.
  let pageCheckQueued=false;
  function checkNextPage(){
    if(!shown||disposed||loading||status.auth!=='ready'||status.operation==='loading'||!(content.clientHeight>0)||content.scrollHeight-pageFooter.offsetHeight-content.scrollTop-content.clientHeight>0)return;
    if(detail){if(!detail.loading&&!detail.failed&&!detail.moreFailed&&detail.nextCursor)void loadMoreReplies();}
    else {const record=records.get(active);if(record.loaded&&record.cursor&&!record.moreFailed)void loadList({append:true});}
  }
  function scheduleNextPage(){if(pageCheckQueued)return;pageCheckQueued=true;Promise.resolve().then(()=>{pageCheckQueued=false;checkNextPage();});}
  content.addEventListener('scroll',scheduleNextPage,{passive:true});
  content.addEventListener('load',scheduleNextPage,true);
  const pageResize=typeof win.ResizeObserver==='function'?new win.ResizeObserver(scheduleNextPage):null;
  pageResize?.observe(content);
  function setStatus(value){if(!value)return;const previous=status.auth;status={...value,auth:AUTH.includes(value.auth)?value.auth:'disconnected',operation:OPERATIONS.includes(value.operation)?value.operation:'error'};if(['authorizing','challenge'].includes(status.auth)&&['web','session'].includes(status.loginMethod))loginMethod=status.loginMethod;else if(previous==='authorizing'&&status.auth!=='authorizing')loginMethod=null;renderStatus();}
  function renderStatus(){
    const operation=status.operation==='error'?'failed':status.operation;
    const hasItems=records.get(active).items.length>0;
    const showLoginPanel=status.auth!=='ready'&&status.auth!=='restoring'&&(!hasItems||loginMethod||loginChoiceOpen);
    const emptyMessage=[...content.children].find(child=>child.className==='x-reader-empty');if(emptyMessage)emptyMessage.hidden=status.auth!=='ready';
    const key=loginError(status)??(operation!=='idle'?operation:showLoginPanel?null:status.auth==='ready'?(status.loginStage==='complete'?'sessionComplete':updatedAt?null:'ready'):status.auth);
    statusLine.replaceChildren();if(key&&!(showLoginPanel&&loginMethod==='session'&&key==='authorizing')){const phase=failedStage(status);statusLine.append(node('span','',`${phase?t('sessionFailureAt')+t(phase)+' · ':''}${t(key)}`));}if(records.get(active).source==='cache'&&status.operation!=='offline')statusLine.append(node('span','x-reader-muted',t('stale')));
    if(updatedAt && operation!=='loading'){const timestamp=node('time','x-reader-muted',new Date(updatedAt).toLocaleString(options.locale));timestamp.dateTime=updatedAt;statusLine.append(timestamp);}
    if(!showLoginPanel&&['expired','challenge','disconnected'].includes(status.auth))statusLine.append(button(t('login'),()=>{loginMethod=null;loginChoiceOpen=true;renderStatus();}));
    if(['offline','error','parser_changed'].includes(status.operation))statusLine.append(button(t('retry'),()=>void refreshVisible()));
    if(!detail&&records.get(active).moreFailed&&status.operation!=='loading')statusLine.append(node('span','x-reader-muted',t('failed')));
    const refreshing=loading||Boolean(detail?.loading)||status.operation==='loading';refresh.disabled=refreshing||Boolean(detail?.moreLoading);refresh.classList.toggle('is-loading',refreshing);
    refresh.setAttribute('aria-busy',String(refreshing));
    const moreButton=[...pageFooter.children].find(child=>child.className==='x-reader-more');if(moreButton){moreButton.disabled=loading||status.operation==='loading';moreButton.setAttribute('aria-busy',String(moreButton.disabled));moreButton.setAttribute('aria-live','polite');moreButton.textContent=t(moreButton.disabled?'loading':'more');}
    if(status.auth==='ready'){loginMethod=null;loginChoiceOpen=false;loginPanel.hidden=true;}
    else if(showLoginPanel)renderLogin();else loginPanel.hidden=true;
  }
  function renderLogin(force=false){
    if(status.auth==='ready'&&!force){loginPanel.hidden=true;return;}
    loginPanel.hidden=false;loginPanel.replaceChildren();
    if(!loginMethod){loginPanel.append(node('p','',t(['expired','challenge'].includes(status.auth)?status.auth:'disconnected')),
      button(t('web'),()=>void startLogin('web')),button(t('session'),()=>void startLogin('session')),node('small','x-reader-muted',t('sessionHint')));return;}
    const importCode=status.import?.code;
    const loginState=loginMethod!=='session'?'authorizing':status.import?.configured===false?'importNotConfigured':LOGIN_STAGE_COPY[status.loginStage]??(status.import?.importing?'sessionValidating':['verification_pending','imported'].includes(importCode)?'sessionVerifying':'importWaiting');
    loginPanel.append(node('p','',t(loginState)),button(t('otherLogin'),()=>void cancelLogin()));
    if(loginMethod==='session'){
      if(status.loginStage==='challenge')loginPanel.append(button(t('sessionOpen'),()=>void startLogin('web')));
      if(!status.loginStage||['checking_bridge','waiting_import'].includes(status.loginStage))loginPanel.append(node('p','x-reader-muted',t('importHint')),button(t('importSetup'),async()=>{
        const token=generation;try{const result=await bridge.configureXImport();if(token!==generation||!shown)return;const resultImport=result?.import??result;importSetupError=resultImport?.configured===false;status.import=resultImport;renderLogin();}catch{if(token===generation&&shown){importSetupError=true;renderLogin();}}
      }));
      const extensionDirectory=status.import?.extensionDirectory??status.bridge?.extensionDirectory;if(typeof extensionDirectory==='string'&&(!status.loginStage||['checking_bridge','waiting_import'].includes(status.loginStage)))loginPanel.append(node('p','x-reader-import-path',extensionDirectory));
      const connection=status.import?.code;
      const connectionKey=importSetupError?'importFailed':({bridge_ready:'importBridgeReady',import_ready:'importWaiting',bridge_unavailable:'importFailed',not_configured:'importNotConfigured'})[connection];
      if(connectionKey&&!(connectionKey==='importWaiting'&&status.loginStage==='waiting_import')&&(!status.loginStage||['checking_bridge','waiting_import'].includes(status.loginStage)))loginPanel.append(node('p','x-reader-muted',t(connectionKey)));
    }
  }
  async function startLogin(method){const token=++generation;loginMethod=method;importSetupError=false;renderLogin();try{const result=await bridge.beginXLogin({method});if(token!==generation||!shown)return;setStatus(result?.status??result);if(status.auth==='ready')await loadList();}catch(error){if(token===generation&&shown){setStatus({...status,operation:'error',error:sessionFailureKey(error)??status.error});}}schedulePoll();}
  async function cancelLogin(){++generation;loginMethod=null;await bridge.cancelXLogin().catch(()=>{});if(shown&&!disposed){renderLogin(true);void poll();}}
  async function poll(){const token=generation;try{const value=await bridge.getXStatus();if(token!==generation||!shown)return;const previous=status.auth,previousUpdate=status.lastUpdated;setStatus(value?.status??value);if(status.auth==='ready'&&!loading&&!detail&&(previous!=='ready'||status.lastUpdated&&status.lastUpdated!==previousUpdate))await loadList({background:previous==='ready'});}catch(error){if(token===generation&&shown)setStatus({...status,operation:'error',error:sessionFailureKey(error)??status.error});}finally{schedulePoll();}}
  function schedulePoll(){if(pollTimer)win.clearTimeout(pollTimer);pollTimer=null;if(shown&&!disposed)pollTimer=win.setTimeout(()=>void poll(),status.auth==='authorizing'?2000:15000);}
  function normalizeItems(items){return (Array.isArray(items)?items:[]).map(value=>normalizeXPost(value)).filter(Boolean);}
  async function loadList({append=false,background=false,force=false}={}){
    if(append&&loading)return;
    const tab=active,record=records.get(tab),request=++listRequest,token=generation;
    if(append&&!record.cursor)return;const previousCount=record.items.length;loading=true;renderStatus();
    try{if(force){const refreshed=await bridge.refreshX({tab});if(token!==generation||request!==listRequest||!shown||tab!==active||detail)return;if(refreshed?.status){setStatus(refreshed.status);if(refreshed.status.operation!=='idle'){record.moreFailed=true;return;}}}const result=await bridge.listXPosts({tab,...(append?{cursor:record.cursor}:{})});if(token!==generation||request!==listRequest||!shown||tab!==active||detail)return;
      const incoming=normalizeItems(result.items);if(result.status)setStatus(typeof result.status==='object'?result.status:{...status,operation:result.status});
      const resultTime=result.updatedAt??result.status?.lastUpdated;if(typeof resultTime==='string'&&Number.isFinite(Date.parse(resultTime)))updatedAt=resultTime;
      if(background&&!force&&content.scrollTop>32&&record.loaded&&incoming.some(item=>!record.items.some(old=>old.id===item.id))){pendingItems=incoming;newPosts.hidden=false;return;}
      const keepTail=background&&incoming.length>0&&record.loaded&&record.items.length>incoming.length;
      const items=append?[...record.items,...incoming]:background&&incoming.length?[...incoming,...record.items.filter(old=>!incoming.some(item=>item.id===old.id))]:incoming;record.items=[...new Map(items.map(item=>[item.id,item])).values()];const cursor=result.nextCursor??result.cursor;if(!keepTail)record.cursor=typeof cursor==='string'?cursor:append&&!incoming.length&&result.hasMore!==false?record.cursor:null;record.loaded=true;record.source=result.source;
      if(append)record.moreFailed=Boolean(record.cursor)&&(record.items.length===previousCount||result.outcome==='failed');else if(force||!background)record.moreFailed=false;
      const scroll=force?0:content.scrollTop;renderContent({preserve:true});content.scrollTop=scroll;newPosts.hidden=true;pendingItems=null;prefetch();
    }catch(error){if(token===generation&&request===listRequest&&shown){if(append)record.moreFailed=true;setStatus({...status,operation:'error',error:sessionFailureKey(error)??status.error});if(!record.items.length)renderContent();}}
    finally{if(request===listRequest){loading=false;if(shown){renderStatus();scheduleNextPage();}}}
  }
  async function refreshVisible(){
    if(loading||detail?.loading||detail?.moreLoading||!shown)return;
    // Capture the target before awaiting. Normal request generations prevent a
    // refresh completed after navigation from reopening or replacing that view.
    if(detail)await openDetail(detail.id,{force:true});
    else await loadList({force:true,background:true});
  }
  function switchTab(tab){if(active===tab&&!detail)return;records.get(active).scroll=detail?detailScroll:content.scrollTop;detail=null;detailTrail=[];++detailRequest;++listRequest;loading=false;stopMedia();active=tab;newPosts.hidden=true;pendingItems=null;renderContent();content.scrollTop=records.get(tab).scroll;if(!records.get(tab).loaded)void loadList();else prefetch();}
  function addMedia(parent,items){
    for(const item of items){const wrap=node('div','x-reader-media');let element;
      if(item.type==='image'){element=node('img');element.src=item.src;element.loading='lazy';element.alt=t('image');element.tabIndex=0;const open=()=>{closeViewer();viewer=node('div','x-reader-image-viewer');viewer.setAttribute('role','dialog');viewer.setAttribute('aria-modal','true');const image=node('img');image.src=item.src;image.alt=t('image');const close=button(t('close'),()=>{closeViewer();element.focus();});viewer.append(close,image);root.append(viewer);close.focus();};element.addEventListener('click',event=>{event.stopPropagation();open();});element.addEventListener('keydown',event=>{if(event.key==='Enter'){event.stopPropagation();open();}});}
      else {element=node('video');element.controls=true;element.preload='none';element.autoplay=false;element.playsInline=true;if(item.poster)element.poster=item.poster;
        let player=null,cancelled=false;const cleanup=()=>{if(cancelled)return;cancelled=true;element.pause();player?.destroy?.();element.removeAttribute('src');element.load();};mediaCleanups.add(cleanup);
        const hls=['application/x-mpegURL','application/vnd.apple.mpegurl'].includes(item.mimeType);
        if(hls&&!element.canPlayType('application/vnd.apple.mpegurl')){
          let preparing=false;
          const prepare=async()=>{if(player||cancelled||preparing)return;preparing=true;try{const Hls=loadHls?await loadHls():win.Hls;if(cancelled)return;if(!Hls?.isSupported?.())throw new Error('unsupported');player=new Hls({autoStartLoad:true});player.loadSource(item.src);player.attachMedia(element);if(Hls.Events?.ERROR)player.on(Hls.Events.ERROR,(_event,data)=>{if(data?.fatal&&!cancelled)wrap.append(node('p','x-reader-muted',t('mediaFailed')));});}catch{if(!cancelled)wrap.append(node('p','x-reader-muted',t('mediaFailed')));}};
          element.addEventListener('play',prepare,{once:true});
          // With no source, HTML video cannot emit play: initialize lazily on pointer/keyboard intent.
          element.addEventListener('pointerdown',prepare,{once:true});element.addEventListener('keydown',prepare,{once:true});
        }else element.src=item.src;
        element.addEventListener('click',event=>event.stopPropagation());element.addEventListener('keydown',event=>event.stopPropagation());
      }
      element.addEventListener('error',()=>{if(!wrap.querySelector('p'))wrap.append(node('p','x-reader-muted',t('mediaFailed')));});wrap.append(element);parent.append(wrap);
    }
  }
  function card(value,{clickable=true,quoted=false}={}){
    const previousCleanups=new Set(mediaCleanups),post=full.get(value.id)??value,article=node('article',quoted?'x-reader-post x-reader-quote':'x-reader-post'),header=node('div','x-reader-byline');
    if(post.author.avatar){const avatar=node('img','x-reader-avatar');avatar.src=post.author.avatar;avatar.alt='';avatar.loading='lazy';header.append(avatar);}
    const time=node('time','x-reader-muted',formatXClocks(post.createdAt,options.deviceTimeZone)??t('unknownTime'));time.dateTime=post.createdAt;
    const body=node('p','x-reader-body',post.text);header.append(node('strong','',post.author.name),node('span','x-reader-muted',`@${post.author.handle}`),time);article.append(header,body);
    const fullState=node('p','x-reader-muted');if(!post.complete){renderFullState(fullState,post.id);article.append(fullState);}
    addMedia(article,post.media);if(post.quotedPost)article.append(card(post.quotedPost,{clickable:false,quoted:true}));
    const ownedCleanups=[...mediaCleanups].filter(cleanup=>!previousCleanups.has(cleanup));
    const mounted=renderedPosts.get(post.id)??[];mounted.push({article,body,fullState,clickable,shape:cardShape(post),mediaIds:new Set(post.media.map(item=>item.id)),release(){for(const cleanup of ownedCleanups){cleanup();mediaCleanups.delete(cleanup);}}});renderedPosts.set(post.id,mounted);
    if(clickable){article.tabIndex=0;article.setAttribute('role','button');article.addEventListener('click',()=>void openDetail(post.id));article.addEventListener('keydown',event=>{if(event.target===article&&(event.key==='Enter'||event.key===' ')){event.preventDefault();void openDetail(post.id);}});}
    return article;
  }
  function renderFullState(element,id){element.replaceChildren(node('span','',t(fullFailed.has(id)?'fullFailed':'fullLoading')));if(fullFailed.has(id))element.append(button(t('retry'),event=>{event.stopPropagation();autoTried.delete(id);fullFailed.delete(id);enqueue(id);}));}
  function updateFullText(id){const post=full.get(id);for(const mounted of renderedPosts.get(id)??[]){if(post){mounted.body.textContent=post.text;mounted.fullState.remove();const extra=post.media.filter(item=>!mounted.mediaIds.has(item.id)),before=new Set(mediaCleanups);addMedia(mounted.article,extra);const release=mounted.release,added=[...mediaCleanups].filter(cleanup=>!before.has(cleanup));mounted.release=()=>{release();for(const cleanup of added){cleanup();mediaCleanups.delete(cleanup);}};for(const item of extra)mounted.mediaIds.add(item.id);mounted.shape=cardShape(post);}else renderFullState(mounted.fullState,id);}}
  // Status polls, pagination and detail completion must not detach an unchanged
  // player. Text may expand in place; changed media still gets a fresh player.
  function cardShape(post){return JSON.stringify([post.author,post.createdAt,post.kind,post.media,post.quotedPost]);}
  function renderContent({preserve=false}={}){
    if(!preserve){stopMedia();renderedPosts.clear();content.replaceChildren();}
    const existing=new Map([...renderedPosts].map(([id,entries])=>[id,entries.find(entry=>entry.article.parentElement===content)]));
    const children=[],retained=new Set();pageFooter.replaceChildren();
    const appendCard=(value,clickable=true)=>{const post=full.get(value.id)??value,mounted=existing.get(post.id);if(mounted&&mounted.clickable===clickable&&mounted.shape===cardShape(post)){
      mounted.body.textContent=post.text;if(post.complete)mounted.fullState.remove();else renderFullState(mounted.fullState,post.id);children.push(mounted.article);retained.add(mounted.article);
    }else children.push(card(post,{clickable}));};
    for(const[tab,control]of tabButtons){control.setAttribute('aria-selected',String(active===tab&&!detail));control.tabIndex=active===tab?0:-1;}
    back.hidden=!detail;
    if(detail){if(detail.post)appendCard(detail.post,false);else children.push(node('p','',t(detail.failed?'failed':'loading')));
      if(!detail.refreshing&&!detail.moreLoading&&(detail.loading||detail.failed||detail.cached||!detail.replies?.length)){const message=node('div','x-reader-replies-status',t(detail.loading?'repliesLoading':detail.failed?'repliesFailed':detail.cached?'stale':detail.nextCursor?'repliesUnknown':'repliesEmpty'));message.setAttribute('role','status');message.setAttribute('aria-live','polite');message.setAttribute('aria-busy',String(Boolean(detail.loading)));if(detail.failed)message.append(button(t('retry'),()=>void openDetail(detail.id)));children.push(message);}
      for(const reply of detail.replies??[])appendCard(reply);
      // Automatic continuation owns normal paging; only a failed page offers a
      // retry. Keep the footer itself mounted to preserve the scroll runway.
      if(detail.refreshing||detail.moreLoading||(!detail.loading&&!detail.failed&&detail.moreFailed)){const message=node('p','x-reader-replies-status',t(detail.refreshing||detail.moreLoading?'repliesLoading':'repliesMoreFailed'));message.setAttribute('role','status');message.setAttribute('aria-live','polite');message.setAttribute('aria-busy',String(Boolean(detail.refreshing||detail.moreLoading)));if(!detail.refreshing&&!detail.moreLoading&&detail.nextCursor)message.append(button(t('retry'),()=>void loadMoreReplies(),'x-reader-replies-retry'));pageFooter.append(message);}
      else if(!detail.nextCursor&&detail.repliesExhausted&&!detail.loading&&!detail.failed)pageFooter.append(node('p','x-reader-muted',t('repliesEnd')));}
    else {const record=records.get(active);if(!record.items.length&&status.auth==='ready')children.push(node('p','x-reader-empty',t(!record.loaded&&loading?'loading':status.operation==='error'?'failed':record.loaded?'empty':'loading')));for(const post of record.items)appendCard(post);if(record.cursor)pageFooter.append(button(t('more'),()=>void loadList({append:true}),'x-reader-more'));}
    children.push(pageFooter);
    for(const mounted of existing.values())if(mounted&&!retained.has(mounted.article))mounted.release();
    for(const child of [...content.children])if(!children.includes(child))child.remove();
    for(let index=0;index<children.length;index++){const child=children[index],at=content.children[index]??null;if(child!==at){if(child.parentElement===content&&content.moveBefore)content.moveBefore(child,at);else content.insertBefore(child,at);}}
    const attached=element=>{for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent===content)return true;return false;};
    for(const[id,entries]of renderedPosts){const kept=entries.filter(entry=>attached(entry.article));if(kept.length)renderedPosts.set(id,kept);else renderedPosts.delete(id);}
    renderStatus();scheduleNextPage();
  }
  async function openDetail(id,{force=false}={}){if(!ID.test(id)||!shown)return;if(detail&&detail.id!==id){detailTrail.push({detail:{...detail,loading:false,refreshing:false,moreLoading:false},scroll:content.scrollTop});if(detailTrail.length>32)detailTrail.shift();}if(!detail)detailScroll=content.scrollTop;const prior=detail?.id===id?detail:null;const token=generation,request=++detailRequest;++listRequest;loading=false;detail={...prior,id,post:prior?.post??full.get(id)??detail?.replies?.find(item=>item.id===id)??records.get(active).items.find(item=>item.id===id)??null,replies:prior?.replies??[],loading:true,refreshing:force,failed:false};renderContent({preserve:Boolean(prior)});if(!force)content.scrollTop=0;
    try{const value=await bridge.getXPost({id,...(force?{force:true}:{})});if(token!==generation||request!==detailRequest||!shown||detail?.id!==id)return;if(force&&(value.outcome==='failed'||value.outcome==='cache'||value.source==='cache')){detail.failed=true;detail.loading=false;detail.refreshing=false;if(value.status)setStatus(value.status);renderContent({preserve:true});return;}const post=normalizeXPost(value.post);if(post?.complete)full.set(id,post);detail={id,post:post??detail.post,replies:normalizeItems(value.replies),nextCursor:typeof value.nextCursor==='string'?value.nextCursor:null,repliesExhausted:value.repliesExhausted===true,failed:!post||value.outcome==='failed',cached:value.source==='cache'||value.outcome==='cache',loading:false};if(value.status)setStatus(value.status);if(force){for(const item of [detail.post,...detail.replies])if(item?.complete)full.set(item.id,item);}renderContent({preserve:true});if(force)content.scrollTop=0;prefetch();}
    catch(error){if(token===generation&&request===detailRequest&&shown){if(sessionFailureKey(error))setStatus({...status,operation:'error',error:sessionFailureKey(error)});detail.failed=true;detail.loading=false;detail.refreshing=false;renderContent({preserve:true});}}
  }
  async function loadMoreReplies(){
    if(!shown||!detail?.nextCursor||detail.moreLoading||detail.loading)return;
    const id=detail.id,cursor=detail.nextCursor,token=generation,request=++detailRequest;
    const previousCount=detail.replies.length;
    detail.moreLoading=true;detail.moreFailed=false;renderContent({preserve:true});
    try{
      const value=await bridge.getXPost({id,cursor});
      if(token!==generation||request!==detailRequest||!shown||detail?.id!==id)return;
      detail.replies=[...new Map(normalizeItems([...(detail.replies??[]),...(value.replies??[])]).map(post=>[post.id,post])).values()];
      detail.moreLoading=false;detail.moreFailed=value.outcome==='failed'||(value.repliesExhausted!==true&&detail.replies.length===previousCount);
      if(!detail.moreFailed){detail.nextCursor=typeof value.nextCursor==='string'?value.nextCursor:null;detail.repliesExhausted=value.repliesExhausted===true;}
      if(value.status)setStatus(value.status);renderContent({preserve:true});prefetch();
    }catch{if(token===generation&&request===detailRequest&&shown&&detail?.id===id){detail.moreLoading=false;detail.moreFailed=true;renderContent({preserve:true});}}
  }
  function enqueue(id){if(queued.has(id)||full.has(id)||autoTried.has(id))return;queued.add(id);pump();}
  function prefetch(){for(const post of detail?[detail.post,...detail.replies]:records.get(active).items){if(post&&!post.complete)enqueue(post.id);if(post?.quotedPost&&!post.quotedPost.complete)enqueue(post.quotedPost.id);}}
  function pump(){while(shown&&fullActive<2&&queued.size){const id=queued.values().next().value;queued.delete(id);autoTried.add(id);fullActive++;const token=generation;
    Promise.resolve().then(()=>bridge.getXPost({id})).then(value=>{if(token!==generation||!shown)return;const post=normalizeXPost(value.post);if(post?.complete)full.set(id,post);else fullFailed.add(id);updateFullText(id);}).catch(()=>{if(token===generation&&shown){fullFailed.add(id);updateFullText(id);}}).finally(()=>{fullActive--;if(shown)pump();});}}
  function hide(){if(!shown)return;shown=false;++generation;++listRequest;++detailRequest;if(!detail)records.get(active).scroll=content.scrollTop;else detailScroll=content.scrollTop;if(pollTimer)win.clearTimeout(pollTimer);pollTimer=null;queued.clear();for(const id of autoTried)if(!full.has(id))autoTried.delete(id);stopMedia();root.hidden=true;}
  function refreshLocale(value={}){if(disposed)return;Object.assign(translationOptions,value);root.setAttribute('aria-label',t('title'));for(const[control,key]of[[back,'back'],[refresh,'refresh'],[settings,'settings']]){control.title=t(key);control.setAttribute('aria-label',t(key));}newPosts.textContent=t('newPosts');for(const[tab,control]of tabButtons)control.textContent=t(tab);const scroll=content.scrollTop;renderContent();content.scrollTop=scroll;if(loginMethod||!loginPanel.hidden)renderLogin();}
  return {async show(){if(disposed||shown)return;shown=true;root.hidden=false;++generation;renderContent();content.scrollTop=detail?detailScroll:records.get(active).scroll;await Promise.all([poll(),detail?openDetail(detail.id):loadList()]);},hide,
    dispose(){if(disposed)return;hide();disposed=true;pageResize?.disconnect();content.removeEventListener('scroll',scheduleNextPage);content.removeEventListener('load',scheduleNextPage,true);documentRef.removeEventListener('keydown',escape);root.remove();},
    refreshLocale,render:refreshLocale,openPost(id){if(ID.test(id)&&shown)return openDetail(id);return Promise.resolve();},
    handleUpdate(value){if(disposed)return;if(value?.status||value?.auth)setStatus(value.status??value);if(shown&&!detail&&!loading)void loadList({background:true});}};
}

export function mountXSettings(options){
  const {container,bridge,documentRef=container.ownerDocument}=options,translationOptions={...options,documentRef},t=translator(translationOptions),{node,button}=helpers(documentRef),root=node('section','x-settings');container.append(root);
  let disposed=false,generation=0,current=null,lastStatus=null,messageKey=null,visible=false,statusTimer=null,statusGeneration=0;
  const settingsWindow=documentRef.defaultView??globalThis;
  const localized=[],text=(element,key)=>{element.textContent=t(key);localized.push({element,key});return element;},action=(key,run)=>text(button('',run),key),setMessage=key=>{messageKey=key;message.textContent=t(key);};
  const state=node('p','x-reader-status'),message=node('p','x-reader-status');state.setAttribute('role','status');message.setAttribute('role','status');
  const controls={};
  const row=(label,control,hint)=>{const item=node('div','x-settings-row'),labelNode=text(node('label'),label),right=node('div','x-settings-control');if(control.id)labelNode.htmlFor=control.id;right.append(control);if(hint)right.append(text(node('small','x-reader-muted'),hint));item.append(labelNode,right);root.append(item);return item;};
  root.append(state);
  const login=node('div','x-settings-actions');login.append(action('web',()=>run(()=>bridge.beginXLogin({method:'web'}))),action('session',()=>run(()=>bridge.beginXLogin({method:'session'}))),action('otherLogin',()=>run(()=>bridge.cancelXLogin())),action('logout',()=>confirmAction('confirmLogout',()=>bridge.logoutX())));row('login',login);
  function input(key,type,value){const el=node('input');el.id=`x-setting-${key}`;el.type=type;if(type==='checkbox')el.checked=value;else el.value=String(value);controls[key]=el;return el;}
  const interval=input('refreshMinutes','number',5);interval.step='1';const intervalField=node('div','x-settings-actions');intervalField.append(interval,text(node('span'),'minutes'));row('interval',intervalField,'intervalHint');
  const proxy=node('select');proxy.id='x-setting-proxy';controls.proxyMode=proxy;for(const[value,label]of[['system','system'],['local','local']]){const option=text(node('option'),label);option.value=value;proxy.append(option);}row('proxy',proxy);
  const port=input('proxyPort','number',10809);port.min='1';port.max='65535';port.step='1';const portRow=row('port',port);portRow.hidden=true;proxy.addEventListener('change',()=>portRow.hidden=proxy.value!=='local');
  row('notifyPosts',input('notifyPosts','checkbox',false));row('notifyReplies',input('notifyReplies','checkbox',false));
  const cache=node('div','x-settings-actions'),bytes=node('span','x-reader-muted',t('cacheUnknown'));cache.append(bytes,action('clearCache',()=>confirmAction('confirmClear',()=>bridge.clearXCache())));row('cache',cache);
  const save=action('save',async()=>{const value={refreshMinutes:Number(interval.value),proxyMode:proxy.value,proxyPort:Number(port.value),notifyPosts:controls.notifyPosts.checked,notifyReplies:controls.notifyReplies.checked};if(!validateXSettings(value)){setMessage('invalid');return;}save.disabled=true;await run(()=>bridge.setXSettings(value),false);save.disabled=false;});root.append(save,message);
  async function confirmAction(key,action){if(documentRef.defaultView?.confirm(t(key)))await run(action);}
  async function run(action,reload=true){const token=++generation;setMessage('loading');try{const value=await action();if(disposed||token!==generation)return;setMessage('saved');if(reload)await load();else current=value;}catch(error){if(!disposed&&token===generation)setMessage(sessionFailureKey(error)??'failed');}}
  async function load(){const token=++generation;try{const[result,status]=await Promise.all([bridge.getXSettings(),bridge.getXStatus()]);if(disposed||token!==generation)return;const value=result?.settings??result;current=value;if(validateXSettings(value)){interval.value=String(value.refreshMinutes);proxy.value=value.proxyMode;port.value=String(value.proxyPort);controls.notifyPosts.checked=value.notifyPosts;controls.notifyReplies.checked=value.notifyReplies;portRow.hidden=value.proxyMode!=='local';}
    lastStatus=status?.status??status;renderStatus();
    const size=result.cacheBytes??lastStatus.cacheBytes;bytes.textContent=Number.isSafeInteger(size)&&size>=0?`${new Intl.NumberFormat(options.locale,{maximumFractionDigits:1}).format(size/1048576)} MB`:t('cacheUnknown');
  }catch(error){if(!disposed&&token===generation)state.textContent=t(sessionFailureKey(error)??'failed');}}
  function renderStatus(){if(!lastStatus)return;const failure=loginError(lastStatus),phase=failure?failedStage(lastStatus):null;state.textContent=(phase?t('sessionFailureAt')+t(phase)+' · ':'')+t(failure??(['authorizing','challenge'].includes(lastStatus.auth)&&lastStatus.loginMethod==='session'?LOGIN_STAGE_COPY[lastStatus.loginStage]??'authorizing':AUTH.includes(lastStatus.auth)?lastStatus.auth:'disconnected'));if(lastStatus.notificationStatus==='unavailable'||lastStatus.notificationsAvailable===false)state.append(node('span','x-reader-muted',` · ${t('notificationUnavailable')}`));}
  function refreshLocale(value={}){if(disposed)return;Object.assign(translationOptions,value);for(const{element,key}of localized)element.textContent=t(key);if(messageKey)message.textContent=t(messageKey);renderStatus();}
  async function pollStatus(){const token=statusGeneration;try{const value=await bridge.getXStatus();if(disposed||!visible||token!==statusGeneration)return;lastStatus=value.status??value;renderStatus();}catch(error){if(!disposed&&visible&&token===statusGeneration)state.textContent=t(sessionFailureKey(error)??'failed');}finally{if(visible&&!disposed&&token===statusGeneration)statusTimer=settingsWindow.setTimeout(()=>void pollStatus(),lastStatus?.auth==='authorizing'?2000:15000);}}
  function hide(){visible=false;++statusGeneration;if(statusTimer)settingsWindow.clearTimeout(statusTimer);statusTimer=null;root.hidden=true;}
  void load();return {show(){if(disposed||visible)return;visible=true;root.hidden=false;++statusGeneration;void load();void pollStatus();},hide,dispose(){hide();disposed=true;++generation;root.remove();},refreshLocale,render:refreshLocale,handleUpdate(value){if(disposed)return;if(value?.auth||value?.status){lastStatus=value.status??value;renderStatus();}}};
}
