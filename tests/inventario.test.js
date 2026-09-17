const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/inv-bip-core.js');

test('normEan tira zeros à esquerda', () => {
  assert.equal(C.normEan('0041334001005'), '41334001005');
  assert.equal(C.normEan(' 7899335409663 '), '7899335409663');
  assert.equal(C.normEan('000'), '0');
  assert.equal(C.normEan(''), '0');
});

const itens = [
  { c: '1', e: '7812081100004', d: 'MOUSE', u: 'UN', q: 0 },
  { c: '56', e: '', d: 'PANO DE CHAO', u: 'UN', q: 3 },
  { c: '94', e: 'MO-A148-11', d: 'ALICATE', u: 'UN', q: 1 },
  { c: '325', e: '7898604340230', d: 'ITEM A', u: 'UN', q: 2 },
  { c: '3246', e: '7898604340230', d: 'ITEM B', u: 'UN', q: 5 },
  { c: '9', e: '0041334001005', d: 'ZERO', u: 'UN', q: 0 },
];
const cat = C.criarCatalogo(itens);

test('criarCatalogo indexa por código e EAN normalizado', () => {
  assert.equal(cat.total, 6);
  assert.equal(cat.porCodigo['56'].d, 'PANO DE CHAO');
  assert.equal(cat.porEan['41334001005'][0].c, '9');
  assert.equal(cat.porEan['7898604340230'].length, 2);
  assert.equal(cat.porEan['MO-A148-11'][0].c, '94');
});

test('resolverCodigo: código interno exato tem prioridade', () => {
  assert.deepEqual(C.resolverCodigo(cat, '1'), { codigo: '1', ean: '7812081100004', desc: 'MOUSE', un: 'UN', estoque: 0, custo: null });
});
test('resolverCodigo: EAN com e sem zero à esquerda', () => {
  assert.equal(C.resolverCodigo(cat, '0041334001005').codigo, '9');
  assert.equal(C.resolverCodigo(cat, '41334001005').codigo, '9');
});
test('resolverCodigo: referência no lugar do EAN', () => {
  assert.equal(C.resolverCodigo(cat, 'MO-A148-11').codigo, '94');
});
test('resolverCodigo: EAN repetido devolve múltiplos', () => {
  const r = C.resolverCodigo(cat, '7898604340230');
  assert.equal(r.multiplos.length, 2);
  assert.equal(r.multiplos[1].codigo, '3246');
});
test('resolverCodigo: desconhecido é null', () => {
  assert.equal(C.resolverCodigo(cat, '999999'), null);
  assert.equal(C.resolverCodigo(cat, ''), null);
});

test('montarBlocos: 1000 por bloco, ordem preservada, desc truncada', () => {
  const muitos = [];
  for (let i = 0; i < 2500; i++) muitos.push({ c: String(i), e: '', d: 'X'.repeat(200), u: 'UN', q: 0 });
  const b = C.montarBlocos(muitos);
  assert.equal(b.length, 3);
  assert.equal(b[0].length, 1000);
  assert.equal(b[2].length, 500);
  assert.equal(b[2][0].c, '2000');
  assert.equal(b[0][0].d.length, 120);
});

test('parseCatalogoTexto detecta ; e ignora linhas vazias', () => {
  const r = C.parseCatalogoTexto('CODIGO;EAN;DESCRICAO;UN;ESTOQUE\r\n1;7812081100004;MOUSE;UN;0\r\n\r\n56;;PANO;UN;3\r\n');
  assert.equal(r.delim, ';');
  assert.equal(r.linhas.length, 3);
  assert.deepEqual(r.linhas[2], ['56', '', 'PANO', 'UN', '3']);
});
test('parseCatalogoTexto detecta tab e pipe', () => {
  assert.equal(C.parseCatalogoTexto('a\tb\n1\t2').delim, '\t');
  assert.equal(C.parseCatalogoTexto('a|b\n1|2').delim, '|');
});

test('mapearColunas pelo cabeçalho do TXT do bazar', () => {
  const m = C.mapearColunas(['CODIGO', 'EAN', 'DESCRICAO', 'UN', 'ESTOQUE'], [['1', '7812081100004', 'MOUSE', 'UN', '0']]);
  assert.deepEqual(m, { codigo: 0, ean: 1, desc: 2, un: 3, estoque: 4, custo: -1, temHeader: true });
});
test('mapearColunas sem cabeçalho usa heurística', () => {
  const m = C.mapearColunas(['7899335409663', 'BACIA 17L', 'UN'], [['7899335402978', 'BALDE 15L', 'UN']]);
  assert.equal(m.temHeader, false);
  assert.equal(m.ean, 0);
  assert.equal(m.desc, 1);
  assert.equal(m.un, 2);
  assert.equal(m.codigo, -1);
});

test('detector de rajada: leitor manda rápido, humano não', () => {
  const d = C.criarDetectorRajada(100, 4);
  let t = 1000;
  ['7', '8', '9', '9'].forEach(ch => { assert.equal(d.tecla(ch, t), null); t += 10; });
  assert.equal(d.tecla('3', t), '78993');
  const h = C.criarDetectorRajada(100, 4);
  assert.equal(h.tecla('1', 0), null);
  assert.equal(h.tecla('2', 500), null);
  assert.equal(h.tecla('3', 510), null);
});

test('mapearColunas reconhece CUSTO', () => {
  const m = C.mapearColunas(['CODIGO', 'EAN', 'DESCRICAO', 'UN', 'ESTOQUE', 'CUSTO'], []);
  assert.equal(m.custo, 5);
});

test('calcularResultado: contado x sistema, valor a custo, NC e endereços', () => {
  const cat2 = C.criarCatalogo([
    { c: '10', e: '7890000000017', d: 'PRATO', u: 'UN', q: 10, k: 2.5 },
    { c: '20', e: '', d: 'BALDE', u: 'UN', q: 5, k: 4 },
    { c: '30', e: '7890000000031', d: 'COPO', u: 'UN', q: 3, k: null },
  ]);
  const bips = [
    { endereco: '1', ean: '7890000000017', codigo: '10', qty: 8, rodada: 1 },
    { endereco: '2', ean: '10', codigo: '10', qty: 4, rodada: 1 },
    { endereco: '1', ean: '20', codigo: '20', qty: 2, rodada: 1 },
    { endereco: '_CORRECAO', ean: '20', codigo: '', qty: -1, modo: 'correcao' },
    { endereco: '3', ean: '999', codigo: '', qty: 7, naoCadastrado: true, rodada: 1 },
    { endereco: '3', ean: '7890000000031', codigo: '30', qty: 3, rodada: 1 },
  ];
  const r = C.calcularResultado(cat2, bips, {});
  const by = {}; r.linhas.forEach(l => { by[l.codigo || l.ean] = l; });
  assert.equal(by['10'].contado, 12); assert.equal(by['10'].dif, 2); assert.equal(by['10'].valor, 5);
  assert.equal(by['20'].contado, 1); assert.equal(by['20'].dif, -4); assert.equal(by['20'].valor, -16);
  assert.equal(by['30'].dif, 0); assert.equal(by['30'].valor, null);
  assert.equal(by['999'].nc, true); assert.equal(by['999'].contado, 7); assert.equal(by['999'].dif, null);
  assert.equal(r.totais.divergentes, 2); assert.equal(r.totais.sobraUn, 2); assert.equal(r.totais.faltaUn, 4);
  assert.equal(r.totais.sobraVal, 5); assert.equal(r.totais.faltaVal, 16); assert.equal(r.totais.naoCadastrados, 1);
  assert.equal(r.enderecos[0].endereco, '1');   // balde faltando 4 × R$4 pesa mais que os pratos
  assert.equal(r.linhas[0].codigo, '20');       // ordenado por valor absoluto
});

test('calcularResultado respeita rodada resolvida', () => {
  const cat3 = C.criarCatalogo([{ c: '1', e: '', d: 'X', u: 'UN', q: 1, k: 1 }]);
  const bips = [{ endereco: 'A', codigo: '1', ean: '1', qty: 5, rodada: 1 }, { endereco: 'A', codigo: '1', ean: '1', qty: 1, rodada: 2 }];
  assert.equal(C.calcularResultado(cat3, bips, { A: { rodada: 2 } }).linhas[0].contado, 1);
});
