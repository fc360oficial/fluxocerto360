// FC360 API — entrada do processo no .254 (porta 3013, só localhost; o Econômico
// Relatórios faz proxy de /fc360-api/* pra cá e mantém este processo vivo).
//
// Autenticação (fase 1): o app continua logando no Firebase; aqui a gente só
// verifica o ID token e resolve o usuário na coleção `usuarios`, com cache em
// memória por 1h (≈ 1 leitura do Firestore por usuário por hora, nada mais).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { criarPool, migrar } = require('./lib/db');
const { createApp } = require('./lib/app');

const BUILD = require('./package.json').version;
const PORT = Number(process.env.PORT) || 3013;
const FOTOS_RAIZ = process.env.FOTOS_DIR || path.join(__dirname, 'data', 'fotos');

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL ausente no .env'); process.exit(1); }
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) { console.error('GOOGLE_APPLICATION_CREDENTIALS ausente no .env'); process.exit(1); }

const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
initializeApp({ credential: cert(require(path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS))) });
const firestore = getFirestore();

const CACHE_MS = 60 * 60 * 1000;
const cacheUsuarios = new Map(); // email -> { usuario, ate }

async function usuarioPorEmail(email) {
  const agora = Date.now();
  const c = cacheUsuarios.get(email);
  if (c && c.ate > agora) return c.usuario;
  const snap = await firestore.collection('usuarios').where('email', '==', email).limit(1).get();
  const usuario = snap.empty ? null : Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());
  if (usuario && usuario.ativo === false) return null;
  cacheUsuarios.set(email, { usuario, ate: agora + (usuario ? CACHE_MS : 60 * 1000) });
  return usuario;
}

async function autenticar(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const decoded = await getAuth().verifyIdToken(token);
  const email = (decoded.email || '').toLowerCase();
  if (!email) return null;
  const u = await usuarioPorEmail(email);
  if (!u) return null;
  return { id: u.id, email, clienteId: u.clienteId || 'economico', loja: u.loja || '', nome: u.nome || '', perfil: u.perfil || '' };
}

(async () => {
  const pool = criarPool(process.env.DATABASE_URL);
  const aplicadas = await migrar(pool);
  if (aplicadas.length) console.log(new Date().toISOString(), 'migrações aplicadas:', aplicadas.join(', '));
  const app = createApp({ pool, fotosRaiz: FOTOS_RAIZ, autenticar, build: BUILD,
    origens: (process.env.ALLOWED_ORIGIN || 'https://fc360oficial.github.io').split(',').map(s => s.trim()).filter(Boolean) });
  app.listen(PORT, '127.0.0.1', () => console.log(new Date().toISOString(), `fc360-api ${BUILD} em http://127.0.0.1:${PORT} · fotos em ${FOTOS_RAIZ}`));
  vigiarCodigo();
})().catch(e => { console.error(new Date().toISOString(), 'fc360-api não subiu:', e.message); process.exit(1); });

// Deploy sem admin: quando um arquivo de código muda (scp/git pull), o processo sai
// sozinho e quem mantém ele vivo (Econômico Relatórios, lib/fc360-api-proxy.js) sobe
// a versão nova em 10 s. Mesma ideia do /deploy do Relatórios com o NSSM.
function vigiarCodigo() {
  if (process.env.FC360_API_SEM_VIGIA === '1') return;
  const fs = require('fs');
  let timer = null;
  const sair = (arquivo) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { console.log(new Date().toISOString(), 'código mudou (' + arquivo + ') — saindo pra subir a versão nova'); process.exit(0); }, 2000);
  };
  for (const alvo of [path.join(__dirname, 'lib'), path.join(__dirname, 'sql'), __dirname]) {
    try {
      fs.watch(alvo, { persistent: false }, (ev, nome) => {
        if (!nome) return;
        if (alvo === __dirname && !/^(fc360-api\.js|package\.json|\.env)$/.test(nome)) return;
        if (!/\.(js|sql)$|^\.env$|^package\.json$/.test(nome)) return;
        sair(nome);
      });
    } catch (e) { console.log('vigia de código indisponível em', alvo, e.message); }
  }
}
