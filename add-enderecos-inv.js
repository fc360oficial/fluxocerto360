// Acrescenta endereços a um inventário ABERTO sem tocar em fila/bipagens.
// Uso: node add-enderecos-inv.js <invId> 16 17 18 19 20 [--apply]
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
initializeApp({ credential: cert(require('./firebase-service-account.json')) });
const db = getFirestore();

const args = process.argv.slice(2).filter(a => a !== '--apply');
const APPLY = process.argv.includes('--apply');
const invId = args[0];
const novos = args.slice(1).map(s => s.trim()).filter(Boolean);

(async () => {
  const ref = db.collection('inv_inventarios').doc(invId);
  const snap = await ref.get();
  if (!snap.exists) { console.error('Inventário não encontrado:', invId); process.exit(1); }
  const v = snap.data();
  const atuais = v.enderecos || [];
  const jaExistem = novos.filter(e => atuais.includes(e));
  const aAdicionar = novos.filter(e => !atuais.includes(e));

  console.log('Inventário:', v.nome, '| status:', v.status, '| atuais:', atuais.length);
  if (jaExistem.length) console.log('JÁ EXISTEM (ignorados):', jaExistem.join(', '));
  console.log('A ADICIONAR:', aAdicionar.join(', ') || '(nenhum)');
  console.log('Fica com:', atuais.length + aAdicionar.length, 'endereços. Fila e bipagens: intocadas.');

  if (!APPLY) { console.log('\nMODO SECO — nada gravado. Rode com --apply.'); process.exit(0); }
  if (!aAdicionar.length) { console.log('Nada a fazer.'); process.exit(0); }
  await ref.update({ enderecos: FieldValue.arrayUnion(...aAdicionar) });
  const dep = (await ref.get()).data().enderecos;
  console.log('\nOK. Endereços agora:', JSON.stringify(dep));
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
