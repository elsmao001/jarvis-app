// Synchronise les fichiers locaux des agents vers Supabase (et les résultats d'appels dans l'autre sens).
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { db, PATHS, log, push } from './lib.mjs';

const ZONES = { 'Nouvelle-Aquitaine': 'N.-Aquitaine', 'Auvergne-Rhône-Alpes': 'AURA', 'Grand Est': 'Grand Est', 'Occitanie': 'Occitanie' };
const read = f => readFileSync(f, 'utf8').replace(/^﻿/, '');
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- Prospects (tableur CSV) ----------
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ';') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

export async function syncProspects() {
  if (!existsSync(PATHS.csv)) return;
  const rows = parseCsv(read(PATHS.csv)).filter(r => r.email && r.date_envoi);
  const data = rows.map(r => ({
    email: r.email.trim().toLowerCase(),
    entreprise: r.entreprise,
    zone: r.departement ? `${ZONES[r.region] || r.region} (${r.departement})` : (ZONES[r.region] || r.region),
    ville: r.ville || null,
    sent_on: r.date_envoi,
    angle: r.fait_reel || null,
    message_id: r.message_id || null,
    status: r.statut || 'envoyé',
    relance_on: r.relance || addDays(r.date_envoi, 5),
  }));
  if (data.length) {
    const { error } = await db().from('prospects').upsert(data, { onConflict: 'email', ignoreDuplicates: false });
    if (error) log('prospects :', error.message);
  }
}

// ---------- Réponses de prospects (déposées par les agents dans reponses.json) ----------
export async function syncReplies() {
  const f = join(PATHS.auto, 'reponses.json');
  if (!existsSync(f)) return;
  let list; try { list = JSON.parse(read(f)); } catch { return; }
  for (const r of list) {
    if (!r.email) continue;
    const email = r.email.toLowerCase();
    const { data: p } = await db().from('prospects').select('replied_at').eq('email', email).maybeSingle();
    if (p && p.replied_at) continue;
    await db().from('prospects').update({ replied_at: r.date || new Date().toISOString(), reply_snippet: r.extrait || '', status: 'a répondu' }).eq('email', email);
    if (p) await push({ title: `${r.entreprise || email} a répondu`, body: (r.extrait || '').slice(0, 140), tab: 'mails', tag: 'reply-' + email });
  }
}

// ---------- Prospects à appeler (À appeler.txt) ----------
export function parseCalls(text) {
  const out = [];
  for (const block of text.split(/\n(?===== )/)) {
    const h = block.match(/==== (\S+) — (.+?) \((.+?)\) ====/);
    if (!h) continue;
    const tel = block.match(/Portable : ([\d ]{14})\s*(?:\(([^)]*)\))?/);
    const g = k => (block.match(new RegExp(k + ' : (.+)')) || [])[1]?.trim() || '';
    out.push({
      added_on: h[1], nom: h[2].trim(), ville: h[3],
      phone: tel ? tel[1].trim() : '', who: tel && tel[2] && !/source/.test(tel[2]) ? tel[2] : '',
      hook: g("Accroche pour l'appel").replace(/^«\s*|\s*»$/g, ''),
      whatsapp: g('Message WhatsApp prêt à copier'),
    });
  }
  // Les plus récents d'abord, puis l'ordre du fichier (les agents y mettent les priorités en tête du jour)
  out.forEach((c, i) => { const [d, m, y] = c.added_on.split('/'); c.priority = -(Number(y + m + d)) * 100 + i; });
  return out;
}

export async function syncCalls() {
  if (!existsSync(PATHS.calls)) return;
  const calls = parseCalls(read(PATHS.calls));
  if (calls.length) {
    const { error } = await db().from('calls').upsert(calls, { onConflict: 'nom' });
    if (error) log('appels :', error.message);
  }
  // Retour : les résultats saisis dans l'app sont écrits dans le fichier, pour que les agents les voient.
  const { data: done } = await db().from('calls').select('nom, result, result_at').not('result', 'is', null);
  let text = read(PATHS.calls), changed = false;
  for (const c of done || []) {
    const date = new Date(c.result_at || Date.now()).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
    const re = new RegExp(`(==== \\S+ — ${c.nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\([^\\n]*\\n[\\s\\S]*?)\\[[ x]\\] Appelé le : [^\\n]*`);
    const line = `[x] Appelé le : ${date}   Résultat : ${c.result}`;
    const next = text.replace(re, `$1${line}`);
    if (next !== text) { text = next; changed = true; }
  }
  if (changed) writeFileSync(PATHS.calls, text);
}

// ---------- Passages des agents (logs) ----------
function levelOf(s) {
  const head = s.slice(0, 400);
  if (/bloqu|erreur|échou|impossible|refus/i.test(head)) return 'bad';
  if (/attention|⚠|manque|pas de vidéo|insuffisant/i.test(s)) return 'warn';
  return 'ok';
}

export async function syncRuns() {
  const dir = join(PATHS.auto, 'logs');
  if (!existsSync(dir)) return;
  const { data: known } = await db().from('agent_runs').select('log_file');
  const seen = new Set((known || []).map(r => r.log_file));
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(prospection|visuels|recap)-(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})\.log$/);
    if (!m || seen.has(f)) continue;
    const txt = read(join(dir, f));
    if (!/\nFin /.test(txt)) continue; // passage encore en cours
    const body = txt.replace(/^Démarrage.*\n/, '').replace(/\nFin .*\s*$/, '').trim();
    const title = (body.split('\n').find(l => l.trim()) || '').replace(/\*\*/g, '').slice(0, 160);
    const level = levelOf(body);
    const started = new Date(`${m[2]}T${m[3]}:${m[4]}:00+02:00`).toISOString();
    const { error } = await db().from('agent_runs').insert({ log_file: f, agent: m[1], started_at: started, level, title, summary: body.slice(0, 2500) });
    if (error) { log('passages :', error.message); continue; }
    if (level === 'bad' && Date.now() - new Date(started) < 36e5 * 12) {
      await push({ title: `Agent ${m[1]} bloqué`, body: title, tab: 'recap', tag: 'run-' + f });
    }
  }
}

// ---------- Alertes déposées par les agents (alertes.json) ----------
export async function syncAlerts() {
  const f = join(PATHS.auto, 'alertes.json');
  if (!existsSync(f)) return;
  let list; try { list = JSON.parse(read(f)); } catch { return; }
  for (const a of list) {
    const key = a.key || a.title;
    const { data: ex } = await db().from('alerts').select('id').eq('key', key).maybeSingle();
    if (ex) continue;
    await db().from('alerts').insert({ key, level: a.level || 'warn', title: a.title, body: a.body || '' });
    if (a.level === 'bad') await push({ title: a.title, body: a.body || '', tab: 'recap', tag: 'alert-' + key });
  }
}

// ---------- Posts à valider (dossiers de visuels contenant post.json) ----------
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

export async function syncPosts() {
  if (!existsSync(PATHS.visuels)) return;
  const { data: known } = await db().from('posts').select('folder');
  const seen = new Set((known || []).map(r => r.folder));
  for (const week of readdirSync(PATHS.visuels).filter(w => w.startsWith('Semaine du '))) {
    const wdir = join(PATHS.visuels, week);
    if (!statSync(wdir).isDirectory()) continue;
    for (const sub of readdirSync(wdir)) {
      const pdir = join(wdir, sub);
      const meta = join(pdir, 'post.json');
      const folder = `${week}/${sub}`;
      if (seen.has(folder) || !existsSync(meta)) continue;
      let p; try { p = JSON.parse(read(meta)); } catch { log('post.json illisible :', folder); continue; }
      const files = (p.files || readdirSync(pdir).filter(x => /^page-\d+\.png$/.test(x)).sort());
      const images = [];
      for (const file of files) {
        const key = `${slug(week)}/${slug(sub)}/${file}`;
        const type = file.endsWith('.mp4') ? 'video/mp4' : 'image/png';
        const { error } = await db().storage.from('visuels').upload(key, readFileSync(join(pdir, file)), { contentType: type, upsert: true });
        if (error) { log('upload :', key, error.message); continue; }
        images.push(key);
      }
      const row = {
        folder, day_label: p.jour || null, title: p.titre, kind: p.type || 'carrousel', images,
        text_li: p.linkedin || '', text_ig: p.instagram || '', canva_url: p.canva || null,
        chef_score: p.note_chef ?? null, chef_note: p.commentaire_chef || null,
        status: p.statut === 'publié' ? 'published' : 'pending',
      };
      const { error } = await db().from('posts').insert(row);
      if (error) { log('post :', error.message); continue; }
      log('nouveau post :', folder);
      if (row.status === 'pending' && !p.silencieux) {
        await push({ title: 'Carrousel prêt à valider', body: `« ${p.titre} »${p.note_chef ? ` · Chef ${p.note_chef}/10` : ''}`, tab: 'posts', tag: 'post-' + slug(folder) });
      }
    }
  }
}

export async function syncAll() {
  for (const [name, fn] of Object.entries({ syncProspects, syncReplies, syncCalls, syncRuns, syncAlerts, syncPosts })) {
    try { await fn(); } catch (e) { log(name, 'en échec :', e.message); }
  }
}
