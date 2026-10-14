// Prépare la config : clés de notification (VAPID), fichier .env du worker et config de l'app web.
// Usage : node setup.mjs <SUPABASE_URL> <ANON_KEY> <SERVICE_ROLE_KEY>
import { writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import webpush from 'web-push';

const [url, anon, service] = process.argv.slice(2);
if (!url || !anon || !service) {
  console.log('Usage : node setup.mjs <SUPABASE_URL> <ANON_KEY> <SERVICE_ROLE_KEY>');
  process.exit(1);
}
let vapid = {};
if (existsSync('.env')) {
  const env = readFileSync('.env', 'utf8');
  vapid.publicKey = (env.match(/VAPID_PUBLIC=(.+)/) || [])[1];
  vapid.privateKey = (env.match(/VAPID_PRIVATE=(.+)/) || [])[1];
}
if (!vapid.publicKey) vapid = webpush.generateVAPIDKeys();

writeFileSync('.env', `SUPABASE_URL=${url}\nSUPABASE_SERVICE_KEY=${service}\nVAPID_PUBLIC=${vapid.publicKey}\nVAPID_PRIVATE=${vapid.privateKey}\n`);
chmodSync('.env', 0o600);
writeFileSync('../web/config.js', `// Généré par worker/setup.mjs. La clé anon est publique par nature : la sécurité vient des règles RLS.\nwindow.JARVIS_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: anon, vapidPublicKey: vapid.publicKey }, null, 2)};\n`);
console.log('OK : worker/.env et web/config.js écrits.');
