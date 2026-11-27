const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const listeners = {};
let cacheWrites = 0;
const cache = { put: async () => { cacheWrites++; }, addAll: async () => {} };
const matched = [];
const context = {
  URL, Response, Promise,
  self: { location: { origin: 'https://bhubingpalace.com' }, clients: {claim: async()=>{}}, skipWaiting: async()=>{}, addEventListener: (name, fn) => listeners[name] = fn },
  caches: { open: async () => cache, match: async (req) => { matched.push(req.url || req); return undefined; }, keys: async()=>[] },
  fetch: async () => { throw new Error('offline'); }
};
vm.runInNewContext(fs.readFileSync('public/sw.js','utf8'), context);
async function request(url) {
 let result;
 listeners.fetch({request:{method:'GET',url,mode:'navigate',headers:{get:()=> 'text/html'}}, respondWith:p=>result=p});
 return result;
}
(async()=>{
 const r = await request('https://bhubingpalace.com/mnw/');
 assert.equal(r.type,'error');
 assert.deepEqual(matched,['https://bhubingpalace.com/mnw/']);
 context.fetch=async()=>new Response('not found',{status:404});
 const missing=await request('https://bhubingpalace.com/mnw/no-such-page/');
 assert.equal(missing.status,404);
 assert.equal(cacheWrites,0);
 console.log('Offline locale isolation and 404 cache checks passed');
})().catch(e=>{console.error(e);process.exitCode=1});
