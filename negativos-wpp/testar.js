'use strict';
process.chdir(__dirname);

const mysql       = require('mysql2/promise');
const PDFDocument = require('pdfkit');
const path        = require('path');
const fs          = require('fs');
const pino        = require('pino');
const qrcode      = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const DB         = { host:'192.168.2.252', port:3306, user:'root', password:'1900', database:'central', connectTimeout:15000 };
const GRUPO_NOME = 'CENTRAL ( Aux ) PREVENÇÃO DE PERDAS';
const LOGO_PATH  = path.join(__dirname, '..', 'public', 'logo.png');
const logger     = pino({ level:'info' });
const NOMES_LOJA = { 1:'CAHU', 2:'MURIBECA', 3:'PONTE', 4:'ATACAREJO', 5:'PORTA LARGA', 6:'JARDIM JORDAO' };

async function buscarNegativos() {
  const conn = await mysql.createConnection(DB);
  try {
    const [rows] = await conn.query(`
      SELECT
        i.CodigoBarra                          AS Codigo,
        i.Descricao,
        COALESCE(g.Descricao, 'SEM GRUPO')    AS Grupo,
        COALESCE(sg.Descricao, 'SEM SUBGRUPO') AS SubGrupo,
        COALESCE(e1.Qtd, 0) AS L1, COALESCE(e2.Qtd, 0) AS L2,
        COALESCE(e3.Qtd, 0) AS L3, COALESCE(e4.Qtd, 0) AS L4,
        COALESCE(e5.Qtd, 0) AS L5, COALESCE(e6.Qtd, 0) AS L6
      FROM central.itens i
      LEFT JOIN central.estoquen1 e1 ON e1.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen2 e2 ON e2.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen3 e3 ON e3.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen4 e4 ON e4.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen5 e5 ON e5.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen6 e6 ON e6.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.gruposub sg ON sg.CodSubGrupo = i.CodGrupoSub
      LEFT JOIN central.grupo    g  ON g.CodGrupo     = sg.CodGrupo
      WHERE i.CodDesativado = 0
        AND i.Descricao NOT LIKE '% KG%'
        AND i.CodigoBarra IS NOT NULL
        AND CHAR_LENGTH(i.CodigoBarra) > 5
        AND (COALESCE(e1.Qtd,0)<0 OR COALESCE(e2.Qtd,0)<0 OR
             COALESCE(e3.Qtd,0)<0 OR COALESCE(e4.Qtd,0)<0 OR
             COALESCE(e5.Qtd,0)<0 OR COALESCE(e6.Qtd,0)<0)
      ORDER BY g.Descricao, sg.Descricao, i.Descricao
    `);
    return rows;
  } finally { conn.end(); }
}

async function gerarPDF(rows) {
  const doc    = new PDFDocument({ size:'A4', margin:0, bufferPages:true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const hoje     = new Date();
  const dataHora = hoje.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})
                 + ' — ' + hoje.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});

  const ML=36, PW=595-72;
  const CX=ML, CD=ML+110, CEL=ML+360, CSI=ML+435;
  const CWX=105, CWD=245, CWEL=70, CWSI=PW-(CD-ML)-CWD-CWEL-5;

  function cabecalho(ln) {
    let y=30;
    doc.rect(0,0,595,68).fill('#1E40AF');
    if(fs.existsSync(LOGO_PATH)){try{doc.image(LOGO_PATH,ML,y-4,{height:44});}catch(_){}}
    const txX=fs.existsSync(LOGO_PATH)?ML+60:ML;
    doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold').text('ECONÔMICO RELATÓRIOS',txX,y,{width:PW-60});
    doc.fillColor('#BFDBFE').fontSize(9).font('Helvetica').text('Auditoria de Estoque Negativo',txX,y+22,{width:PW-60});
    y=68;
    doc.rect(0,y,595,24).fill('#1E3A5F');
    doc.fillColor('#FFFFFF').fontSize(12).font('Helvetica-Bold').text(`Loja ${ln} — ${NOMES_LOJA[ln]||'LOJA '+ln}`,ML,y+6);
    y+=24;
    doc.rect(0,y,595,16).fill('#E2E8F0');
    doc.fillColor('#334155').fontSize(8).font('Helvetica-Oblique').text(`Tipo: AUDITORIA ESTOQUE   |   Emissão: ${dataHora}`,ML,y+4);
    y+=16;
    doc.rect(0,y,595,18).fill('#334E68');
    doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
    doc.text('Código',CX,y+5,{width:CWX,align:'center'});
    doc.text('Descrição',CD,y+5,{width:CWD});
    doc.text('Estoque/Loja',CEL,y+5,{width:CWEL,align:'center'});
    doc.text('Sistema',CSI,y+5,{width:CWSI,align:'center'});
    return y+18;
  }

  let first=true;
  for(let ln=1;ln<=6;ln++){
    const chave='L'+ln;
    const itens=rows.filter(r=>parseFloat(r[chave])<0);
    if(!first) doc.addPage(); first=false;
    let y=cabecalho(ln);

    const grupos={};
    itens.forEach(r=>{
      const g=(r.SubGrupo||r.Grupo||'SEM GRUPO').toUpperCase();
      if(!grupos[g]) grupos[g]=[];
      grupos[g].push(r);
    });

    let idx=0;
    for(const [nomeGrupo,produtos] of Object.entries(grupos)){
      if(y>790){doc.addPage();y=cabecalho(ln);}
      doc.rect(0,y,595,16).fill('#F97316');
      doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold').text(nomeGrupo,ML+4,y+4,{width:PW});
      y+=16;
      for(const r of produtos){
        if(y>800){doc.addPage();y=cabecalho(ln);}
        const bg=idx%2===0?'#FFFFFF':'#F1F5F9';
        doc.rect(0,y,595,14).fill(bg);
        doc.fillColor('#1F2937').fontSize(8).font('Helvetica');
        doc.text(String(r.Codigo||''),CX,y+3,{width:CWX});
        doc.text(String(r.Descricao||'').substring(0,48),CD,y+3,{width:CWD});
        doc.text('',CEL,y+3,{width:CWEL,align:'center'});
        doc.fillColor('#DC2626').font('Helvetica-Bold').text(String(r[chave]),CSI,y+3,{width:CWSI,align:'center'});
        doc.strokeColor('#E2E8F0').lineWidth(0.3).moveTo(0,y+14).lineTo(595,y+14).stroke();
        y+=14; idx++;
      }
    }
    if(y>800){doc.addPage();y=cabecalho(ln);}
    doc.rect(0,y,595,16).fill('#F8FAFC');
    doc.fillColor('#64748B').fontSize(8).font('Helvetica-Oblique').text(`Total: ${itens.length} produto(s) com estoque negativo`,ML,y+4);
    doc.rect(0,820,595,22).fill('#1E40AF');
    doc.fillColor('#93C5FD').fontSize(7).font('Helvetica').text('ECONÔMICO RELATÓRIOS  |  Gerado automaticamente  |  Uso interno',ML,826,{align:'center',width:PW});
  }

  doc.end();
  return new Promise(resolve=>doc.on('end',()=>resolve(Buffer.concat(chunks))));
}

(async()=>{
  logger.info('Buscando negativos...');
  const rows=await buscarNegativos();
  logger.info(`${rows.length} produto(s) encontrado(s)`);
  if(!rows.length){logger.info('Nenhum negativo. Encerrando.');process.exit(0);}

  logger.info('Gerando PDF...');
  const buffer=await gerarPDF(rows);
  logger.info('PDF gerado. Conectando ao WhatsApp...');

  const {state,saveCreds}=await useMultiFileAuthState('./auth_info');
  const {version}=await fetchLatestBaileysVersion();
  const sock=makeWASocket({version,auth:state,logger:pino({level:'silent'})});
  sock.ev.on('creds.update',saveCreds);

  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Timeout WA')),60000);
    let ok=false;
    sock.ev.on('connection.update',({connection,qr})=>{
      if(qr) qrcode.generate(qr,{small:true});
      if(connection==='open'&&!ok){ok=true;clearTimeout(timer);resolve();}
    });
  });

  const grupos=await sock.groupFetchAllParticipating();
  const jid=Object.keys(grupos).find(id=>grupos[id].subject===GRUPO_NOME);
  if(!jid){logger.error(`Grupo "${GRUPO_NOME}" não encontrado`);process.exit(1);}

  const hoje=new Date().toLocaleDateString('pt-BR');
  await sock.sendMessage(jid,{
    document:Buffer.from(buffer),
    mimetype:'application/pdf',
    fileName:`negativos_${new Date().toISOString().slice(0,10)}.pdf`,
    caption:`*Estoque Negativo — ${hoje}*\n${rows.length} produto(s) com estoque negativo (excl. balança)`,
  });

  logger.info('PDF enviado com sucesso!');
  setTimeout(()=>process.exit(0),2000);
})().catch(e=>{console.error(e);process.exit(1);});
