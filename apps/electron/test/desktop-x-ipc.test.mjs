import assert from 'node:assert/strict';
import test from 'node:test';
import { installDesktopXIpc, validateXDesktopRequest, X_IPC_CHANNEL } from '../desktop-x-ipc.js';
import { validateDesktopCommand } from '../desktop-command.js';
import { X_SESSION_ERRORS } from '../desktop-x-contract.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('sandbox preload accepts scoped refresh and forced details while rejecting mixed or unknown arguments',async()=>{
  const exposed=new Map(),calls=[];
  const context=vm.createContext({process:{platform:'win32',env:{}},require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>exposed.set(name,value)},ipcRenderer:{invoke:async(channel,request)=>{calls.push({channel,request});return{};},on(){},off(){}}})});
  vm.runInContext(await readFile(new URL('../preload.cjs',import.meta.url),'utf8'),context);
  const bridge=exposed.get('tibotattleDesktop');
  await bridge.refreshX({tab:'media'});await bridge.getXPost({id:'123',force:true});await bridge.getXPost({id:'123',cursor:'safe'});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.map(c=>c.request))),[{action:'refreshX',args:{tab:'media'}},{action:'getXPost',args:{id:'123',force:true}},{action:'getXPost',args:{id:'123',cursor:'safe'}}]);
  for(const args of [[],[{}],[{tab:'media',url:'https://x.com'}],[{tab:'unknown'}]])await assert.rejects(bridge.refreshX(...args));
  for(const query of [{id:'123',force:1},{id:'123',force:undefined},{id:'123',force:true,cursor:'safe'},{id:'123',force:true,extra:true}])await assert.rejects(bridge.getXPost(query));
  assert.equal(calls.length,3);
});

test('manual refresh is scoped and force detail reads have a closed contract',async()=>{
  const calls=[];let handler;
  installDesktopXIpc({ipcMain:{handle(_c,fn){handler=fn;}},authorize:()=>true,importBridge:{},service:{refresh:async args=>{calls.push(args);},getPost:async args=>{calls.push(args);}}});
  await handler({}, {action:'refreshX',args:{tab:'media'}});await handler({}, {action:'getXPost',args:{id:'123',force:true}});
  assert.deepEqual(calls,[{tab:'media',reason:'manual'},{id:'123',force:true}]);
  for(const args of [{},{tab:'unknown'},{tab:'posts',id:'123'},{tab:'posts',cursor:'safe'}])assert.throws(()=>validateXDesktopRequest({action:'refreshX',args}));
  for(const args of [{id:'123',force:1},{id:'123',force:undefined},{id:'123',force:true,cursor:'safe'},{id:'123',force:true,url:'https://x.com'}])assert.throws(()=>validateXDesktopRequest({action:'getXPost',args}));
});

test('detail pagination accepts only a bounded opaque cursor and exact request fields',()=>{
  assert.deepEqual(validateXDesktopRequest({action:'getXPost',args:{id:'123',cursor:'synthetic-page'}}).args,{id:'123',cursor:'synthetic-page'});
  for(const args of [{id:'123',cursor:'https://x.com/private'},{id:'123',cursor:null},{id:'123',cursor:'x'.repeat(161)},{id:'123',cursor:'safe',branch:'private'},{id:'123',url:'https://x.com'}])assert.throws(()=>validateXDesktopRequest({action:'getXPost',args}));
});

test('local session failure categories survive IPC without raw error context', async () => {
  for (const code of [...X_SESSION_ERRORS, 'storage_unavailable']) {
    let handler;
    installDesktopXIpc({ ipcMain: { handle(_name, fn) { handler = fn; } }, authorize: () => true, importBridge: {},
      service: { getStatus() { throw Object.assign(new Error('synthetic private context'), { code }); } } });
    await assert.rejects(handler({}, { action: 'getXStatus', args: {} }), error => error.code === code && error.message === code);
  }
});

test('X IPC rejects foreign frames before validation or service access', async () => {
  let handler; let called = 0;
  const ipcMain = { handle(channel, callback) { assert.equal(channel, X_IPC_CHANNEL); handler = callback; }, removeHandler() {} };
  installDesktopXIpc({ ipcMain, service: { getStatus: () => { called++; return { auth: 'ready' }; } }, importBridge: {}, authorize: event => event.trusted === true });
  for (const event of [{}, { trusted: false, senderFrame: { url: 'https://x.com' } }]) {
    await assert.rejects(handler(event, { action: 'getXStatus', args: {} }), { code: 'x_untrusted_context' });
  }
  assert.equal(called, 0);
  assert.deepEqual(await handler({ trusted: true }, { action: 'getXStatus', args: {} }), { auth: 'ready' });
  assert.equal(called, 1);
});

test('X bridge closed inputs cannot select arbitrary resources or leak failures', async () => {
  for (const request of [
    { action: 'getXPost', args: { id: 'https://x.com' } },
    { action: 'getXPost', args: { id: '123', url: 'file:///private' } },
    { action: 'beginXLogin', args: { method: 'database' } },
    { action: 'refreshX', args: { cookies: [] } },
    { action: 'listXPosts', args: { tab: 'posts', cursor: '../private' } },
    { action: 'getXStatus', args: {}, path: 'private' },
  ]) assert.throws(() => validateXDesktopRequest(request));
  let handler;
  installDesktopXIpc({ ipcMain: { handle(_c, fn) { handler = fn; } }, service: { getPost() { throw new Error('synthetic private token'); } }, importBridge: {}, authorize: () => true });
  await assert.rejects(handler({}, { action: 'getXPost', args: { id: '123' } }), error => error.code === 'x_operation_failed' && !error.message.includes('token'));
  assert.deepEqual(validateDesktopCommand({ command: 'xPost', id: '123' }), { command: 'xPost', id: '123' });
  assert.throws(() => validateDesktopCommand({ command: 'xPost', id: 'https://x.com' }));
  assert.throws(() => validateDesktopCommand({ command: 'xPost', id: '123', url: 'https://x.com' }));
});
