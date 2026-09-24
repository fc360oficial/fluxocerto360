const test = require('node:test');
const assert = require('node:assert/strict');
const RC = require('../lib/resultados-core.js');

const B64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

function resExemplo() {
  return {
    id: 'id_123_abc', checklistId: 'cl1', clienteId: 'economico', loja: 'Cahu',
    dateISO: '2026-09-23', dataHora: '23/09/2026 17:10', pct: 100,
    itens: [
      { texto: 'A', feito: true, fotoAntes: null, fotoDepois: B64, fotosMulti: null },
      { texto: 'B', feito: true, fotoAntes: B64, fotoDepois: B64, fotosMulti: null },
      { texto: 'C', feito: false, fotoAntes: null, fotoDepois: null, fotosMulti: [B64, B64] },
      { texto: 'D', feito: true, fotoAntes: null, fotoDepois: null, fotosMulti: null }
    ],
    assinatura: PNG
  };
}

test('separarFotos: doc fica sem base64 e com refs; um doc de foto por imagem', () => {
  const orig = resExemplo();
  const { doc, fotos } = RC.separarFotos(orig);
  // 1 + 2 + 2 fotos + assinatura
  assert.equal(fotos.length, 6);
  assert.equal(doc.itens[0].fotoDepoisRef, 'id_123_abc_0_depois');
  assert.equal(doc.itens[1].fotoAntesRef, 'id_123_abc_1_antes');
  assert.equal(doc.itens[1].fotoDepoisRef, 'id_123_abc_1_depois');
  assert.deepEqual(doc.itens[2].fotosMultiRef, ['id_123_abc_2_m0', 'id_123_abc_2_m1']);
  assert.equal(doc.assinaturaRef, 'id_123_abc_assinatura');
  // nenhum base64 sobrou no doc
  assert.ok(!JSON.stringify(doc).includes('base64,'));
  assert.equal('fotoDepois' in doc.itens[0], false);
  assert.equal('assinatura' in doc, false);
  // item sem foto não ganha ref nem doc
  assert.equal(doc.itens[3].fotoDepoisRef, undefined);
  assert.equal(doc.itens[3].fotosMultiRef, undefined);
  // doc de foto carrega o que a retaguarda precisa pra achar por resultado
  const f = fotos.find(x => x.id === 'id_123_abc_2_m1');
  assert.deepEqual(f.data, { resultadoId: 'id_123_abc', clienteId: 'economico', loja: 'Cahu', dateISO: '2026-09-23', slot: '2_m1', data: B64 });
  const ass = fotos.find(x => x.id === 'id_123_abc_assinatura');
  assert.equal(ass.data.slot, 'assinatura');
  assert.equal(ass.data.data, PNG);
  // não mutou a entrada
  assert.equal(orig.itens[0].fotoDepois, B64);
  assert.equal(orig.assinatura, PNG);
});

test('separarFotos: resultado sem nenhuma foto gera zero docs e nenhum campo undefined', () => {
  const r = { id: 'x', itens: [{ texto: 'A', feito: true }], assinatura: null, clienteId: 'c', loja: 'l', dateISO: '2026-01-01' };
  const { doc, fotos } = RC.separarFotos(r);
  assert.equal(fotos.length, 0);
  assert.equal(doc.assinaturaRef, undefined);
  assert.equal(JSON.stringify(doc).includes('undefined'), false);
  assert.equal(Object.keys(doc).indexOf('assinatura'), -1);
});

test('enxugar: tira base64 de doc antigo e marca _semFotos; doc novo (refs) passa intacto', () => {
  const antigo = RC.enxugar(resExemplo());
  assert.equal(antigo._semFotos, true);
  assert.ok(!JSON.stringify(antigo).includes('base64,'));
  assert.equal(antigo.itens.length, 4);
  assert.equal(antigo.itens[0].feito, true);

  const novo = RC.separarFotos(resExemplo()).doc;
  const enx = RC.enxugar(novo);
  assert.equal(enx._semFotos, undefined);
  assert.equal(enx.itens[1].fotoAntesRef, 'id_123_abc_1_antes');

  const semFoto = RC.enxugar({ id: 'y', itens: [{ texto: 'A' }] });
  assert.equal(semFoto._semFotos, undefined);
});

test('filtrarConfirmados: descarta doc com escrita pendente', () => {
  const docs = [
    { id: 'a', metadata: { hasPendingWrites: true }, data: () => ({ id: 'a' }) },
    { id: 'b', metadata: { hasPendingWrites: false }, data: () => ({ id: 'b' }) },
    { id: 'c', data: () => ({ id: 'c' }) }
  ];
  assert.deepEqual(RC.filtrarConfirmados(docs).map(d => d.id), ['b', 'c']);
});

test('janelaISO: 30 dias atrás em data local, com zero à esquerda', () => {
  assert.equal(RC.janelaISO(30, new Date(2026, 8, 23)), '2026-08-24');
  assert.equal(RC.janelaISO(30, new Date(2026, 2, 5)), '2026-02-03');
  assert.equal(RC.janelaISO(0, new Date(2026, 0, 9)), '2026-01-09');
});

test('precisaCarregar: só quando o pedido começa antes do que já está carregado', () => {
  assert.equal(RC.precisaCarregar('2026-07-01', '2026-08-24'), true);
  assert.equal(RC.precisaCarregar('2026-08-24', '2026-08-24'), false);
  assert.equal(RC.precisaCarregar('2026-09-01', '2026-08-24'), false);
  assert.equal(RC.precisaCarregar('', '2026-08-24'), false);
  assert.equal(RC.precisaCarregar('2026-07-01', ''), true);
});

test('itemTemFoto: aceita base64 ou ref', () => {
  assert.equal(RC.itemTemFoto({ fotoDepois: B64 }, 'depois'), true);
  assert.equal(RC.itemTemFoto({ fotoDepoisRef: 'x_0_depois' }, 'depois'), true);
  assert.equal(RC.itemTemFoto({ fotoAntesRef: 'x_0_antes' }, 'antes'), true);
  assert.equal(RC.itemTemFoto({ fotosMultiRef: ['a'] }, 'multi'), true);
  assert.equal(RC.itemTemFoto({ fotosMulti: [] }, 'multi'), false);
  assert.equal(RC.itemTemFoto({ fotoAntesRef: 'x' }), true);
  assert.equal(RC.itemTemFoto({ texto: 'nada' }), false);
  assert.equal(RC.contarFotos({ fotoAntesRef: 'a', fotoDepois: B64, fotosMultiRef: ['m', 'n'] }), 4);
});

test('montarFotosHidratadas: devolve o doc com base64 no lugar das refs', () => {
  const { doc, fotos } = RC.separarFotos(resExemplo());
  const fotosDocs = fotos.map(f => f.data); // como vem do Firestore: data() de cada doc
  const h = RC.montarFotosHidratadas(doc, fotosDocs);
  assert.equal(h.itens[0].fotoDepois, B64);
  assert.equal(h.itens[1].fotoAntes, B64);
  assert.deepEqual(h.itens[2].fotosMulti, [B64, B64]);
  assert.equal(h.assinatura, PNG);
  assert.equal(h._semFotos, undefined);
  // refs continuam (não atrapalham) e o doc original não foi mutado
  assert.equal(h.itens[0].fotoDepoisRef, 'id_123_abc_0_depois');
  assert.equal(doc.itens[0].fotoDepois, undefined);
  // foto faltando no servidor não quebra: campo fica null
  const h2 = RC.montarFotosHidratadas(doc, fotosDocs.slice(0, 1));
  assert.equal(h2.itens[1].fotoAntes, null);
});

test('mesclarPorId: novos substituem pelo id, resto é mantido, ordenado por dataHora', () => {
  const lista = [{ id: 'a', dataHora: '02/09/2026 10:00', pct: 50 }, { id: 'b', dataHora: '03/09/2026 10:00' }];
  const novos = [{ id: 'a', dataHora: '02/09/2026 10:00', pct: 100 }, { id: 'c', dataHora: '01/09/2026 10:00' }];
  const m = RC.mesclarPorId(lista, novos);
  assert.deepEqual(m.map(x => x.id), ['c', 'a', 'b']);
  assert.equal(m[1].pct, 100);
});

// ── montarResultadoManual (spec 2026-09-24-checklist-lancamento-manual) ──
function clExemplo() {
  return {
    id: 'cl9', nome: 'Abertura', setor: 'Loja',
    itens: [
      { t: 'Ligar luzes', obs: '', foto: false, tipo: 'checkbox', critico: false, prazoPlano: 72 },
      { t: 'Foto da fachada', obs: 'frente', foto: 'antes_depois', tipo: 'checkbox', critico: false, prazoPlano: 72 },
      { t: 'Gondola ok?', obs: '', foto: false, tipo: 'simNao', critico: true, prazoPlano: 48 },
      { t: 'Conferir troco', obs: '', foto: false, tipo: 'checkbox', critico: false, prazoPlano: 72 }
    ]
  };
}
function optsManual(marcados) {
  return {
    cl: clExemplo(), marcados: marcados,
    operador: 'Maria', perfil: 'operator', loja: 'Cahu', clienteId: 'economico',
    dateISO: '2026-09-07', autor: 'Tiago',
    agora: new Date(2026, 8, 24, 9, 5), genId: function () { return 'id_manual_1'; }
  };
}

test('montarResultadoManual: 3 de 4 feitos -> pct 75, marcado como manual', () => {
  const doc = RC.montarResultadoManual(optsManual([true, true, 'sim', false]));
  assert.equal(doc.id, 'id_manual_1');
  assert.equal(doc.checklistId, 'cl9');
  assert.equal(doc.checklistNome, 'Abertura');
  assert.equal(doc.setor, 'Loja');
  assert.equal(doc.operador, 'Maria');
  assert.equal(doc.perfil, 'operator');
  assert.equal(doc.loja, 'Cahu');
  assert.equal(doc.clienteId, 'economico');
  assert.equal(doc.dateISO, '2026-09-07');
  assert.equal(doc.dataHora, '07/09/2026 00:00');
  assert.equal(doc.feitos, 3);
  assert.equal(doc.total, 4);
  assert.equal(doc.pct, 75);
  assert.equal(doc.reprovado, false);
  assert.equal(doc.assinatura, null);
  assert.equal(doc.manual, true);
  assert.equal(doc.lancadoPor, 'Tiago');
  assert.equal(doc.lancadoEm, '24/09/2026 09:05');
  assert.equal(doc.itens.length, 4);
});

test('montarResultadoManual: simNao conta feito só no sim', () => {
  assert.equal(RC.montarResultadoManual(optsManual([false, false, 'sim', false])).feitos, 1);
  assert.equal(RC.montarResultadoManual(optsManual([false, false, 'nao', false])).feitos, 0);
  assert.equal(RC.montarResultadoManual(optsManual([false, false, null, false])).feitos, 0);
  const d = RC.montarResultadoManual(optsManual([false, false, 'nao', false]));
  assert.equal(d.itens[2].resposta, 'nao');
  assert.equal(d.itens[0].resposta, null);
});

test('montarResultadoManual: crítico não feito reprova', () => {
  assert.equal(RC.montarResultadoManual(optsManual([true, true, 'nao', true])).reprovado, true);
  assert.equal(RC.montarResultadoManual(optsManual([true, true, null, true])).reprovado, true);
  assert.equal(RC.montarResultadoManual(optsManual([true, true, 'sim', true])).reprovado, false);
});

test('montarResultadoManual: nada marcado e checklist vazio', () => {
  const zero = RC.montarResultadoManual(optsManual([false, false, null, false]));
  assert.equal(zero.pct, 0);
  assert.equal(zero.feitos, 0);
  const o = optsManual([]); o.cl.itens = [];
  const vazio = RC.montarResultadoManual(o);
  assert.equal(vazio.total, 0);
  assert.equal(vazio.pct, 0);
  assert.equal(vazio.reprovado, false);
});

test('montarResultadoManual: itens sem foto e no formato do envio', () => {
  const doc = RC.montarResultadoManual(optsManual([true, true, 'sim', true]));
  doc.itens.forEach(function (it) {
    assert.equal(it.fotoAntes, null);
    assert.equal(it.fotoDepois, null);
    assert.equal(it.fotosMulti, null);
    assert.equal(it.produtos, null);
    assert.equal(it.emPlano, false);
    assert.equal(it.justificativa, '');
  });
  assert.deepEqual(Object.keys(doc.itens[1]).sort(),
    ['critico','emPlano','feito','foto','fotoAntes','fotoDepois','fotosMulti','justificativa','obs','prazoPlano','produtos','resposta','texto','tipo']);
  assert.equal(doc.itens[1].foto, 'antes_depois');
  assert.equal(doc.itens[1].feito, true);
  assert.equal(doc.itens[2].critico, true);
  assert.equal(doc.itens[2].prazoPlano, 48);
});
