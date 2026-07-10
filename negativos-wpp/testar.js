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
    const resultados = await Promise.all(
      [1,2,3,4,5,6].map(ln => conn.query(`
        SELECT
          i.CodigoBarra                           AS Codigo,
          i.Descricao,
          COALESCE(g.Descricao,  'SEM GRUPO')    AS Grupo,
          COALESCE(sg.Descricao, 'SEM SUBGRUPO') AS SubGrupo,
          e.Qtd                                  AS Estoque
        FROM central.itens i
        JOIN central.estoquen${ln} e ON e.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.gruposub sg ON sg.CodSubGrupo = i.CodGrupoSub
        LEFT JOIN central.grupo    g  ON g.CodGrupo     = sg.CodGrupo
        WHERE i.CodDesativado = 0
          AND i.Descricao NOT LIKE '% KG%'
          AND i.CodigoBarra IS NOT NULL
          AND CHAR_LENGTH(i.CodigoBarra) >= 7
          AND e.Qtd < 0
        ORDER BY g.Descricao, sg.Descricao, i.Descricao
      `))
    );
    return Object.fromEntries(resultados.map(([rows], i) => [i + 1, rows]));
  } finally { conn.end(); }
}

function gerarPDFLoja(itens, ln, hoje) {
  const rows = itens;
  const doc    = new PDFDocument({ size:'A4', margin:0, bufferPages:true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const PW = 595, PH = 842, ML = 36, MR = 36, CW = PW - ML - MR;

  const C = {
    cod:  { x: ML,       w: 108 },
    desc: { x: ML + 108, w: 252 },
    est:  { x: ML + 360, w: 88  },
    sis:  { x: ML + 448, w: CW - 360 - 88 },
  };

  const COR = {
    branco:   '#FFFFFF',
    navy:     '#1E2952',
    navySec:  '#4A5568',
    cinza:    '#F7F8FA',
    cinzaMd:  '#EDF0F3',
    borda:    '#DDE1E9',
    laranja:  '#F59E0B',
    laranjaL: '#FFFBEB',
    vermelho: '#E53E3E',
  };

  const ROW_H = 15, GRP_H = 17, COL_H = 19;

  function ln_(x1,y1,x2,y2,c=COR.borda,w=0.5) {
    doc.strokeColor(c).lineWidth(w).moveTo(x1,y1).lineTo(x2,y2).stroke();
  }

  function txt(text, x, y, w, h, { cor=COR.navy, font='Helvetica', size=8, align='left', pad=5 }={}) {
    doc.fillColor(cor).fontSize(size).font(font)
       .text(String(text||''), x+pad, y+Math.max(0,(h-size)/2), { width:w-pad*2, align, lineBreak:false });
  }

  function retomarCabecalho() {
    doc.rect(0,0,PW,PH).fill(COR.branco);
    doc.rect(0,0,PW,2).fill(COR.laranja);
    doc.rect(0,2,PW,26).fill(COR.branco);
    doc.fillColor(COR.navySec).fontSize(7).font('Helvetica-Bold')
       .text(`ECONÔMICO RELATÓRIOS  |  Loja ${ln} — ${NOMES_LOJA[ln]||''}  |  (continuação)`, ML, 10, { width:CW, lineBreak:false });
    const yy = 28;
    doc.rect(0,yy,PW,COL_H).fill(COR.cinzaMd);
    ln_(0,yy,PW,yy,COR.borda,0.5); ln_(0,yy+COL_H,PW,yy+COL_H,COR.borda,0.5);
    txt('CÓDIGO',       C.cod.x, yy,C.cod.w, COL_H,{cor:COR.laranja,font:'Helvetica-Bold',size:7});
    txt('DESCRIÇÃO',    C.desc.x,yy,C.desc.w,COL_H,{cor:COR.laranja,font:'Helvetica-Bold',size:7});
    txt('ESTOQUE/LOJA', C.est.x, yy,C.est.w, COL_H,{cor:COR.laranja,font:'Helvetica-Bold',size:7,align:'center'});
    txt('SISTEMA',      C.sis.x, yy,C.sis.w, COL_H,{cor:COR.laranja,font:'Helvetica-Bold',size:7,align:'center'});
    ln_(C.desc.x,yy,C.desc.x,yy+COL_H,COR.borda);
    ln_(C.est.x, yy,C.est.x, yy+COL_H,COR.borda);
    ln_(C.sis.x, yy,C.sis.x, yy+COL_H,COR.borda);
    return yy+COL_H;
  }

  function cabecalho() {
    doc.rect(0,0,PW,PH).fill(COR.branco);
    doc.rect(0,0,PW,2).fill(COR.laranja);

    const HDR = 68;
    const temLogo = fs.existsSync(LOGO_PATH);
    if (temLogo) { try { doc.image(LOGO_PATH, ML, 12, { height:44 }); } catch(_) {} }
    const txX = temLogo ? ML+54 : ML;

    doc.fillColor(COR.laranja).fontSize(8).font('Helvetica-Bold')
       .text('ECONÔMICO RELATÓRIOS', txX, 16, { width:180, lineBreak:false });
    doc.fillColor(COR.navySec).fontSize(9.5).font('Helvetica')
       .text('Auditoria de Estoque Negativo', txX, 28, { width:180, lineBreak:false });
    doc.fillColor(COR.borda).fontSize(8).font('Helvetica')
       .text('Relatório Operacional', txX, 42, { width:180, lineBreak:false });

    const dL = hoje.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'});
    const hL = hoje.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    doc.fillColor(COR.navySec).fontSize(6.5).font('Helvetica')
       .text('GERADO EM', ML, 14, { width:CW, align:'right', lineBreak:false });
    doc.fillColor(COR.navy).fontSize(13).font('Helvetica-Bold')
       .text(dL, ML, 23, { width:CW, align:'right', lineBreak:false });
    doc.fillColor(COR.navySec).fontSize(9).font('Helvetica')
       .text(hL, ML, 39, { width:CW, align:'right', lineBreak:false });

    ln_(ML, HDR+2, PW-MR, HDR+2, COR.borda, 0.8);
    let y = HDR+10;

    doc.rect(ML, y, 3, 26).fill(COR.laranja);
    doc.fillColor(COR.navy).fontSize(16).font('Helvetica-Bold')
       .text(`LOJA ${ln}  —  ${NOMES_LOJA[ln]||'LOJA '+ln}`, ML+10, y+4, { width:CW-10, lineBreak:false });
    doc.fillColor(COR.navySec).fontSize(8).font('Helvetica')
       .text('Estoque Negativo por Mercadológico', ML+10, y+22, { width:CW-10, lineBreak:false });
    y += 36;

    doc.rect(0,y,PW,COL_H).fill(COR.cinzaMd);
    ln_(0,y,PW,y,COR.borda,0.5); ln_(0,y+COL_H,PW,y+COL_H,COR.borda,0.5);
    txt('CÓDIGO',       C.cod.x, y,C.cod.w, COL_H,{cor:COR.laranja,font:'Helvetica-Bold',size:7,align:'left'});
    txt('DESCRIÇÃO',    C.desc.x,y,C.desc.w,COL_H,{cor:COR.laranja,font:'Helvetica-Bold',size:7});
    txt('ESTOQUE/LOJA', C.est.x, y,C.est.w, COL_H,{cor:COR.laranja,font:'Helvetica-Bold',size:7,align:'center'});
    txt('SISTEMA',      C.sis.x, y,C.sis.w, COL_H,{cor:COR.laranja,font:'Helvetica-Bold',size:7,align:'center'});
    ln_(C.desc.x,y,C.desc.x,y+COL_H,COR.borda);
    ln_(C.est.x, y,C.est.x, y+COL_H,COR.borda);
    ln_(C.sis.x, y,C.sis.x, y+COL_H,COR.borda);
    return y+COL_H;
  }

  let y = cabecalho();

  // Agrupa: Grupo → SubGrupo → produtos (igual ao mercadológico do ERP)
  const arvore = {};
  rows.forEach(r => {
    const grp = (r.Grupo    || 'SEM GRUPO').toUpperCase();
    const sub = (r.SubGrupo || 'SEM SUBGRUPO').toUpperCase();
    if (!arvore[grp]) arvore[grp] = {};
    if (!arvore[grp][sub]) arvore[grp][sub] = [];
    arvore[grp][sub].push(r);
  });

  const SUB_H = 14;
  let idx = 0;

  for (const [nomeGrupo, subGrupos] of Object.entries(arvore)) {
    if (y > 788) { doc.addPage(); y = retomarCabecalho(); }
    // Cabeçalho do GRUPO — fundo laranja sólido
    doc.rect(0,y,PW,GRP_H).fill(COR.laranja);
    doc.fillColor(COR.navy).fontSize(8).font('Helvetica-Bold')
       .text(nomeGrupo, ML+6, y+(GRP_H-8)/2, {width:CW-6, lineBreak:false});
    y += GRP_H;

    for (const [nomeSub, produtos] of Object.entries(subGrupos)) {
      if (y > 790) { doc.addPage(); y = retomarCabecalho(); }
      // Sub-cabeçalho — laranja claro, indentado
      doc.rect(0,y,PW,SUB_H).fill(COR.laranjaL);
      ln_(0,y+SUB_H,PW,y+SUB_H,COR.laranja,0.4);
      doc.fillColor(COR.laranja).fontSize(7).font('Helvetica-Bold').text('▸',ML+10,y+(SUB_H-7)/2,{width:10,lineBreak:false});
      doc.fillColor(COR.navySec).fontSize(7).font('Helvetica-Bold').text(nomeSub,ML+22,y+(SUB_H-7)/2,{width:CW-22,lineBreak:false});
      y += SUB_H;

      for (const r of produtos) {
        if (y > 800) { doc.addPage(); y = retomarCabecalho(); }
        const bg = idx%2===0 ? COR.branco : COR.cinza;
        doc.rect(0,y,PW,ROW_H).fill(bg);
        txt(r.Codigo||'',                             C.cod.x, y,C.cod.w, ROW_H,{size:7.5});
        txt(String(r.Descricao||'').substring(0,54),  C.desc.x,y,C.desc.w,ROW_H,{size:7.5});
        txt('',                                       C.est.x, y,C.est.w, ROW_H,{size:7.5,align:'center'});
        txt(String(r.Estoque),                        C.sis.x, y,C.sis.w, ROW_H,{cor:COR.vermelho,font:'Helvetica-Bold',size:7.5,align:'center'});
        ln_(0,       y+ROW_H,PW,      y+ROW_H,COR.borda,0.3);
        ln_(C.desc.x,y,      C.desc.x,y+ROW_H,COR.borda,0.3);
        ln_(C.est.x, y,      C.est.x, y+ROW_H,COR.borda,0.3);
        ln_(C.sis.x, y,      C.sis.x, y+ROW_H,COR.borda,0.3);
        y += ROW_H; idx++;
      }
    }
  }

  if (y > 808) { doc.addPage(); y = retomarCabecalho(); }
  ln_(ML, y, PW-MR, y, COR.laranja, 0.8);
  y += 6;
  doc.fillColor(COR.navySec).fontSize(7.5).font('Helvetica-Bold')
     .text(`TOTAL: ${rows.length} produto(s) com estoque negativo nesta loja`, ML, y, { width:CW });

  doc.rect(0,PH-20,PW,20).fill(COR.cinzaMd);
  ln_(0,PH-20,PW,PH-20,COR.laranja,1.5);
  doc.fillColor(COR.navySec).fontSize(6.5).font('Helvetica')
     .text('ECONÔMICO RELATÓRIOS  |  Gerado automaticamente  |  Uso interno', ML, PH-13, { align:'center', width:CW, lineBreak:false });

  doc.end();
  return new Promise(resolve => doc.on('end', () => resolve({ buffer:Buffer.concat(chunks), total:itens.length })));
}

(async () => {
  logger.info('Buscando negativos (6 queries paralelas)...');
  const porLoja = await buscarNegativos();
  const total = Object.values(porLoja).reduce((s,a) => s+a.length, 0);
  logger.info(`Total negativos encontrados: ${total}`);
  for (let ln = 1; ln <= 6; ln++) {
    logger.info(`  Loja ${ln} (${NOMES_LOJA[ln]}): ${(porLoja[ln]||[]).length} negativo(s)`);
  }
  if (!total) { logger.info('Nenhum negativo. Encerrando.'); process.exit(0); }

  const { version } = await fetchLatestBaileysVersion();
  let jid = null;

  // Reconecta e retorna socket pronto
  async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const s = makeWASocket({ version, auth:state, logger:pino({level:'silent'}) });
    s.ev.on('creds.update', saveCreds);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout WA')), 60000);
      let ok = false;
      s.ev.on('connection.update', ({ connection, qr }) => {
        if (qr) qrcode.generate(qr, { small:true });
        if (connection === 'open' && !ok) { ok = true; clearTimeout(timer); resolve(); }
      });
    });
    return s;
  }

  logger.info('Conectando ao WhatsApp...');
  let sock = await conectar();
  logger.info('Conectado.');

  const todosGrupos = await sock.groupFetchAllParticipating();
  jid = Object.keys(todosGrupos).find(id => todosGrupos[id].subject === GRUPO_NOME);
  if (!jid) { logger.error(`Grupo "${GRUPO_NOME}" não encontrado`); process.exit(1); }

  const hoje     = new Date();
  const dataStr  = hoje.toLocaleDateString('pt-BR');
  const dataNome = hoje.toISOString().slice(0, 10);

  async function enviar(mensagem) {
    for (let t = 1; t <= 3; t++) {
      try {
        await sock.sendMessage(jid, mensagem);
        return;
      } catch (err) {
        logger.warn(`Tentativa ${t}/3: ${err.message} — reconectando...`);
        await new Promise(r => setTimeout(r, 4000));
        sock = await conectar();
      }
    }
    throw new Error('Falha após 3 tentativas');
  }

  for (let ln = 1; ln <= 6; ln++) {
    const itens = porLoja[ln] || [];
    if (!itens.length) { logger.info(`Loja ${ln}: sem negativos, pulando`); continue; }

    logger.info(`Gerando PDF Loja ${ln}...`);
    try {
      const { buffer, total } = await gerarPDFLoja(itens, ln, hoje);
      const nomeLoja = (NOMES_LOJA[ln]||'LOJA'+ln).replace(/\s+/g,'_');
      await enviar({
        document: Buffer.from(buffer),
        mimetype: 'application/pdf',
        fileName: `negativos_loja${ln}_${nomeLoja}_${dataNome}.pdf`,
        caption:  `*Estoque Negativo — Loja ${ln} (${NOMES_LOJA[ln]}) — ${dataStr}*\n${total} produto(s) negativos`,
      });
      logger.info(`Loja ${ln}: PDF enviado (${total} itens)`);
      await new Promise(r => setTimeout(r, 4000));
    } catch (err) {
      logger.error(`Erro Loja ${ln}: ${err.message}`);
    }
  }

  logger.info('Todos os PDFs enviados!');
  setTimeout(() => process.exit(0), 2000);
})().catch(e => { console.error(e); process.exit(1); });
