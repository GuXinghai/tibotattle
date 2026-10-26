import { mountXReader, mountXSettings } from './x-reader.js';

const mounted = new WeakMap();
let hlsLoading;
/** A single local UMD asset; never fetch executable code from X or a CDN. */
export function loadLocalXHls({documentRef=globalThis.document,windowRef=globalThis.window}={}) {
  if(windowRef.Hls)return Promise.resolve(windowRef.Hls);
  if(hlsLoading)return hlsLoading;
  hlsLoading=new Promise((resolve,reject)=>{
    const script=documentRef.createElement('script');script.src='./vendor/hls.light.min.js';script.async=true;
    script.onload=()=>windowRef.Hls?resolve(windowRef.Hls):reject(new Error('hls_unavailable'));
    script.onerror=()=>{hlsLoading=null;script.remove();reject(new Error('hls_unavailable'));};documentRef.head.append(script);
  });
  return hlsLoading;
}

export function mountDesktopXReader({documentRef=globalThis.document,windowRef=globalThis.window,translate,locale}={}) {
  if(mounted.has(documentRef))return mounted.get(documentRef);
  const bridge=windowRef?.usageMonitorDesktop;
  if(bridge?.version!=='v1'||typeof bridge.getXStatus!=='function')return null;
  const readerContainer=documentRef.querySelector('#x-content'),settingsContainer=documentRef.querySelector('#settings-panel-x');
  if(!readerContainer||!settingsContainer)return null;
  for(const element of documentRef.querySelectorAll('[data-desktop-only="true"]'))element.hidden=false;
  // The settings controller, rather than the feature capability, owns this panel's visibility.
  settingsContainer.hidden=!documentRef.querySelector('#settings-tab-x')?.getAttribute('aria-selected')?.includes('true');
  const options={bridge,documentRef,translate,locale};
  const reader=mountXReader({...options,container:readerContainer,onOpenSettings:()=>{windowRef.location.hash='#settings/x';},
    loadHls:async()=>{const Hls=await loadLocalXHls({documentRef,windowRef});return class LocalHls extends Hls{constructor(config){super({...config,enableWorker:false});}};}});
  const settings=mountXSettings({...options,container:settingsContainer});
  reader.hide();settings.hide();let readerVisible=false,settingsVisible=false,disposed=false;
  const sync=()=>{
    if(disposed)return;
    const page=documentRef.body.dataset.dashboardPage;
    const nextReader=page==='x',nextSettings=page==='settings'&&!settingsContainer.hidden;
    if(nextReader!==readerVisible){readerVisible=nextReader;if(nextReader)void reader.show();else reader.hide();}
    if(nextSettings!==settingsVisible){settingsVisible=nextSettings;if(nextSettings)settings.show();else settings.hide();}
  };
  const observer=typeof windowRef.MutationObserver==='function'?new windowRef.MutationObserver(sync):null;
  observer?.observe(documentRef.body,{attributes:true,attributeFilter:['data-dashboard-page']});
  observer?.observe(settingsContainer,{attributes:true,attributeFilter:['hidden']});
  const onLocale=event=>{const value={locale:event.detail?.locale??documentRef.documentElement.lang,translate};reader.refreshLocale(value);settings.refreshLocale(value);};
  const onOpenPost=async event=>{const id=event.detail?.id;if(typeof id!=='string'||!/^[0-9]{1,24}$/u.test(id))return;sync();await reader.show();if(!disposed)await reader.openPost(id);};
  const onUnload=()=>api.dispose();
  windowRef.addEventListener('usagemonitor:locale-change',onLocale);windowRef.addEventListener('usagemonitor-x-open-post',onOpenPost);windowRef.addEventListener('pagehide',onUnload,{once:true});
  const api={sync,reader,settings,dispose(){if(disposed)return;disposed=true;observer?.disconnect();reader.dispose();settings.dispose();windowRef.removeEventListener('usagemonitor:locale-change',onLocale);windowRef.removeEventListener('usagemonitor-x-open-post',onOpenPost);windowRef.removeEventListener('pagehide',onUnload);mounted.delete(documentRef);}};
  mounted.set(documentRef,api);sync();return api;
}
