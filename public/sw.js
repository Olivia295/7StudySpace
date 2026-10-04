const CACHE='study77-development';
const CORE=/* PRECACHE */ [];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('study77-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(url.origin!==self.location.origin||url.pathname.startsWith('/api/')||event.request.method!=='GET')return;
 event.respondWith((async()=>{const cached=await caches.match(url.pathname);const range=event.request.headers.get('range');if(cached&&range){const data=await cached.arrayBuffer();const match=range.match(/^bytes=(\d+)-(\d*)$/);if(match){const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),data.byteLength-1):data.byteLength-1;if(start>end)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${data.byteLength}`}});return new Response(data.slice(start,end+1),{status:206,headers:{'Content-Type':cached.headers.get('Content-Type')||'audio/mp4','Content-Range':`bytes ${start}-${end}/${data.byteLength}`,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes'}});}}
 if(cached)return cached;
 try{const response=await fetch(event.request);if(response.ok&&!range){const cache=await caches.open(CACHE);await cache.put(event.request,response.clone());}return response;}catch{if(event.request.mode==='navigate'){const shell=await caches.match('/');if(shell)return shell;}return new Response('这份资料还没保存到设备，请联网后打开。',{status:503});}})());
});
