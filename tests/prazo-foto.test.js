// BUILD 453 — pergunta com foto e hora-limite ("Responder até"): foto no prazo não trava a
// resposta, a hora perdida é recuperada pela chegada da foto no servidor e o estado vai
// pro servidor mesmo com o localStorage do aparelho cheio. As funções são extraídas do
// app.js (script de navegador) e rodam num contexto isolado com S/localStorage/Date falsos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const fonte = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function extrair(nome) {
  const ini = fonte.indexOf('\nfunction ' + nome + '(');
  assert.ok(ini >= 0, 'função ' + nome + ' não encontrada no app.js');
  let i = fonte.indexOf('{', ini), nivel = 0;
  for (; i < fonte.length; i++) { if (fonte[i] === '{') nivel++; else if (fonte[i] === '}' && --nivel === 0) break; }
  return fonte.slice(ini + 1, i + 1);
}
const NOMES = ['_hhmmParaMin', '_horaAgoraHHMM', '_prazoItemEncerrado', '_itemNoPrazo', '_fotosDoItemCompletas', '_fotoEntregueNoPrazo', '_itemTravadoPeloPrazo',
  '_registrarHoraResposta', '_podeResponderNoPrazo', '_recuperarHoraDasFotos', 'getStateKey', '_limparEstadosOutrosDias', '_limparBackupsFotoOutrosDias', '_gravarEstadoLocal', 'saveCheckState', '_flushCheckState'];

const CL = { id: 'cl1', itens: [
  { t: 'Foto do açougue', tipo: 'simNao', foto: 'depois', horaLimite: '11:00' },
  { t: 'Loja limpa?', tipo: 'simNao', foto: 'none', horaLimite: '11:00' },
  { t: 'Fachada', tipo: 'simNao', foto: 'depois' },
  { t: 'Quatro fotos', tipo: 'simNao', foto: 'multiplas', fotoQtd: 2, horaLimite: '11:00' },
] };

function ambiente(hora, opts) {
  opts = opts || {};
  const [h, m] = hora.split(':').map(Number);
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(2026, 10, 12, h, m, 0); } }
  const dados = Object.assign({}, opts.storage || {});
  const enviados = [], toasts = [];
  const localStorage = {
    getItem: k => (k in dados ? dados[k] : null),
    setItem: (k, v) => { if (opts.cheio && opts.cheio(k, dados)) { const e = new Error('cheio'); e.name = 'QuotaExceededError'; throw e; } dados[k] = String(v); },
    removeItem: k => { delete dados[k]; },
  };
  const ls = new Proxy(localStorage, { ownKeys: () => Object.keys(dados), getOwnPropertyDescriptor: (t, k) => (k in dados ? { enumerable: true, configurable: true, value: dados[k] } : undefined) });
  const timers = [];
  const ctx = { Date: FakeDate, S: { checkState: {}, currentUser: { id: 'u1' } }, localStorage: ls, console,
    CLSTATE_PREFIX: 'eco_clstate_', _checkStateTimer: null, _checkStatePendente: null,
    getLocalDate: () => '2026-11-12', getMyCLs: () => [CL], showToast: t => toasts.push(t), buildCLBlock: () => '', document: { getElementById: () => null },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cancelado = true; },
    FC360Api: { enviarOuEnfileirar: c => { enviados.push(c); return Promise.resolve('enviado'); } } };
  vm.createContext(ctx);
  vm.runInContext(NOMES.map(extrair).join('\n'), ctx);
  return { ctx, dados, enviados, toasts, timers, S: ctx.S };
}

test('foto no prazo: depois das 11h a pergunta continua respondível e a hora que vale é a da foto', () => {
  const a = ambiente('16:50');
  a.S.checkState['cl1_foto_depois_0'] = 'data:image/jpeg;base64,xx'; a.S.checkState['cl1_hrresp_0'] = '10:12';
  assert.equal(a.ctx._itemTravadoPeloPrazo('cl1', CL.itens[0], 0), false);
  assert.equal(a.ctx._podeResponderNoPrazo(CL, 0), true);
  a.ctx._registrarHoraResposta('cl1', 0);                    // loja marca "Sim" às 16:50
  assert.equal(a.S.checkState['cl1_hrresp_0'], '10:12');
  assert.equal(a.ctx._itemNoPrazo('cl1', CL.itens[0], 0), true);
});

test('sem foto, ou foto depois do horário: trava como antes', () => {
  const a = ambiente('16:50');
  assert.equal(a.ctx._itemTravadoPeloPrazo('cl1', CL.itens[0], 0), true);
  assert.equal(a.ctx._podeResponderNoPrazo(CL, 0), false); assert.equal(a.toasts.length, 1);
  a.S.checkState['cl1_foto_depois_0'] = 'x'; a.S.checkState['cl1_hrresp_0'] = '11:01';
  assert.equal(a.ctx._itemTravadoPeloPrazo('cl1', CL.itens[0], 0), true);
  a.S.checkState['cl1_hrresp_0'] = '11:00';
  assert.equal(a.ctx._itemTravadoPeloPrazo('cl1', CL.itens[0], 0), false);
});

test('pergunta com prazo SEM foto obrigatória continua travando depois do horário, mesmo respondida no prazo', () => {
  const a = ambiente('16:50'); a.S.checkState['cl1_hrresp_1'] = '09:00';
  assert.equal(a.ctx._itemTravadoPeloPrazo('cl1', CL.itens[1], 1), true);
});

test('várias fotos: só libera com todas tiradas no prazo', () => {
  const a = ambiente('12:00'); a.S.checkState['cl1_foto_multi_3_0'] = 'x'; a.S.checkState['cl1_hrresp_3'] = '10:00';
  assert.equal(a.ctx._itemTravadoPeloPrazo('cl1', CL.itens[3], 3), true);
  a.S.checkState['cl1_foto_multi_3_1'] = 'y';
  assert.equal(a.ctx._itemTravadoPeloPrazo('cl1', CL.itens[3], 3), false);
});

test('antes do horário nada muda: a hora acompanha a última resposta; pergunta sem prazo nunca trava', () => {
  const a = ambiente('09:30'); a.S.checkState['cl1_foto_depois_0'] = 'x'; a.S.checkState['cl1_hrresp_0'] = '09:10';
  a.ctx._registrarHoraResposta('cl1', 0); assert.equal(a.S.checkState['cl1_hrresp_0'], '09:30');
  const b = ambiente('23:00'); assert.equal(b.ctx._itemTravadoPeloPrazo('cl1', CL.itens[2], 2), false); assert.equal(b.ctx._podeResponderNoPrazo(CL, 2), true);
});

test('hora perdida no aparelho é recuperada pela chegada da foto no servidor', () => {
  const a = ambiente('16:45');
  const às = (hh, mm) => new Date(2026, 10, 12, hh, mm, 30).toISOString();
  const mudou = a.ctx._recuperarHoraDasFotos([
    { clId: 'cl1', tipo: 'depois', idx: 0, base64: 'x', recebidoEm: às(10, 12) },
    { clId: 'cl1', tipo: 'multi_3', idx: 0, base64: 'x', recebidoEm: às(10, 40) },
    { clId: 'cl1', tipo: 'multi_3', idx: 1, base64: 'x', recebidoEm: às(11, 20) },
    { clId: 'cl1', tipo: 'depois', idx: 2, base64: null, recebidoEm: às(8, 0) },      // sem arquivo: ignora
  ]);
  assert.equal(mudou, true);
  assert.equal(a.S.checkState['cl1_hrresp_0'], '10:12');
  assert.equal(a.S.checkState['cl1_hrresp_3'], '11:20');      // a foto mais tardia é a que conta
  assert.equal(a.S.checkState['cl1_hrresp_2'], undefined);
  a.S.checkState['cl1_foto_depois_0'] = 'x';
  assert.equal(a.ctx._fotoEntregueNoPrazo('cl1', CL.itens[0], 0), true);
});

test('recuperação nunca troca a hora que o aparelho já tem', () => {
  const a = ambiente('16:45'); a.S.checkState['cl1_hrresp_0'] = '11:30';
  const mudou = a.ctx._recuperarHoraDasFotos([{ clId: 'cl1', tipo: 'depois', idx: 0, base64: 'x', recebidoEm: new Date(2026, 10, 12, 10, 0).toISOString() }]);
  assert.equal(mudou, false); assert.equal(a.S.checkState['cl1_hrresp_0'], '11:30');
});

test('localStorage cheio: limpa estados e cópias de foto de outros dias e grava', () => {
  const storage = { 'eco_clstate_u1_2026-11-10': '{"a":1}', 'eco_clstate_u2_2026-11-11': '{}', 'eco_clstate_u2_2026-11-12': '{"hoje":1}', 'eco_foto_bk_keys_2026-11-11': '["k1"]', 'eco_foto_bk_k1': 'foto-velha', 'outra_coisa': '1' };
  const a = ambiente('10:12', { storage, cheio: (k, d) => Object.keys(d).some(x => /2026-11-1[01]$/.test(x)) });
  a.S.checkState = { 'cl1_Foto do açougue': 'sim', 'cl1_hrresp_0': '10:12', 'cl1_foto_depois_0': 'data:...' };
  a.ctx.saveCheckState();
  assert.deepEqual(JSON.parse(a.dados['eco_clstate_u1_2026-11-12']), { 'cl1_Foto do açougue': 'sim', 'cl1_hrresp_0': '10:12' });
  assert.equal(a.dados['eco_clstate_u1_2026-11-10'], undefined); assert.equal(a.dados['eco_foto_bk_k1'], undefined);
  assert.equal(a.dados['eco_clstate_u2_2026-11-12'], '{"hoje":1}'); assert.equal(a.dados['outra_coisa'], '1');
  assert.equal(a.timers[0].ms, 20000);
});

test('localStorage sem jeito: o estado vai pro servidor mesmo assim, em 2 s', () => {
  const a = ambiente('10:12', { cheio: () => true });
  a.S.checkState = { 'cl1_Foto do açougue': 'sim', 'cl1_hrresp_0': '10:12', 'cl1_foto_depois_0': 'data:...' };
  a.ctx.saveCheckState();
  const t = a.timers.filter(x => !x.cancelado); assert.equal(t.length, 1); assert.equal(t[0].ms, 2000);
  t[0].fn();
  assert.equal(a.enviados.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(a.enviados[0].checkstates[0].state)), /* objeto nasce em outro contexto (vm) */ { 'cl1_Foto do açougue': 'sim', 'cl1_hrresp_0': '10:12' });
  assert.equal(a.enviados[0].checkstates[0].id, 'u1_2026-11-12');
});
