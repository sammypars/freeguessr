// Loads a classic <script> or stylesheet once, resolving when it's ready.
const loaded = new Map();

export function loadScript(url, errorMessage = "Couldn't load part of the game. Reload the page.") {
  const key = String(url);
  if (loaded.has(key)) return loaded.get(key);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = key;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loaded.delete(key); reject(new Error(errorMessage)); };
    document.head.appendChild(s);
  });
  loaded.set(key, p);
  return p;
}

export function loadCss(url) {
  const key = String(url);
  if (loaded.has(key) || document.querySelector(`link[href="${key}"]`)) return;
  loaded.set(key, true);
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = key;
  document.head.appendChild(l);
}
