import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopXDiagnostics, projectXError, X_DIAGNOSTIC_FILE } from '../desktop-x-diagnostics.js';
import { sessionError } from '../desktop-x-session-health.js';
import { createWindowsFilesystemAdapter, createWindowsProtectedStateStore } from '../../../src/platform/index.js';
import { WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS } from '../../../src/platform/windows-filesystem.js';

function storeFixture() {
  let sequence=1,record,fail=false;
  const identity=()=>({volumeSerialNumber:'0000000000000001',fileId:String(sequence++).padStart(32,'0'),linkCount:1});
  const metadata={identity:identity(),isDirectory:true,isRegularFile:false,isReparsePoint:false,ownerMatches:true,nullDacl:false,daclProtected:true,broadAccess:false,nonOwnerAllow:false,unrecognizedAce:false,finalPathResolved:true};
  const check=name=>{assert.equal(name,X_DIAGNOSTIC_FILE);if(fail)throw new Error('Synthetic write failure');};
  const binding={contractVersion:'windows-filesystem-v1',securityContractVersion:'windows-filesystem-security-v1',credentialAuditFileGuardContractVersion:'windows-credential-audit-file-guard-v1',credentialMutexContractVersion:'windows-credential-mutex-v1',productionSafe:false,pathWalkRaceSafe:false,credentialMutexSafe:true,credentialAuditFileGuardSafe:true,
    ...Object.fromEntries(WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS.map(name=>[name,()=>undefined])),
    ensureDirectory:()=>metadata.identity,inspectPath:()=>({...metadata}),
    readProtectedChild(_path,_parent,name){check(name);if(!record)throw Object.assign(new Error('Synthetic missing'),{code:'WINDOWS_FILESYSTEM_NOT_FOUND'});return {data:record.data,...record.metadata};},deleteProtectedChild(){throw new Error('Unexpected diagnostic delete');},
    inspectProtectedChild(_path,_parent,name){check(name);if(!record)throw Object.assign(new Error('Synthetic missing'),{code:'WINDOWS_FILESYSTEM_NOT_FOUND'});return record.metadata;},
    createProtectedChild(_path,_parent,name,data){check(name);assert.equal(record,undefined);record={data:Buffer.from(data),metadata:{...metadata,isDirectory:false,isRegularFile:true,identity:identity()}};return record.metadata.identity;},
    replaceProtectedChild(_path,_parent,name,old,data){check(name);assert.deepEqual(old,record.metadata.identity);record.data=Buffer.from(data);record.metadata.identity=identity();return record.metadata.identity;},
  };
  const store=createWindowsProtectedStateStore({adapter:createWindowsFilesystemAdapter({platform:'win32',architecture:'x64',binding}),rootPath:'C:\\synthetic-x-diagnostics'});
  return{store,read:()=>JSON.parse(record.data),fail:()=>{fail=true;}};
}

test('X local diagnostics use protected identity replacement, bound retention and isolate write failures',()=>{
  const fixture=storeFixture();const log=createDesktopXDiagnostics({store:fixture.store,clock:()=>1000000});
  for(let i=0;i<20;i++)assert.equal(log('login_web',Object.assign(new Error('net::ERR_FAILED at https://x.com/private'),{errno:i})),true);
  const saved=fixture.read();assert.equal(saved.version,1);assert.equal(saved.entries.length,16);assert.equal(saved.entries[0].error.errno,4);assert.equal(saved.entries[15].error.errno,19);
  assert.equal(log('arbitrary-stage',new Error('ERR_FAILED')),false);
  const restarted=createDesktopXDiagnostics({store:fixture.store});assert.equal(restarted('login_web',new Error('ERR_FAILED')),true);assert.equal(fixture.read().entries[0].error.errno,5);
  fixture.fail();assert.equal(log('login_web',new Error('ERR_FAILED')),false);
  assert.throws(()=>createDesktopXDiagnostics({store:{}}),/Protected/);
});

test('X diagnostics preserve original native failures through categorized causes without secrets',()=>{
  const raw=Object.assign(new Error('net::ERR_PROXY_CONNECTION_FAILED at https://x.com/private?token=synthetic-secret'),{code:'ERR_PROXY_CONNECTION_FAILED',errno:-130});
  raw.stack='Error: synthetic-secret\n    at load (C:\\synthetic-private\\desktop-x-service.js:123:45)\n    at https://x.com/synthetic-secret.js:1:2';
  const wrapped=sessionError(raw,'session_read_failed');assert.equal(wrapped.cause,raw);
  const record=projectXError(wrapped);
  assert.equal(record.cause.code,'ERR_PROXY_CONNECTION_FAILED');assert.equal(record.cause.errno,-130);
  assert.equal(record.cause.message,'net::ERR_PROXY_CONNECTION_FAILED');assert.deepEqual(record.cause.frames,['desktop-x-service.js:123:45']);
  assert.equal(JSON.stringify(record).includes('synthetic-secret'),false);assert.equal(JSON.stringify(record).includes('synthetic-private'),false);
});

test('X diagnostics omit arbitrary upstream text and fields and bound circular causes',()=>{
  const error=Object.assign(new Error('auth_token=synthetic-secret account=private'),{code:'synthetic-secret',cookie:'synthetic-secret',response:{body:'synthetic-secret'}});error.cause=error;
  const result=projectXError(error);assert.equal(result.code,null);assert.equal(result.message,null);assert.equal(result.messageOmitted,true);assert.equal(result.cause,null);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'),false);
  let chain=new Error('ERR_FAILED');for(let i=0;i<10;i++)chain=new Error('ERR_FAILED',{cause:chain});
  let projected=projectXError(chain),count=0;while(projected){count++;projected=projected.cause;}assert.equal(count,4);
});
