// Small DOM + formatting helpers shared across screens.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const fmtScore = (n) => Math.round(n || 0).toLocaleString("en-US");

export function fmtDistance(km) {
  if (km == null) return "No guess";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString("en-US")} km`;
}

export function fmtClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function toast(message, kind = "info", ms = 3800) {
  const root = $("#toasts");
  const node = el(`<div class="toast toast-${kind}">${esc(message)}</div>`);
  root.appendChild(node);
  setTimeout(() => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 250);
  }, ms);
}

let modalCleanup = null;
export function openModal(html, { onClose, wide = false } = {}) {
  closeModal();
  const root = $("#modal-root");
  const prevFocus = document.activeElement;
  root.innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true">
      <button class="modal-x" data-close aria-label="Close">×</button>
      ${html}
    </div>`;
  root.classList.add("open");
  const modal = $(".modal", root);
  const onKey = (e) => { if (e.key === "Escape") closeModal(); };
  const onClick = (e) => { if (e.target.closest("[data-close]")) closeModal(); };
  document.addEventListener("keydown", onKey);
  root.addEventListener("click", onClick);
  modalCleanup = () => {
    document.removeEventListener("keydown", onKey);
    root.removeEventListener("click", onClick);
    root.classList.remove("open");
    root.innerHTML = "";
    onClose?.();
    prevFocus?.focus?.();
  };
  const first = $("input, button:not(.modal-x), select", modal);
  first?.focus();
  return modal;
}
export function closeModal() {
  const fn = modalCleanup;
  modalCleanup = null;
  fn?.();
}

export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(label || "Working…")}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = el(`<textarea style="position:fixed;opacity:0"></textarea>`);
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

// Turns Postgres / Supabase error text into something a player can act on.
export function friendlyError(err) {
  const msg = String(err?.message || err || "Something went wrong");
  if (/Invalid login credentials/i.test(msg)) return "That username and password don't match.";
  if (/Email not confirmed/i.test(msg)) return 'This account is waiting for email confirmation. Turn off "Confirm email" in Supabase and confirm the account (see README).';
  if (/signups? (are|is) disabled/i.test(msg)) return 'Sign-ups are switched off in Supabase. Turn on "Allow new users to sign up" and the Email provider.';
  if (/already registered|already been registered/i.test(msg)) return "That username is taken.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "Can't reach the server. Check your connection and try again.";
  if (/Password should be at least/i.test(msg)) return msg;
  if (/rate limit/i.test(msg)) return "Too many attempts. Wait a minute and try again.";
  if (/JWT|not authenticated|Please log in/i.test(msg)) return "Please log in first.";
  return msg;
}
