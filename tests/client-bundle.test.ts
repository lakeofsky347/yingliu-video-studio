import test from 'node:test';
import assert from 'node:assert/strict';
import {checkClientBundle} from '../scripts/check-client-bundle.mjs';

const factory=(body:string)=>`window.__ModuleLoader__.load({id:'yingliu-video-studio',factory:(require)=>{${body};return {inject:[],apply(){}};}});`;
test('client factory imports only the real React modules supplied by the host',()=>{
  const result=checkClientBundle(factory(`const React=require('react');const jsx=require('react/jsx-runtime');if(typeof React.createElement!=='function'||typeof jsx.jsx!=='function')throw Error('Bad seeds')`));
  assert.deepEqual(result.externals,['react','react/jsx-runtime']);
});
test('ordinary npm dependencies are rejected at build time, including deferred requires',()=>{
  assert.throws(()=>checkClientBundle(factory(`const zip=require('fflate')`)),/require\("fflate"\).*not a DSH seed/);
  assert.throws(()=>checkClientBundle(factory(`function importZip(){return require('fflate')}`)),/require\("fflate"\).*not a DSH seed/);
  assert.throws(()=>checkClientBundle(factory(`const fs=require('node:fs')`)),/not a DSH seed/);
});
test('dynamic dependencies and extra chunks cannot bypass the factory boundary',()=>{
  assert.throws(()=>checkClientBundle(factory(`function load(name){return require(name)}`)),/Dynamic require/);
  assert.throws(()=>checkClientBundle(factory(`function load(){return import('./chunk.js')}`)),/Unregistered dynamic import/);
  assert.throws(()=>checkClientBundle(`import value from 'fflate';${factory('')}`),/ESM imports/);
});
test('strict factory execution catches top-level browser import failures and invalid exports',()=>{
  assert.throws(()=>checkClientBundle(factory(`throw Error('Import failed')`)),/Import failed/);
  assert.throws(()=>checkClientBundle(`window.__ModuleLoader__.load({id:'yingliu-video-studio',factory:()=>({})});`),/export apply and inject/);
  assert.throws(()=>checkClientBundle(factory('')+factory('')),/Unexpected client factory/);
  assert.throws(()=>checkClientBundle('const unused=1;'),/did not register/);
});
