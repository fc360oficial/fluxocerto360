// Service worker mínimo — só existe pra habilitar "Instalar app" no celular.
// Não faz cache (dados são sempre em tempo real), sempre busca da rede.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
