import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'fmail-forwarding-test-'));
await build({entryPoints:['src/lib/auth/google-forwarding.ts'],outfile:join(dir,'forward.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent',plugins:[{name:'cf-mock',setup(b){b.onResolve({filter:/^@\/lib\/cloudflare-api$/},()=>({path:'mock',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export async function cfRequest(env,path,options){return globalThis.__cfMock(env,path,options)}',loader:'js'}));}}]});
const forward=await import(join(dir,'forward.mjs'));
const env={CF_ACCOUNT_ID:'a'.repeat(32)};
test('opt in adds only the user destination and waits for verification',async()=>{
 const calls=[];globalThis.__cfMock=async(e,p,o)=>{calls.push({path:p,options:o});return o?.method==='POST'?{email:'owner@gmail.com',verified:null}:[];};
 assert.equal(await forward.requestGoogleForwarding(env,'owner@gmail.com'),'pending');
 assert.equal(calls.length,2);assert.deepEqual(JSON.parse(calls[1].options.body),{email:'owner@gmail.com'});
});
test('existing pending address is not recreated or emailed again',async()=>{
 let calls=0;globalThis.__cfMock=async()=>{calls++;return [{email:'owner@gmail.com',verified:null},{email:'unrelated@gmail.com',verified:'2026-01-01'}];};
 assert.equal(await forward.requestGoogleForwarding(env,'owner@gmail.com'),'pending');assert.equal(calls,1);
});
test('only the matching verified email is marked active',async()=>{
 globalThis.__cfMock=async()=>[{email:'other@gmail.com',verified:'2026-01-01'},{email:'owner@gmail.com',verified:'2026-02-01'}];
 assert.equal(await forward.googleForwardingStatus(env,'OWNER@gmail.com'),'verified');
});
test('unknown account or API failures never claim verification',async()=>{
 await assert.rejects(forward.googleForwardingStatus({},'owner@gmail.com'));
 globalThis.__cfMock=async()=>{throw new Error('provider unavailable');};
 await assert.rejects(forward.requestGoogleForwarding(env,'owner@gmail.com'));
});
process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));
