'use strict';
// Dispara o envio imediatamente — só para teste
process.chdir(__dirname);

const mysql   = require('mysql2/promise');
const ExcelJS = require('exceljs');
const pino    = require('pino');
const qrcode  = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');

const DB         = { host:'192.168.2.252', port:3306, user:'root', password:'1900', database:'central', connectTimeout:15000 };
const GRUPO_NOME = 'CENTRAL ( Aux ) PREVENÇÃO DE PERDAS';
const logger     = pino({ level:'info' });

async function buscarNegativos() {
  const conn = await mysql.createConnection(DB);
  try {
    const [rows] = await conn.query(`
      SELECT i.Codigo, i.Descricao,
        COALESCE(g.Descricao,'SEM GRUPO') AS Grupo,
        COALESCE(sg.Descricao,'SEM SUBGRUPO') AS SubGrupo,
        COALESCE(e1.Qtd,0) AS L1, COALESCE(e2.Qtd,0) AS L2,
        COALESCE(e3.Qtd,0) AS L3, COALESCE(e4.Qtd,0) AS L4,
        COALESCE(e5.Qtd,0) AS L5, COALESCE(e6.Qtd,0) AS L6
      FROM central.itens i
      LEFT JOIN central.estoquen1 e1 ON e1.CodigoBarra=i.CodigoBarra
      LEFT JOIN central.estoquen2 e2 ON e2.CodigoBarra=i.CodigoBarra
      LEFT JOIN central.estoquen3 e3 ON e3.CodigoBarra=i.CodigoBarra
      LEFT JOIN central.estoquen4 e4 ON e4.CodigoBarra=i.CodigoBarra
      LEFT JOIN central.estoquen5 e5 ON e5.CodigoBarra=i.CodigoBarra
      LEFT JOIN central.estoquen6 e6 ON e6.CodigoBarra=i.CodigoBarra
      LEFT JOIN central.gruposub sg ON sg.CodSubGrupo=i.CodGrupoSub
      LEFT JOIN central.grupo    g  ON g.CodGrupo=sg.CodGrupo
      WHERE i.CodDesativado=0 AND i.Descricao NOT LIKE '% KG%'
        AND (COALESCE(e1.Qtd,0)<0 OR COALESCE(e2.Qtd,0)<0 OR
             COALESCE(e3.Qtd,0)<0 OR COALESCE(e4.Qtd,0)<0 OR
             COALESCE(e5.Qtd,0)<0 OR COALESCE(e6.Qtd,0)<0)
      ORDER BY g.Descricao, sg.Descricao, i.Descricao
    `);
    return rows;
  } finally { conn.end(); }
}

const NOMES_LOJA = {1:'CAHU',2:'MURIBECA',3:'PONTE',4:'ATACAREJO',5:'PORTA LARGA',6:'JARDIM JORDAO'};

async function gerarExcel(rows) {
  const wb = new ExcelJS.Workbook();
  for (let ln=1; ln<=6; ln++) {
    const chave = 'L'+ln;
    const itens = rows.filter(r => parseFloat(r[chave])<0);
    const ws    = wb.addWorksheet(`Loja ${ln} - ${NOMES_LOJA[ln]||'LOJA '+ln}`);
    ws.columns=[{key:'Codigo',width:16},{key:'Descricao',width:46},{key:'contagem',width:14},{key:'sistema',width:12}];
    const agora=new Date();
    const dataHora=agora.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})+' — '+agora.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    const r1=ws.addRow(['ECONÔMICO RELATÓRIOS','','','']);
    ws.mergeCells(`A${r1.number}:D${r1.number}`);
    r1.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E40AF'}};
    r1.getCell(1).font={bold:true,color:{argb:'FFFFFFFF'},size:14,name:'Calibri'};
    r1.getCell(1).alignment={horizontal:'center',vertical:'middle'};
    r1.height=28;
    const r2=ws.addRow([`Loja ${ln} — ${NOMES_LOJA[ln]||'LOJA '+ln}`,'','','']);
    ws.mergeCells(`A${r2.number}:D${r2.number}`);
    r2.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3A5F'}};
    r2.getCell(1).font={bold:true,color:{argb:'FFFFFFFF'},size:12};
    r2.getCell(1).alignment={horizontal:'center',vertical:'middle'};
    r2.height=22;
    const r3=ws.addRow([`Tipo: AUDITORIA ESTOQUE — Emissão: ${dataHora}`,'','','']);
    ws.mergeCells(`A${r3.number}:D${r3.number}`);
    r3.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE2E8F0'}};
    r3.getCell(1).font={italic:true,color:{argb:'FF334155'},size:10};
    r3.getCell(1).alignment={horizontal:'center',vertical:'middle'};
    r3.height=18;
    const hdr=ws.addRow(['Código','Descrição','Estoque/Loja','Sistema']);
    hdr.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E40AF'}};c.font={bold:true,color:{argb:'FFFFFFFF'},size:11};c.alignment={horizontal:'center',vertical:'middle'};});
    hdr.height=22;
    ws.views=[{state:'frozen',ySplit:4}];

    const grupos={};
    itens.forEach(r => {
      const g=(r.SubGrupo||r.Grupo||'SEM GRUPO').toUpperCase();
      if(!grupos[g]) grupos[g]=[];
      grupos[g].push(r);
    });

    let idx=0;
    for(const [nomeGrupo,produtos] of Object.entries(grupos)){
      const gRow=ws.addRow([nomeGrupo,'','','']);
      ws.mergeCells(`A${gRow.number}:D${gRow.number}`);
      gRow.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFA500'}};
      gRow.getCell(1).font={bold:true,color:{argb:'FF000000'},size:10};
      gRow.getCell(1).alignment={horizontal:'left',vertical:'middle',indent:1};
      gRow.height=18;
      produtos.forEach(r=>{
        const row=ws.addRow({Codigo:r.Codigo,Descricao:r.Descricao,contagem:'',sistema:r[chave]});
        const bg=idx%2===0?'FFFFFFFF':'FFF1F5F9';
        row.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:bg}};c.alignment={vertical:'middle'};});
        const cel=row.getCell('sistema');
        if(parseFloat(cel.value)<0) cel.font={color:{argb:'FFDC2626'},bold:true};
        row.height=16; idx++;
      });
    }
    const tot=ws.addRow({Codigo:'',Descricao:`Total: ${itens.length} produto(s)`,contagem:'',sistema:''});
    tot.font={bold:true,italic:true,color:{argb:'FF64748B'}};
  }
  return wb.xlsx.writeBuffer();
}

(async () => {
  logger.info('Buscando negativos...');
  const rows = await buscarNegativos();
  logger.info(`${rows.length} produto(s) com estoque negativo`);
  if (!rows.length) { logger.info('Nenhum negativo. Encerrando.'); process.exit(0); }

  const buffer = await gerarExcel(rows);
  logger.info('Planilha gerada. Conectando ao WhatsApp...');

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth:state, logger:pino({level:'silent'}) });
  sock.ev.on('creds.update', saveCreds);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout WA')), 60000);
    let ok = false;
    sock.ev.on('connection.update', ({ connection, qr }) => {
      if (qr) { qrcode.generate(qr,{small:true}); }
      if (connection==='open' && !ok) { ok=true; clearTimeout(timer); resolve(); }
    });
  });

  const grupos = await sock.groupFetchAllParticipating();
  const jid    = Object.keys(grupos).find(id => grupos[id].subject === GRUPO_NOME);
  if (!jid) { logger.error(`Grupo "${GRUPO_NOME}" não encontrado`); process.exit(1); }

  const hoje = new Date().toLocaleDateString('pt-BR');
  await sock.sendMessage(jid, {
    document: Buffer.from(buffer),
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `negativos_${new Date().toISOString().slice(0,10)}.xlsx`,
    caption:  `*Estoque Negativo — ${hoje}*\n${rows.length} produto(s) com estoque negativo (excl. balança)`,
  });

  logger.info('Planilha enviada com sucesso!');
  setTimeout(() => process.exit(0), 2000);
})().catch(e => { console.error(e); process.exit(1); });
