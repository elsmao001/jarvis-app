// Outils partagés du worker : config, client Supabase, notifications push, journal.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

// .env local (jamais commité) : SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC, VAPID_PRIVATE
export function loadEnv() {
  const file = join(HERE, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

export const PATHS = {
  auto: process.env.AUTO_DIR || join(HOME, 'Projets/Agent IA autovaluer/automatisations'),
  visuels: process.env.VISUELS_DIR || join(HOME, 'Desktop/Visuels AutoValuerPro'),
  calls: process.env.CALLS_FILE || join(HOME, 'Desktop/Prospects à appeler/À appeler.txt'),
  csv: process.env.CSV_FILE || join(HOME, 'Desktop/Prospects à appeler/Prospection AutoValuerPro.csv'),
  jarvis: process.env.JARVIS_DIR || join(HOME, 'jarvis-local/jarvis-starter-kit'),
};

export const APP_URL = process.env.APP_URL || '';

let _db;
export function db() {
  if (_db) return _db;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL et SUPABASE_SERVICE_KEY manquent dans worker/.env');
  _db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  return _db;
}

export function log(...a) {
  const t = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  console.log(`[${t}]`, ...a);
}

// Envoie une notification à tous les appareils abonnés. tab = onglet à ouvrir.
export async function push({ title, body, tab = 'posts', tag }) {
  const { VAPID_PUBLIC, VAPID_PRIVATE } = process.env;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return log('push ignoré : clés VAPID absentes');
  webpush.setVapidDetails('mailto:celissemaxence20@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);
  const { data: subs } = await db().from('push_subscriptions').select('endpoint, sub');
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ title, body, tab, tag }), { TTL: 86400 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db().from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      } else log('push en échec :', e.statusCode || e.message);
    }
  }
}
