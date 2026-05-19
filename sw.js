// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER — L'Atelier du Mécano
// Version: 2.0
// Features:
//   • Cache stratégique (Cache First / Network First)
//   • Background Sync (synchronisation des réservations hors-ligne)
//   • Periodic Background Sync (mises à jour automatiques)
//   • Push Notifications (alertes propriétaire)
//   • Share Target (réception de fichiers partagés)
//   • Protocol Handlers (mailto, sms, tel, web+mecano)
// ═══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'mecano-v2';
const CACHE_STATIC  = `${CACHE_VERSION}-static`;
const CACHE_DYNAMIC = `${CACHE_VERSION}-dynamic`;
const CACHE_API     = `${CACHE_VERSION}-api`;

// Ressources mises en cache à l'installation
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-72.png',
  '/icon-96.png',
  '/icon-128.png',
  '/icon-144.png',
  '/icon-152.png',
  '/icon-192.png',
  '/icon-384.png',
  '/icon-512.png'
];

// ─── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installation v2.0');
  event.waitUntil(
    caches.open(CACHE_STATIC).then(cache => {
      console.log('[SW] Mise en cache des ressources statiques');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activation v2.0');
  event.waitUntil(
    Promise.all([
      // Nettoyer les anciens caches
      caches.keys().then(keys =>
        Promise.all(keys
          .filter(k => !k.startsWith(CACHE_VERSION))
          .map(k => caches.delete(k))
        )
      ),
      self.clients.claim(),
      // Demander la permission Periodic Background Sync
      registerPeriodicSync()
    ])
  );
});

// ─── FETCH (Stratégie cache) ──────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // FormSubmit, SumUp et autres API externes : Network First
  if (url.hostname.includes('formsubmit.co') ||
      url.hostname.includes('sumup.com') ||
      url.hostname.includes('api.')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Images : Cache First
  if (request.destination === 'image') {
    event.respondWith(cacheFirst(request, CACHE_DYNAMIC));
    return;
  }

  // Documents HTML : Network First avec fallback cache
  if (request.destination === 'document') {
    event.respondWith(networkFirstWithFallback(request));
    return;
  }

  // Tout le reste : Cache First
  event.respondWith(cacheFirst(request, CACHE_STATIC));
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return caches.match('/index.html');
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_API);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    return cached || new Response('Hors ligne', { status: 503 });
  }
}

async function networkFirstWithFallback(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_DYNAMIC);
    cache.put(request, response.clone());
    return response;
  } catch (err) {
    return caches.match(request) || caches.match('/index.html');
  }
}

// ═══════════════════════════════════════════════════════════════
// BACKGROUND SYNC — réservations en attente envoyées dès retour réseau
// ═══════════════════════════════════════════════════════════════
self.addEventListener('sync', event => {
  console.log('[SW] Background Sync déclenché :', event.tag);
  if (event.tag === 'sync-reservations') {
    event.waitUntil(syncPendingReservations());
  }
  if (event.tag === 'sync-documents') {
    event.waitUntil(syncPendingDocuments());
  }
  if (event.tag === 'sync-avis') {
    event.waitUntil(syncPendingAvis());
  }
});

async function syncPendingReservations() {
  // Récupère les réservations stockées en attente dans IndexedDB
  try {
    const pending = await getFromIDB('pendingReservations');
    if (!pending || pending.length === 0) return;
    console.log('[SW] Synchronisation de', pending.length, 'réservations en attente');
    for (const reservation of pending) {
      try {
        const fd = new FormData();
        Object.entries(reservation.data).forEach(([k, v]) => fd.append(k, v));
        const res = await fetch('https://formsubmit.co/ajax/marchenriannis@gmail.com', {
          method: 'POST', body: fd, headers: { Accept: 'application/json' }
        });
        if (res.ok) {
          await removeFromIDB('pendingReservations', reservation.id);
          await showNotification('✅ Réservation envoyée', 'La réservation de '+reservation.data['👤 Client']+' a bien été synchronisée.');
        }
      } catch (e) {
        console.error('[SW] Erreur sync:', e);
      }
    }
  } catch (e) {
    console.error('[SW] syncPendingReservations error:', e);
  }
}

async function syncPendingDocuments() {
  console.log('[SW] Synchronisation des documents');
  // Similar logic for pending documents
}

async function syncPendingAvis() {
  console.log('[SW] Synchronisation des avis clients');
}

// ═══════════════════════════════════════════════════════════════
// PERIODIC BACKGROUND SYNC — vérification automatique périodique
// ═══════════════════════════════════════════════════════════════
async function registerPeriodicSync() {
  if ('periodicSync' in self.registration) {
    try {
      // Toutes les 6 heures : vérifier les nouvelles réservations
      await self.registration.periodicSync.register('check-new-reservations', {
        minInterval: 6 * 60 * 60 * 1000
      });
      // Toutes les 24 heures : mise à jour du cache des données
      await self.registration.periodicSync.register('refresh-cache', {
        minInterval: 24 * 60 * 60 * 1000
      });
      // Toutes les 12 heures : vérifier les alertes d'entretien
      await self.registration.periodicSync.register('check-entretien-alerts', {
        minInterval: 12 * 60 * 60 * 1000
      });
      console.log('[SW] Periodic Background Sync enregistré');
    } catch (err) {
      console.log('[SW] Periodic Sync non disponible:', err.message);
    }
  }
}

self.addEventListener('periodicsync', event => {
  console.log('[SW] Periodic Sync :', event.tag);
  if (event.tag === 'check-new-reservations') {
    event.waitUntil(checkNewReservations());
  }
  if (event.tag === 'refresh-cache') {
    event.waitUntil(refreshCache());
  }
  if (event.tag === 'check-entretien-alerts') {
    event.waitUntil(checkEntretienAlerts());
  }
});

async function checkNewReservations() {
  console.log('[SW] Vérification des nouvelles réservations');
  // Place pour vérifier auprès du serveur (à connecter avec ton back-end si besoin)
}

async function refreshCache() {
  console.log('[SW] Rafraîchissement du cache');
  const cache = await caches.open(CACHE_DYNAMIC);
  try {
    const fresh = await fetch('/index.html', { cache: 'no-store' });
    if (fresh.ok) await cache.put('/index.html', fresh);
  } catch (e) {
    console.log('[SW] Cache non rafraîchi:', e.message);
  }
}

async function checkEntretienAlerts() {
  console.log('[SW] Vérification alertes entretien');
  // Pour notification d'entretien à venir (vidange, CT, etc.)
  await showNotification(
    '🔧 Rappel entretien',
    'Pensez à vérifier les échéances d\'entretien de votre flotte.'
  );
}

// ═══════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(showNotification(
    data.title || "L'Atelier du Mécano",
    data.body || 'Nouveau message',
    data.url
  ));
});

async function showNotification(title, body, url = '/') {
  return self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-72.png',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    data: { url },
    actions: [
      { action: 'open', title: 'Ouvrir' },
      { action: 'close', title: 'Fermer' }
    ]
  });
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'close') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      // Réutiliser une fenêtre existante si possible
      for (const c of windowClients) {
        if (c.url.includes(self.registration.scope) && 'focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ═══════════════════════════════════════════════════════════════
// WIDGETS API (PWA Widgets — expérimental)
// ═══════════════════════════════════════════════════════════════
self.addEventListener('widgetinstall', event => {
  console.log('[SW] Widget installé :', event.widget.definition.tag);
  event.waitUntil(updateWidget(event.widget));
});

self.addEventListener('widgetresume', event => {
  console.log('[SW] Widget repris :', event.widget.definition.tag);
  event.waitUntil(updateWidget(event.widget));
});

self.addEventListener('widgetuninstall', event => {
  console.log('[SW] Widget désinstallé');
});

async function updateWidget(widget) {
  if (!self.widgets) return;
  const tag = widget.definition.tag;
  if (tag === 'depannage-urgent') {
    await self.widgets.updateByTag(tag, {
      template: JSON.stringify({
        type: 'AdaptiveCard',
        body: [{
          type: 'TextBlock',
          text: '🚨 Dépannage 24h/24',
          weight: 'Bolder',
          size: 'Large'
        }, {
          type: 'TextBlock',
          text: '06 68 83 36 87'
        }],
        actions: [{
          type: 'Action.OpenUrl',
          title: 'Appeler maintenant',
          url: 'tel:0668833687'
        }]
      }),
      data: JSON.stringify({ phone: '0668833687' })
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPER: IndexedDB pour stockage hors-ligne
// ═══════════════════════════════════════════════════════════════
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('MecanoPWA', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pendingReservations')) {
        db.createObjectStore('pendingReservations', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('pendingDocuments')) {
        db.createObjectStore('pendingDocuments', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('pendingAvis')) {
        db.createObjectStore('pendingAvis', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

async function getFromIDB(storeName) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function removeFromIDB(storeName, id) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE — communication avec la page principale
// ═══════════════════════════════════════════════════════════════
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'REGISTER_SYNC') {
    self.registration.sync.register(event.data.tag);
  }
});
