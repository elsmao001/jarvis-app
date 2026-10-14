import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const CFG = window.JARVIS_CONFIG;
const sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, storageKey: 'jarvis-auth' } });

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = t => { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600); };
const TZ = 'Europe/Paris';
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // AAAA-MM-JJ
const fmtDay = iso => new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = iso => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtShort = iso => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: TZ });
const AGENT_NAMES = { prospection: 'Prospection', visuels: 'Visuels', recap: 'Récap du soir', jarvis: 'Jarvis' };

const S = { posts: [], prospects: [], calls: [], runs: [], alerts: [], messages: [], urls: {}, agent: 'prospection', heartbeat: null };

/* ---------------- Connexion ---------------- */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $('#login').hidden = false; $('#app').hidden = true; return; }
  $('#login').hidden = true; $('#app').hidden = false;
  const t = (location.hash || '').slice(1);
  go(['posts', 'mails', 'calls', 'recap', 'agents'].includes(t) ? t : 'posts');
  await loadAll();
  subscribe();
}
$('#login').addEventListener('submit', async e => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
  if (error) { $('#loginErr').textContent = 'E-mail ou mot de passe incorrect.'; return; }
  boot();
});

/* ---------------- Onglets ---------------- */
function go(s) {
  document.querySelectorAll('.screen[id^="s-"]').forEach(x => (x.hidden = x.id !== 's-' + s));
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t.dataset.s === s));
  history.replaceState(null, '', '#' + s);
  window.scrollTo({ top: 0 });
  if (s === 'agents') renderThread(true);
}
document.querySelectorAll('.tab').forEach(t => (t.onclick = () => go(t.dataset.s)));
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.tab) go(e.data.tab); });

/* ---------------- Données ---------------- */
async function loadAll() {
  const since = new Date(Date.now() - 4 * 864e5).toISOString();
  const [posts, prospects, calls, runs, alerts, messages, hb] = await Promise.all([
    sb.from('posts').select('*').order('created_at', { ascending: false }).limit(30),
    sb.from('prospects').select('*').order('sent_on', { ascending: false }),
    sb.from('calls').select('*').order('priority'),
    sb.from('agent_runs').select('*').gte('started_at', since).order('started_at', { ascending: false }),
    sb.from('alerts').select('*').eq('resolved', false).order('created_at', { ascending: false }),
    sb.from('messages').select('*').order('created_at').limit(300),
    sb.from('heartbeat').select('at').eq('id', 1).maybeSingle(),
  ]);
  for (const r of [posts, prospects, calls, runs, alerts, messages]) if (r.error) { toast('Erreur de chargement : ' + r.error.message); }
  Object.assign(S, { posts: posts.data || [], prospects: prospects.data || [], calls: calls.data || [], runs: runs.data || [], alerts: alerts.data || [], messages: messages.data || [], heartbeat: hb.data?.at || null });
  await signImages();
  render();
}

async function signImages() {
  const need = S.posts.flatMap(p => p.images.slice(0, p.status === 'pending' || p.status === 'failed' ? 99 : 1)).filter(k => !S.urls[k]);
  if (!need.length) return;
  const { data } = await sb.storage.from('visuels').createSignedUrls(need, 3600 * 12);
  for (const d of data || []) if (d.signedUrl) S.urls[d.path] = d.signedUrl;
}

let reloadTimer;
function subscribe() {
  sb.channel('jarvis')
    .on('postgres_changes', { event: '*', schema: 'public' }, () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 400); })
    .subscribe(st => { $('#live').style.background = st === 'SUBSCRIBED' ? 'var(--ok)' : 'var(--warn)'; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAll(); });
}

/* ---------------- Rendu ---------------- */
function render() {
  const t = today();
  $('#dateTitle').textContent = fmtDay(t).replace(/^./, c => c.toUpperCase());
  const pending = S.posts.filter(p => ['pending', 'approved', 'publishing', 'failed'].includes(p.status));
  const toValidate = S.posts.filter(p => p.status === 'pending' || p.status === 'failed').length;
  const mailsToday = S.prospects.filter(p => p.sent_on === t).length;
  const callsLeft = S.calls.filter(c => !c.result).length;
  const replies = S.prospects.filter(p => p.replied_at).length;
  $('#k-posts').textContent = toValidate; $('#k-mails').textContent = mailsToday; $('#k-calls').textContent = callsLeft;
  badge('posts', toValidate); badge('calls', callsLeft); badge('recap', S.alerts.length);
  badge('mails', S.prospects.filter(p => p.replied_at && Date.now() - new Date(p.replied_at) < 864e5 * 3).length);

  // Posts
  $('#pending').innerHTML = pending.length ? pending.map(postCard).join('') : '<p class="empty">Rien à valider. Le prochain visuel arrive lundi, mercredi ou vendredi à 10 h, avec une notification.</p>';
  pending.forEach(wireCarousel);
  $('#postAlerts').innerHTML = S.alerts.filter(a => /elevenlabs|vidéo|visuel/i.test(a.title)).map(alertHtml).join('');
  const recent = S.posts.filter(p => !pending.includes(p)).slice(0, 8);
  $('#recentPosts').innerHTML = recent.length ? recent.map(p => `<div class="row withimg"><img class="mini" alt="" src="${S.urls[p.images[0]] || ''}"><span class="t">${esc(p.title)}</span><span class="r chip ${p.status === 'published' ? 'ok' : ''}">${p.status === 'published' ? 'Publié ' + fmtShort(p.published_at) : 'Refusé'}</span><span class="m">${esc(p.day_label || '')} · ${esc(p.kind)}</span></div>`).join('') : '<p class="empty">Aucun post publié pour l\'instant.</p>';

  // Mails
  const total = S.prospects.length || 1;
  const bar = (label, n, dim) => `<div class="bar"><span>${label}</span><span class="track"><span class="fill ${dim ? 'dim' : ''}" style="width:${Math.round((n / total) * 100)}%;display:block"></span></span><b>${n}</b></div>`;
  $('#funnel').innerHTML = bar('Envoyés', S.prospects.length) + bar('Réponses', replies) + bar('Relancés', S.prospects.filter(p => p.status === 'relancé').length, true);
  const nextRel = S.prospects.filter(p => !p.replied_at && p.relance_on >= t).map(p => p.relance_on).sort()[0];
  const nRel = S.prospects.filter(p => !p.replied_at && p.relance_on === nextRel).length;
  $('#relanceInfo').innerHTML = nextRel ? `<div class="alert info"><div><b>Prochaines relances le ${fmtShort(nextRel)}</b><span>${nRel} prospect${nRel > 1 ? 's' : ''} sans réponse, relancé${nRel > 1 ? 's' : ''} dans le même fil.</span></div></div>` : '';
  const rep = S.prospects.filter(p => p.replied_at).sort((a, b) => b.replied_at.localeCompare(a.replied_at));
  $('#replies').innerHTML = rep.length ? rep.map(p => `<div class="reply"><b>${esc(p.entreprise)}</b><span>${esc(p.reply_snippet || 'Réponse reçue')}</span><small class="sub" style="margin:0">${fmtShort(p.replied_at)} · ${esc(p.email)}</small></div>`).join('') : '<p class="empty">Aucune pour l\'instant. Une réponse déclenche une notification.</p>';
  const days = [...new Set(S.prospects.map(p => p.sent_on))].sort().reverse();
  $('#mailDays').innerHTML = days.map(d => `<h2 style="margin:18px 0 0">Envoyés le ${fmtShort(d)}</h2><div class="list">${S.prospects.filter(p => p.sent_on === d).map(p => `<div class="row"><span class="t">${esc(p.entreprise)}</span><span class="r chip ${p.replied_at ? 'ok' : ''}">${p.replied_at ? 'A répondu' : esc(p.zone || '')}</span><span class="m">${esc(p.angle || p.email)}</span></div>`).join('')}</div>`).join('');

  // Appels
  renderCalls();

  // Récap
  $('#recapSub').textContent = `${S.runs.filter(r => r.started_at.slice(0, 10) === t).length} passage(s) aujourd'hui · ${S.alerts.length} alerte(s)`;
  $('#alerts').innerHTML = S.alerts.map(alertHtml).join('');
  $('#runs').innerHTML = S.runs.length ? S.runs.map(r => `<div class="ev ${r.level === 'ok' ? '' : r.level}"><time>${fmtShort(r.started_at)} ${fmtTime(r.started_at)} · ${AGENT_NAMES[r.agent] || r.agent}</time><strong>${esc(r.title)}</strong><details><summary>Détails</summary><p>${esc(r.summary.replace(/\*\*/g, ''))}</p></details></div>`).join('') : '<p class="empty">Aucun passage ces 4 derniers jours.</p>';

  renderThread();
  macState();
}

function badge(id, n) { const b = $('#b-' + id); b.hidden = !n; b.textContent = n > 99 ? '99+' : n; }

function alertHtml(a) {
  return `<div class="alert ${a.level === 'warn' ? '' : a.level}"><div class="alert-wrap"><div><b>${esc(a.title)}</b><span>${esc(a.body || '')}</span></div><button class="x" data-resolve="${a.id}">Réglé</button></div></div>`;
}
document.addEventListener('click', async e => {
  const id = e.target.dataset?.resolve; if (!id) return;
  await sb.from('alerts').update({ resolved: true }).eq('id', id);
  S.alerts = S.alerts.filter(a => a.id !== id); render(); toast('Alerte classée');
});

/* ---------------- Carte post ---------------- */
function postCard(p) {
  const imgs = p.images.map((k, i) => k.endsWith('.mp4')
    ? `<video src="${S.urls[k] || ''}" controls playsinline style="flex:none;width:78%;border-radius:12px"></video>`
    : `<img src="${S.urls[k] || ''}" alt="Page ${i + 1}" loading="lazy">`).join('');
  const state = { approved: 'En file de publication…', publishing: 'Publication en cours…', failed: 'Échec de la publication' }[p.status];
  return `<article class="post ${p.status === 'failed' ? 'failed' : ''}" data-id="${p.id}">
    <div class="post-head"><span class="chip amber">${esc(p.kind === 'video' ? 'Vidéo' : `Carrousel · ${p.images.length} pages`)}</span>${p.day_label ? `<span class="chip">${esc(p.day_label)}</span>` : ''}${state ? `<span class="chip ${p.status === 'failed' ? 'bad' : 'info'}">${state}</span>` : ''}</div>
    <div class="slides">${imgs}</div><div class="dots"></div>
    <div class="post-body">
      <h3>${esc(p.title)}</h3>
      <div class="seg" role="group" aria-label="Réseau"><button aria-pressed="true" data-net="li">LinkedIn</button><button aria-pressed="false" data-net="ig">Instagram</button></div>
      <div class="copy">${esc(p.text_li)}</div>
      <button class="more">Lire tout le texte</button>
      ${p.chef_score ? `<div class="score"><b>${p.chef_score}/10</b><span>Note du Chef${p.chef_note ? ' · ' + esc(p.chef_note) : ''}</span></div>` : ''}
      ${p.canva_url ? `<a href="${esc(p.canva_url)}" target="_blank" rel="noopener" style="font-size:13px;font-weight:600">Ouvrir dans Canva ↗</a>` : ''}
    </div>
    ${p.status === 'failed' && p.error ? `<p class="post-err">${esc(p.error)}</p>` : ''}
    ${p.status === 'pending' || p.status === 'failed' ? `<div class="actions"><button class="btn primary" data-act="publish">${p.status === 'failed' ? 'Réessayer' : 'Publier'}</button><button class="btn ghost" data-act="edit">Modifier</button><button class="btn ghost" data-act="reject" aria-label="Refuser">✕</button></div>` : ''}
  </article>`;
}

function wireCarousel(p) {
  const card = document.querySelector(`.post[data-id="${p.id}"]`); if (!card) return;
  const slides = card.querySelector('.slides'), dots = card.querySelector('.dots');
  dots.innerHTML = [...slides.children].map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('');
  slides.addEventListener('scroll', () => {
    const w = slides.children[0].getBoundingClientRect().width + 8;
    const i = Math.round(slides.scrollLeft / w);
    [...dots.children].forEach((d, j) => d.classList.toggle('on', i === j));
  }, { passive: true });
  card.querySelectorAll('.seg button').forEach(b => (b.onclick = () => {
    card.querySelector('.copy').textContent = b.dataset.net === 'li' ? p.text_li : p.text_ig;
    card.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', x === b));
  }));
  card.querySelector('.more').onclick = e => { const o = card.querySelector('.copy').classList.toggle('open'); e.target.textContent = o ? 'Réduire' : 'Lire tout le texte'; };
  card.querySelectorAll('[data-act]').forEach(b => (b.onclick = () => postAction(p, b.dataset.act)));
}

let current;
const sheet = $('#sheet'), bg = $('#sheetBg');
const openSheet = el => { el.classList.add('show'); bg.classList.add('show'); };
const closeSheets = () => { document.querySelectorAll('.sheet').forEach(x => x.classList.remove('show')); bg.classList.remove('show'); };
bg.onclick = closeSheets; $('#cancel').onclick = closeSheets;

async function postAction(p, act) {
  current = p;
  if (act === 'publish') { $('#c-li').checked = p.networks.includes('linkedin'); $('#c-ig').checked = p.networks.includes('instagram'); openSheet(sheet); }
  if (act === 'reject') {
    await sb.from('posts').update({ status: 'rejected', decided_at: new Date().toISOString() }).eq('id', p.id);
    toast('Post refusé'); loadAll();
  }
  if (act === 'edit') { go('agents'); pickAgent('visuels'); $('#msg').value = `Sur « ${p.title} » : `; $('#msg').focus(); }
}
$('#confirm').onclick = async () => {
  const networks = [$('#c-li').checked && 'linkedin', $('#c-ig').checked && 'instagram'].filter(Boolean);
  if (!networks.length) { toast('Choisis au moins un réseau'); return; }
  const { error } = await sb.from('posts').update({ status: 'approved', networks, decided_at: new Date().toISOString(), error: null }).eq('id', current.id);
  closeSheets();
  if (error) { toast('Impossible : ' + error.message); return; }
  toast('Validé. Publication dans la minute.'); loadAll();
};

/* ---------------- Appels ---------------- */
function renderCalls() {
  const list = [...S.calls.filter(c => !c.result), ...S.calls.filter(c => c.result)];
  $('#calls').innerHTML = list.length ? list.map((c, i) => `<div class="call ${i === 0 && !c.result ? 'top1' : ''}" data-id="${c.id}">
      <div class="call-h"><div><strong>${esc(c.nom)}</strong><small>${esc(c.ville)}${c.who ? ' · ' + esc(c.who) : ''}</small></div>${c.result ? `<span class="chip ${c.result === 'Intéressé' ? 'ok' : ''}">${esc(c.result)}</span>` : `<span class="chip">${esc(c.added_on.slice(0, 5))}</span>`}</div>
      <span class="tel">${esc(c.phone)}</span>
      <p class="hook">« ${esc(c.hook)} »</p>
      <div class="call-a">
        <a class="btn small primary" href="tel:${esc(c.phone.replace(/ /g, ''))}">Appeler</a>
        ${c.whatsapp ? `<button class="btn small" data-wa>Copier WhatsApp</button>` : ''}
        <button class="btn small ghost" data-hook>Accroche</button>
      </div>
      <div class="res" role="group" aria-label="Résultat de l'appel">${['Intéressé', 'Rappeler', 'Pas de réponse', 'Pas intéressé'].map(r => `<button class="${r === 'Intéressé' ? 'ok' : r === 'Rappeler' ? 'rdv' : 'no'}" data-r="${r}" aria-pressed="${c.result === r}">${r}</button>`).join('')}</div>
    </div>`).join('') : '<p class="empty">Personne à appeler.</p>';
}
$('#calls').addEventListener('click', async e => {
  const card = e.target.closest('.call'); if (!card) return;
  const c = S.calls.find(x => x.id === card.dataset.id);
  if (e.target.hasAttribute('data-hook')) { card.classList.toggle('open'); return; }
  if (e.target.hasAttribute('data-wa')) { navigator.clipboard.writeText(c.whatsapp).then(() => toast('Message WhatsApp copié'), () => toast('Copie impossible')); return; }
  const r = e.target.dataset.r; if (!r) return;
  const result = c.result === r ? null : r;
  c.result = result; renderCalls(); badge('calls', S.calls.filter(x => !x.result).length);
  const { error } = await sb.from('calls').update({ result, result_at: result ? new Date().toISOString() : null }).eq('id', c.id);
  toast(error ? 'Non enregistré : ' + error.message : result ? `${c.nom} : ${result}` : 'Résultat effacé');
});

/* ---------------- Chat agents ---------------- */
const SUGG = {
  prospection: ['Où en est la prospection ?', 'Passe au département suivant demain', 'Qui dois-je appeler en premier ?'],
  visuels: ['Idée de sujet pour vendredi ?', 'Ton plus direct sur le prochain', 'Fais un sujet sur le dépôt-vente'],
  recap: ['Résume-moi la journée', 'Ajoute les appels du jour au récap'],
  jarvis: ['Prépare ma journée de demain', 'Où en est Luxuor ?'],
};
function pickAgent(a) {
  S.agent = a;
  document.querySelectorAll('.agent').forEach(b => b.setAttribute('aria-pressed', b.dataset.a === a));
  $('#sugg').innerHTML = SUGG[a].map(s => `<button type="button">${esc(s)}</button>`).join('');
  renderThread(true);
}
function renderThread(scroll) {
  const msgs = S.messages.filter(m => m.agent === S.agent);
  const waiting = msgs.some(m => m.role === 'me' && (m.status === 'new' || m.status === 'processing'));
  $('#thread').innerHTML = (msgs.length ? msgs.map(m => `<div class="msg ${m.role === 'me' ? 'me' : 'bot'}">${esc(m.body)}<small>${fmtShort(m.created_at)} ${fmtTime(m.created_at)}</small></div>`).join('') : `<p class="empty">Écris à l'agent ${AGENT_NAMES[S.agent]}. Il répond depuis ton Mac, en général en moins d'une minute.</p>`)
    + (waiting ? `<p class="typing">${AGENT_NAMES[S.agent]} réfléchit…</p>` : '');
  if (scroll && !$('#s-agents').hidden) window.scrollTo({ top: document.body.scrollHeight });
}
document.querySelectorAll('.agent').forEach(b => (b.onclick = () => pickAgent(b.dataset.a)));
$('#sugg').onclick = e => { if (e.target.tagName === 'BUTTON') { $('#msg').value = e.target.textContent; $('#msg').focus(); } };
$('#composer').onsubmit = async e => {
  e.preventDefault();
  const body = $('#msg').value.trim(); if (!body) return;
  $('#msg').value = '';
  const { data, error } = await sb.from('messages').insert({ agent: S.agent, role: 'me', body }).select().single();
  if (error) { toast('Non envoyé : ' + error.message); $('#msg').value = body; return; }
  S.messages.push(data); renderThread(true);
};
$('#msg').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $('#composer').requestSubmit(); } });
pickAgent('prospection');

/* ---------------- Réglages, notifications ---------------- */
function macState() {
  const hb = S.heartbeat ? new Date(S.heartbeat) : null;
  const ok = hb && Date.now() - hb < 3 * 60_000;
  $('#macState').textContent = ok ? 'En ligne, les agents répondent' : hb ? `Hors ligne depuis le ${fmtShort(S.heartbeat)} à ${fmtTime(S.heartbeat)}` : 'Jamais connecté';
  $('#live').title = ok ? 'Mac en ligne' : 'Mac hors ligne';
  if (!ok) $('#live').style.background = 'var(--warn)';
}
async function pushState() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    $('#pushState').textContent = standalone ? 'Non pris en charge sur cet appareil' : 'Ajoute d\'abord l\'app à l\'écran d\'accueil (Partager > Sur l\'écran d\'accueil)';
    $('#enablePush').hidden = true; return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  $('#pushState').textContent = sub ? 'Activées sur cet appareil' : Notification.permission === 'denied' ? 'Refusées : à réactiver dans Réglages iPhone > Notifications > Jarvis' : 'Désactivées';
  $('#enablePush').hidden = !!sub;
}
$('#openSettings').onclick = () => { pushState(); openSheet($('#settings')); };
$('#closeSettings').onclick = closeSheets;
$('#logout').onclick = async () => { await sb.auth.signOut(); location.reload(); };
$('#enablePush').onclick = async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications refusées'); return pushState(); }
    const reg = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(CFG.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - CFG.vapidPublicKey.length % 4) % 4)), c => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({ endpoint: json.endpoint, sub: json, device: navigator.userAgent.slice(0, 120) });
    if (error) throw error;
    toast('Notifications activées'); pushState();
  } catch (err) { toast('Échec : ' + err.message); }
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
boot();
