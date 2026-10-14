// Worker du Mac : synchronise les agents avec l'app, publie les posts validés, fait répondre les agents au chat.
// Lancé en continu par launchd (fr.jarvis.worker).
import { spawn } from 'node:child_process';
import { db, PATHS, log, push } from './lib.mjs';
import { syncAll } from './sync.mjs';

const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const SYNC_EVERY = 60_000;
const POLL_EVERY = 15_000;

// Lance `claude -p` et renvoie sa sortie texte.
function runClaude(prompt, { cwd, tools, timeout = 6 * 60_000 }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', ...tools];
    const child = spawn(CLAUDE, args, { cwd, env: { ...process.env, MCP_TIMEOUT: '60000' } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Délai dépassé')); }, timeout);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || out.trim() || `code ${code}`)); });
  });
}

// ---------- Publication des posts validés ----------
async function publishApproved() {
  const { data: posts } = await db().from('posts').select('*').eq('status', 'approved').order('decided_at').limit(1);
  const p = posts && posts[0];
  if (!p) return;
  await db().from('posts').update({ status: 'publishing' }).eq('id', p.id);
  log('publication :', p.title, p.networks);
  try {
    const { data: signed, error } = await db().storage.from('visuels').createSignedUrls(p.images, 60 * 60 * 24);
    if (error) throw error;
    const urls = signed.map(s => s.signedUrl);
    const nets = p.networks.map(n => (n === 'linkedin' ? 'LinkedIn' : 'Instagram')).join(' et ');
    const prompt = `Publie MAINTENANT ce post sur ${nets} avec Orshot, sans poser de question.
1. Appelle orshot_list_social_accounts pour trouver le compte ${nets} connecté. S'il en manque un, ne publie pas sur ce réseau et dis-le.
2. Publie avec orshot_publish_social_post (publication immédiate, pas de brouillon), avec ces médias dans cet ordre (${p.kind}) :
${urls.map((u, i) => `   ${i + 1}. ${u}`).join('\n')}
${p.networks.includes('linkedin') ? `3. Texte LinkedIn, à reprendre mot pour mot :\n<<<\n${p.text_li}\n>>>` : ''}
${p.networks.includes('instagram') ? `4. Légende Instagram, à reprendre mot pour mot :\n<<<\n${p.text_ig}\n>>>` : ''}
Termine ta réponse par UNE ligne exactement de la forme :
RESULTAT: OK
ou
RESULTAT: ERREUR <raison courte en français>`;
    const out = await runClaude(prompt, { cwd: PATHS.auto, tools: ['mcp__claude_ai_Orshot'] });
    const last = (out.match(/RESULTAT:\s*(.+)\s*$/) || [])[1] || 'ERREUR réponse illisible';
    if (/^OK/.test(last)) {
      await db().from('posts').update({ status: 'published', published_at: new Date().toISOString(), error: null }).eq('id', p.id);
      await push({ title: 'Publié ✓', body: `« ${p.title} » est en ligne sur ${nets}.`, tab: 'posts', tag: 'pub-' + p.id });
    } else throw new Error(last.replace(/^ERREUR\s*/, ''));
  } catch (e) {
    log('publication en échec :', e.message);
    await db().from('posts').update({ status: 'failed', error: e.message.slice(0, 500) }).eq('id', p.id);
    await push({ title: 'Publication en échec', body: e.message.slice(0, 140), tab: 'posts', tag: 'pub-' + p.id });
  }
}

// ---------- Chat avec les agents ----------
const AGENTS = {
  prospection: {
    nom: 'Prospection', cwd: () => PATHS.auto,
    role: "Tu es l'agent Prospection d'AutoValuerPro (prospection e-mail des garages et mandataires). Tes consignes complètes sont dans prospection-mail.md, le ciblage dans ciblage.txt, le suivi dans notes-du-jour.txt et historique-prospection.txt.",
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread'],
  },
  visuels: {
    nom: 'Visuels', cwd: () => PATHS.auto,
    role: `Tu es l'agent Visuels d'AutoValuerPro (carrousels et vidéos LinkedIn/Instagram faits dans Canva). Tes consignes sont dans visuels-hebdo.md, les visuels dans ${PATHS.visuels}.`,
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  },
  recap: {
    nom: 'Récap', cwd: () => PATHS.auto,
    role: 'Tu es l\'agent Récap du soir d\'AutoValuerPro. Tes consignes sont dans recap-soir.md, les journaux des agents dans logs/.',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'mcp__claude_ai_Gmail__search_threads'],
  },
  jarvis: {
    nom: 'Jarvis', cwd: () => PATHS.jarvis,
    role: "Tu es Jarvis, l'assistant personnel de Maxence. Lis CLAUDE.md et context/CONTEXT.md avant de répondre.",
    tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  },
};

async function answerMessages() {
  const { data: msgs } = await db().from('messages').select('*').eq('role', 'me').eq('status', 'new').order('created_at').limit(1);
  const m = msgs && msgs[0];
  if (!m) return;
  const a = AGENTS[m.agent] || AGENTS.jarvis;
  await db().from('messages').update({ status: 'processing' }).eq('id', m.id);
  const { data: hist } = await db().from('messages').select('role, body, created_at').eq('agent', m.agent).lt('created_at', m.created_at).order('created_at', { ascending: false }).limit(12);
  const thread = (hist || []).reverse().map(h => `${h.role === 'me' ? 'Maxence' : a.nom} : ${h.body}`).join('\n');
  const prompt = `${a.role}
Maxence t'écrit depuis son app mobile. Réponds en français, directement, en 2 à 8 phrases courtes (c'est lu sur un téléphone). Pas de tirets longs, pas de markdown lourd.
S'il te demande de changer ta façon de travailler (cible, ton, horaires, sujets…), modifie toi-même le fichier de consignes ou de suivi concerné, puis dis-lui en une phrase ce que tu as changé. N'envoie jamais d'e-mail et ne publie rien depuis cette conversation.
${thread ? `\nConversation récente :\n${thread}\n` : ''}
Nouveau message de Maxence : ${m.body}`;
  try {
    const out = await runClaude(prompt, { cwd: a.cwd(), tools: a.tools });
    await db().from('messages').insert({ agent: m.agent, role: 'bot', body: out.slice(0, 4000), status: 'done' });
    await db().from('messages').update({ status: 'done' }).eq('id', m.id);
    await push({ title: `${a.nom} a répondu`, body: out.slice(0, 140), tab: 'agents', tag: 'chat-' + m.agent });
  } catch (e) {
    log('chat en échec :', e.message);
    await db().from('messages').update({ status: 'failed' }).eq('id', m.id);
    await db().from('messages').insert({ agent: m.agent, role: 'bot', body: `Je n'ai pas pu répondre : ${e.message.slice(0, 200)}`, status: 'done' });
  }
}

// ---------- Détection des réponses (toutes les heures, de 8 h à 21 h) ----------
let lastReplyCheck = 0;
async function checkReplies() {
  const h = Number(new Date().toLocaleString('fr-FR', { hour: '2-digit', hour12: false, timeZone: 'Europe/Paris' }));
  if (h < 8 || h > 21 || Date.now() - lastReplyCheck < 60 * 60_000) return;
  lastReplyCheck = Date.now();
  const { data: list } = await db().from('prospects').select('email, entreprise').is('replied_at', null);
  if (!list?.length) return;
  const prompt = `Cherche dans Gmail (search_threads) les messages reçus ces 3 derniers jours envoyés PAR l'une de ces adresses ou leur domaine professionnel (ignore gmail.com, hotmail.com, orange.fr, wanadoo.fr, bbox.fr comme domaine) :
${list.map(p => p.email).join(', ')}
Ignore les messages envoyés par celissemaxence20@gmail.com ou maxence@autovaluerpro.fr, et les réponses automatiques (absence, accusé de réception).
Pour chaque vraie réponse trouvée, lis le fil (get_thread) et résume-la en une phrase.
Réponds UNIQUEMENT par un tableau JSON, sans texte autour : [{"email":"...","entreprise":"...","date":"AAAA-MM-JJTHH:MM","extrait":"..."}] ou [] si rien.`;
  try {
    const out = await runClaude(prompt, { cwd: PATHS.auto, tools: ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread'], timeout: 4 * 60_000 });
    const found = JSON.parse((out.match(/\[[\s\S]*\]/) || ['[]'])[0]);
    for (const r of found) {
      const email = String(r.email || '').toLowerCase();
      const p = list.find(x => x.email === email);
      if (!p) continue;
      await db().from('prospects').update({ replied_at: r.date ? new Date(r.date).toISOString() : new Date().toISOString(), reply_snippet: r.extrait || '', status: 'a répondu' }).eq('email', email);
      await push({ title: `${p.entreprise} a répondu`, body: (r.extrait || '').slice(0, 140), tab: 'mails', tag: 'reply-' + email });
    }
  } catch (e) { log('vérif réponses :', e.message); }
}

// ---------- Boucle principale ----------
let busy = false, lastSync = 0;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    await db().from('heartbeat').upsert({ id: 1, at: new Date().toISOString() });
    if (Date.now() - lastSync > SYNC_EVERY) { await syncAll(); lastSync = Date.now(); }
    await publishApproved();
    await answerMessages();
    await checkReplies();
  } catch (e) { log('tick :', e.message); }
  busy = false;
}

log('Worker Jarvis démarré');
await db().from('messages').update({ status: 'new' }).eq('status', 'processing'); // reprise après coupure
// Jamais de republication automatique après coupure : risque de doublon sur LinkedIn.
await db().from('posts').update({ status: 'failed', error: 'Interrompu pendant la publication. Vérifie LinkedIn avant de réessayer.' }).eq('status', 'publishing');
tick();
setInterval(tick, POLL_EVERY);
