// "Install app" support: registers the service worker (production, https or
// localhost only) and shows an INSTALL button on the title screen. Android
// Chrome supplies a real install prompt; iOS has none, so there it explains
// Share -> Add to Home Screen.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

let deferred: InstallPromptEvent | null = null;

function standalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function setupInstall() {
  if (import.meta.env.PROD && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (standalone()) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const btn = document.createElement('button');
  btn.className = 'alt';
  btn.id = 'installBtn';
  btn.textContent = '📲 INSTALL APP';
  btn.style.display = 'none';
  btn.onclick = async () => {
    if (deferred) {
      await deferred.prompt();
      deferred = null;
      btn.style.display = 'none';
    } else {
      alert('To install: tap the Share button, then "Add to Home Screen".');
    }
  };
  document.getElementById('scrTitle')?.appendChild(btn);

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    btn.style.display = '';
  });
  addEventListener('appinstalled', () => { btn.style.display = 'none'; });
  if (isIOS) btn.style.display = '';
}
