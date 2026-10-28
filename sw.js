const CACHE="copilote-v6";
const FILES=["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png","lib/tf.min.js","lib/coco-ssd.min.js","lib/supabase.js","lib/591.supabase.js","config.js","account.js","model/model.json","model/group1-shard1of5.wasm","model/group1-shard2of5.wasm","model/group1-shard3of5.wasm","model/group1-shard4of5.wasm","model/group1-shard5of5.wasm"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));self.skipWaiting();});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));self.clients.claim();});
self.addEventListener("fetch",e=>{e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));});
