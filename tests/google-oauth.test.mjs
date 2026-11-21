import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'fmail-google-test-'));
await build({ entryPoints:['src/lib/auth/google.ts'], outfile:join(dir,'google.mjs'), bundle:true, platform:'node', format:'esm', logLevel:'silent' });
const auth = await import(join(dir, 'google.mjs'));
await build({entryPoints:['src/lib/auth/password.ts'],outfile:join(dir,'password.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const password = await import(join(dir,'password.mjs'));
test('Google-only recovery does not weaken explicit passkey-only accounts',()=>{
 assert.equal(password.canRecoverPassword(password.GOOGLE_ONLY_PASSWORD_HASH,'google-sub'),true);
 assert.equal(password.canRecoverPassword(password.GOOGLE_ONLY_PASSWORD_HASH,null),false);
 assert.equal(password.canRecoverPassword(password.PASSWORDLESS_PASSWORD_HASH,'google-sub'),false);
 assert.equal(password.hasPasswordHash(password.GOOGLE_ONLY_PASSWORD_HASH),false);
 assert.equal(password.verifyPassword('anything',password.GOOGLE_ONLY_PASSWORD_HASH),false);
});
const key = 'local-test-only-oauth-key';
test('OAuth configuration is closed unless both credentials are set', () => {
 assert.equal(auth.getGoogleOAuthConfig({ GOOGLE_CLIENT_ID:'test' }), null);
 assert.equal(auth.getSignupDomain({}), null);
});
test('OAuth state is browser-bound, signed, expiring and PKCE-protected', async () => {
 const state = await auth.createOAuthState(key);
 const proof = await auth.verifyOAuthState(key, state.cookieValue, state.nonce);
 assert.equal(proof.verifier.length,64);
 assert.equal(await auth.verifyOAuthState(key,state.cookieValue,'different-browser'),null);
 assert.equal(await auth.verifyOAuthState('other-key',state.cookieValue,state.nonce),null);
 assert.equal(await auth.verifyOAuthState(key,state.cookieValue+'x',state.nonce),null);
 const oldNow = Date.now;
 Date.now = () => oldNow()+11*60*1000;
 try { assert.equal(await auth.verifyOAuthState(key,state.cookieValue,state.nonce),null); } finally { Date.now=oldNow; }
 const url = new URL(auth.buildAuthorizationUrl({clientId:'test',clientSecret:key},'https://mail.example.com/api/auth/google/callback',state.nonce,state.challenge));
 assert.equal(url.searchParams.get('scope'),'openid email profile');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.equal(url.searchParams.get('code_challenge'),state.challenge);
 assert.equal(url.searchParams.has('access_type'),false);
});
test('Pending profile cannot be changed, forged or used after expiration', async () => {
 const profile = {sub:'subject-local',email:'test@example.test',name:'Local Test',picture:null};
 const cookie = await auth.createPendingSignupCookie(key,profile);
 assert.deepEqual(await auth.verifyPendingSignupCookie(key,cookie),profile);
 assert.equal(await auth.verifyPendingSignupCookie('other-key',cookie),null);
 assert.equal(await auth.verifyPendingSignupCookie(key,cookie+'x'),null);
 const oldNow=Date.now;Date.now=()=>oldNow()+16*60*1000;
 try {assert.equal(await auth.verifyPendingSignupCookie(key,cookie),null);}finally{Date.now=oldNow;}
});
test('Google profile requires provider-verified email', async () => {
 const oldFetch=globalThis.fetch;
 try {
  globalThis.fetch=async()=>Response.json({sub:'local',email:'test@example.test',email_verified:false});
  assert.equal(await auth.fetchGoogleProfile('local-test-token'),null);
  globalThis.fetch=async()=>Response.json({sub:42,email:'test@example.test',email_verified:true});
  assert.equal(await auth.fetchGoogleProfile('local-test-token'),null);
  globalThis.fetch=async()=>Response.json({sub:'local',email:'Test@Example.test',email_verified:true});
  assert.equal((await auth.fetchGoogleProfile('local-test-token')).email,'test@example.test');
 }finally{globalThis.fetch=oldFetch;}
});
process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));
