const CACHE="copilote-v18";
const FILES=["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png","lib/tf.min.js","lib/coco-ssd.min.js","lib/supabase.js","lib/591.supabase.js","config.js","account.js","recorder.js","nav.js","lib/leaflet/leaflet.js","lib/leaflet/leaflet.css","model/model.json","model/group1-shard1of5.wasm","model/group1-shard2of5.wasm","model/group1-shard3of5.wasm","model/group1-shard4of5.wasm","model/group1-shard5of5.wasm"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));self.skipWaiting();});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));self.clients.claim();});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET"||u.origin!==location.origin){ return; }
  const fresh=/\.(html|js|webmanifest)$/.test(u.pathname)||u.pathname.endsWith("/");
  const heavy=u.pathname.includes("/model/")||u.pathname.includes("/lib/tf");
  if(fresh&&!heavy){
    e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r;}).catch(()=>caches.match(e.request)));
  }else{
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
  }
});
