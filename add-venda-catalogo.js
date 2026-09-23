// Acrescenta o PREÇO DE VENDA (campo `v`) nos blocos do catálogo de um inventário,
// lendo o TEMPLATE MERCADORIAS do ERP. Não toca em inv_bipagens nem em `fila`.
// Uso: node add-venda-catalogo.js <invId> "<caminho do .xlsx>" [--apply]
//   Sem --apply é modo seco (nenhuma escrita).
// Rodar SÓ com o balanço fechado: os celulares carregam o catálogo na sessão.
const XLSX = require('xlsx');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
initializeApp({ credential: cert(require('./firebase-service-account.json')) });
const db = getFirestore();

const args = process.argv.slice(2).filter(a => a !== '--apply');
const APPLY = process.argv.includes('--apply');
const invId = args[0], xlsxPath = args[1];
if (!invId || !xlsxPath) { console.error('Uso: node add-venda-catalogo.js <invId> "<arquivo.xlsx>" [--apply]'); process.exit(1); }

// TEMPLATE MERCADORIAS: linha 1 = cabeçalho, linha 2 = descrição das colunas, dados a partir da 3ª.
// Coluna B = codigo, H = preço (venda), L = custo unitário.
function lerPrecos(path) {
  const wb = XLSX.readFile(path);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const precos = {};
  rows.slice(2).forEach(r => {
    const cod = r[1], p = Number(r[7]);
    if (cod == null || cod === '' || !isFinite(p)) return;
    precos[String(Math.trunc(Number(cod)))] = p;
  });
  return precos;
}

(async () => {
  const precos = lerPrecos(xlsxPath);
  console.log('Preços lidos do Excel:', Object.keys(precos).length);
  const snap = await db.collection('inv_catalogo_blocos').where('invId', '==', invId).get();
  if (snap.empty) { console.error('Nenhum bloco de catálogo pro inventário', invId); process.exit(1); }
  let total = 0, comPreco = 0, jaTinha = 0, mudaria = 0;
  const updates = [];
  snap.forEach(d => {
    const itens = (d.data().itens || []).map(it => {
      total++;
      const p = precos[String(it.c)];
      if (it.v != null) jaTinha++;
      if (p == null) return it;
      comPreco++;
      if (it.v !== p) mudaria++;
      return Object.assign({}, it, { v: p });
    });
    updates.push({ ref: d.ref, itens });
  });
  console.log(`Blocos: ${snap.size} | itens: ${total} | com preço no Excel: ${comPreco} | sem preço: ${total - comPreco} | já tinham v: ${jaTinha} | vão mudar: ${mudaria}`);
  console.log('Campos alterados: só `itens[].v` dos blocos. inv_bipagens, fila e o doc do inventário: intocados.');
  if (!APPLY) { console.log('\nMODO SECO — nada gravado. Rode com --apply.'); process.exit(0); }
  for (const u of updates) { await u.ref.update({ itens: u.itens }); console.log('  gravado bloco', u.ref.id); }
  console.log('\nOK.');
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
