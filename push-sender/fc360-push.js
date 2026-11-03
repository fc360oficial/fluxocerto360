// FC360 — avisos push com o app fechado (BUILD 432, Tiago 02/11/26: "as
// notificações têm que ser com o app fechado chegando no celular de todos").
//
// Processo CONTÍNUO (03/11/26): o projeto está no plano grátis (50 mil leituras/
// dia) e reler tudo a cada 5 min gastaria ~150 mil/dia. Agora carrega cada
// coleção uma vez por listener e depois só recebe o que muda; avalia os avisos a
// cada minuto em memória. O Agendador do .254 (tarefa FC360Push, a cada 5 min)
// só sobe o processo se ele tiver caído — instância já rodando = ignora.
// Manda Web Push pras inscrições em usuarios/{id}.push.<chave> (_inscreverPush).
//
// Avisos:
//  1. Loja: checklist obrigatório de hoje ainda não enviado, 30 min antes do
//     prazo (o mais cedo entre o prazo do checklist e o das perguntas).
//  2. Gerência/supervisão/admin: checklist enviado ou REPROVADO.
//  3. Plano de ação vencendo hoje / vencido (08h, 1 por dia, agrupado por pessoa).
//  4. Aviso do dia (AVISOS_LOGIN do app + clientes/{id}.avisos) às 07h30.
//
// O que já foi enviado fica em data/enviados-AAAA-MM-DD.json (não repete).
// DRY_RUN=1 só mostra o que mandaria.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const webpush = require('web-push');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const DRY = process.env.DRY_RUN === '1';
const TZ = 'America/Recife';
initializeApp({ credential: cert(require(path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS))) });
const db = getFirestore();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:tiago@fluxocerto.com', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

// ── hora local (o app compara tudo na hora do aparelho, Brasil) ──────────────
function agoraLocal() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { iso: `${p.year}-${p.month}-${p.day}`, br: `${p.day}/${p.month}/${p.year}`, min: (+p.hour % 24) * 60 + +p.minute, dia: dias[p.weekday] };
}
function isoLocal(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
function hhmm(t) { const [h, m] = String(t || '').split(':'); return (+h || 0) * 60 + (+m || 0); }
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); // "Jardim Jordão" = "Jardim Jordao"
const cliente = x => x.clienteId || 'economico'; // doc sem clienteId = Econômico (pré multi-tenant)

let H = agoraLocal();
const LOG_DIR = path.join(__dirname, 'data');
fs.mkdirSync(LOG_DIR, { recursive: true });
let LOG = '', enviados = {};
function abrirDia() {
  LOG = path.join(LOG_DIR, `enviados-${H.iso}.json`);
  enviados = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : {};
  for (const f of fs.readdirSync(LOG_DIR)) if (/^enviados-/.test(f) && f < `enviados-${isoLocal(new Date(Date.now() - 7 * 864e5))}`) fs.unlinkSync(path.join(LOG_DIR, f));
}
abrirDia();

// ── estado ao vivo (listeners: cobra a carga inicial e depois só o que muda) ──
const E = { usuarios: new Map(), checklists: new Map(), resultados: new Map(), planos: new Map(), clientes: new Map(), repos: {} };
function ouvir(nome, consulta) {
  return new Promise(res => {
    let primeiro = true;
    const unsub = consulta.onSnapshot(snap => {
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') E[nome].delete(ch.doc.id);
        else E[nome].set(ch.doc.id, { id: ch.doc.id, _doc: ch.doc.id, ...ch.doc.data() });
      }
      if (primeiro) { primeiro = false; res(unsub); }
    }, err => { console.error(new Date().toISOString(), 'listener', nome, err.code || err.message); process.exit(1); }); // o Agendador sobe de novo
  });
}
let unsubResultados = null, diaResultados = '';
async function ouvirResultadosDoDia() {
  if (diaResultados === H.iso) return;
  if (unsubResultados) unsubResultados();
  E.resultados.clear();
  diaResultados = H.iso;
  unsubResultados = await ouvir('resultados', db.collection('resultados').where('dateISO', '==', H.iso));
}
let _avisosApp = {}, _avisosAppEm = 0;

// fila: chave única → { usuarios[], titulo, corpo, tag }
let fila = [];
function avisar(chave, usuarios, titulo, corpo, tag) {
  if (enviados[chave] || !usuarios.length) return;
  fila.push({ chave, usuarios, titulo, corpo, tag });
}

async function avisosDoApp(clienteId, repos) {
  // a lista fixa AVISOS_LOGIN mora no app.js publicado de cada cliente (HTTP, não gasta cota; 1x por hora)
  if (Date.now() - _avisosAppEm < 3600e3 && _avisosApp[clienteId]) return _avisosApp[clienteId];
  _avisosApp[clienteId] = await _baixarAvisosDoApp(clienteId, repos);
  _avisosAppEm = Date.now();
  return _avisosApp[clienteId];
}
async function _baixarAvisosDoApp(clienteId, repos) {
  const repo = clienteId === 'fluxocerto' ? 'fluxocerto360' : repos[clienteId];
  if (!repo) return [];
  try {
    const js = await (await fetch(`https://fc360oficial.github.io/${repo}/app.js?push=${Date.now()}`)).text();
    const m = js.match(/var AVISOS_LOGIN = (\[[\s\S]*?\n\]);/);
    return m ? vm.runInNewContext(m[1], {}, { timeout: 1000 }) : [];
  } catch (e) { console.log('avisos do app', clienteId, e.message); return []; }
}
const textoPuro = h => String(h || '').replace(/<\/(div|p)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\n{2,}/g, '\n').trim();

async function tick() {
  const antes = H.iso;
  H = agoraLocal();
  if (H.iso !== antes) abrirDia();
  await ouvirResultadosDoDia();
  fila = [];
  const usuarios = [...E.usuarios.values()].filter(u => u.ativo !== false);
  const checklists = [...E.checklists.values()];
  const resultados = [...E.resultados.values()].filter(r => !r.resetado && !r.manual);
  const planos = [...E.planos.values()];
  const clientes = [...E.clientes.values()].filter(c => c.ativo !== false);
  const repos = E.repos;

  for (const cli of clientes) {
    const us = usuarios.filter(u => cliente(u) === cli.id);
    const gestores = loja => us.filter(u => u.perfil === 'admin' || u.perfil === 'supervisor' || (u.perfil === 'gerencia' && norm(u.loja) === norm(loja)));

    // 1. checklist obrigatório não enviado — 30 min antes do prazo
    for (const cl of checklists.filter(c => cliente(c) === cli.id)) {
      const dias = (cl.diasObrigatorios || []).map(Number);
      if (!dias.includes(H.dia)) continue;
      const prazos = [hhmm(cl.horaLimite || '10:00')].concat((cl.itens || []).filter(i => i && i.horaLimite).map(i => hhmm(i.horaLimite)));
      const prazo = Math.min(...prazos);
      if (H.min < prazo - 30 || H.min > prazo) continue;
      const lojas = [...new Set(us.map(u => u.loja).filter(Boolean).map(norm))].filter(l => !cl.loja || norm(cl.loja) === l);
      for (const loja of lojas) {
        const enviou = resultados.some(r => r.checklistId === cl.id && norm(r.loja) === loja && r.perfil !== 'admin');
        if (enviou) continue;
        const alvo = us.filter(u => norm(u.loja) === loja && ['operator', 'prevencao', 'gerencia'].includes(u.perfil) && u.checklistAtivo !== false
          && (!cl.perfil || cl.perfil === 'todos' || cl.perfil === u.perfil || u.perfil === 'gerencia'));
        const h = String(Math.floor(prazo / 60)).padStart(2, '0') + ':' + String(prazo % 60).padStart(2, '0');
        avisar(`pend|${cl.id}|${loja}`, alvo, '⏰ Checklist ainda não enviado', `${cl.nome || 'Checklist'}: o prazo é ${h}. Envie agora pelo Fluxo Certo 360.`, `pend-${cl.id}`);
      }
    }

    // 2. checklist enviado / reprovado → gestores (só envios da última hora: não despeja o dia inteiro)
    for (const r of resultados.filter(r => cliente(r) === cli.id && r.perfil !== 'admin')) {
      const hr = hhmm((r.dataHora || '').split(' ')[1]);
      if (H.min - hr > 60) continue;
      const titulo = r.reprovado ? `🚨 REPROVADO — ${r.loja || ''}` : `📋 Checklist enviado — ${r.loja || ''}`;
      avisar(`res|${r.id}`, gestores(r.loja), titulo, `${r.checklistNome || 'Checklist'} · ${r.operador || ''} · ${r.pct || 0}% (${r.feitos || 0}/${r.total || 0})`, `res-${r.id}`);
    }

    // 3. planos de ação — 08h, agrupado por pessoa
    if (H.min >= 8 * 60) {
      const porPessoa = new Map();
      for (const p of planos.filter(p => cliente(p) === cli.id && p.prazoFim)) {
        const fim = new Date(p.prazoFim);
        const tipo = fim.getTime() < Date.now() ? 'vencido' : isoLocal(fim) === H.iso ? 'hoje' : null;
        if (!tipo) continue;
        const resp = us.filter(u => p.responsavel && norm(u.nome) === norm(p.responsavel));
        const ger = us.filter(u => u.perfil === 'gerencia' && norm(u.loja) === norm(p.loja));
        for (const u of new Set([...resp, ...ger])) {
          const c = porPessoa.get(u) || { vencido: 0, hoje: 0 };
          c[tipo]++; porPessoa.set(u, c);
        }
      }
      for (const [u, c] of porPessoa) {
        const partes = [];
        if (c.vencido) partes.push(`${c.vencido} vencido${c.vencido > 1 ? 's' : ''}`);
        if (c.hoje) partes.push(`${c.hoje} vencendo hoje`);
        avisar(`plano|${u._doc}`, [u], '📌 Planos de ação', `Você tem ${partes.join(' e ')}. Abra o Fluxo Certo 360 pra resolver.`, 'planos');
      }
    }

    // 4. aviso do dia — 07h30
    if (H.min >= 7 * 60 + 30) {
      const avisos = (await avisosDoApp(cli.id, repos)).concat(Array.isArray(cli.avisos) ? cli.avisos : []);
      for (const a of avisos) {
        if (!a || !a.id || a.ativo === false || (a.clienteId && a.clienteId !== cli.id)) continue;
        if ((a.inicio && H.iso < a.inicio) || (a.fim && H.iso > a.fim)) continue;
        const alvo = us.filter(u => !a.perfis || !a.perfis.length || a.perfis.includes(u.perfil));
        const corpo = textoPuro(a.texto || a.html).replace(/\n+/g, ' · ').slice(0, 160);
        avisar(`aviso|${a.id}`, alvo, '📢 ' + (a.titulo || 'Aviso'), corpo, `aviso-${a.id}`);
      }
    }
  }

  // ── envio ──────────────────────────────────────────────────────────────────
  let ok = 0, falha = 0, removidas = 0;
  for (const item of fila) {
    const payload = JSON.stringify({ title: item.titulo, body: item.corpo, tag: item.tag });
    for (const u of item.usuarios) {
      const subs = Object.entries(u.push || {});
      if (DRY) { console.log(`[DRY] ${item.chave} → ${u.nome} (${u.perfil}/${u.loja || '-'}) ${subs.length} aparelho(s): ${item.titulo} | ${item.corpo}`); continue; }
      for (const [chave, sub] of subs) {
        try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 6 * 3600 }); ok++; }
        catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) { // inscrição morta (app desinstalado / permissão tirada)
            await db.collection('usuarios').doc(u._doc).update({ ['push.' + chave]: FieldValue.delete() }).catch(() => {});
            removidas++;
          } else { falha++; console.log('falha', u.nome, e.statusCode || e.message); }
        }
      }
    }
    if (!DRY) enviados[item.chave] = new Date().toISOString();
  }
  if (!fila.length) return;
  if (!DRY) fs.writeFileSync(LOG, JSON.stringify(enviados, null, 1));
  console.log(`${new Date().toISOString()} ${H.iso} ${String(Math.floor(H.min / 60)).padStart(2, '0')}h — ${fila.length} aviso(s), ${ok} entregue(s), ${falha} falha(s), ${removidas} inscrição(ões) removida(s)${DRY ? ' [DRY]' : ''}`);
}

async function iniciar() {
  const reposDoc = await db.collection('config').doc('repos').get();
  E.repos = reposDoc.exists ? reposDoc.data() : {};
  await Promise.all([
    ouvir('usuarios', db.collection('usuarios')),
    ouvir('checklists', db.collection('checklists')),
    ouvir('planos', db.collection('planos').where('status', 'in', ['aberto', 'andamento'])),
    ouvir('clientes', db.collection('clientes')),
    ouvirResultadosDoDia()
  ]);
  console.log(`${new Date().toISOString()} iniciado — ${E.usuarios.size} usuários, ${E.checklists.size} checklists, ${E.planos.size} planos abertos, ${E.resultados.size} envios hoje${DRY ? ' [DRY]' : ''}`);
  let rodando = false;
  const ciclo = async () => {
    if (rodando) return;
    rodando = true;
    try { await tick(); } catch (e) { console.error(new Date().toISOString(), 'tick', e.message); }
    rodando = false;
  };
  await ciclo();
  if (process.env.UMA_VEZ === '1') process.exit(0);
  setInterval(ciclo, 60e3);
}
iniciar().catch(e => { console.error(new Date().toISOString(), e.code || '', e.message); process.exit(1); });
