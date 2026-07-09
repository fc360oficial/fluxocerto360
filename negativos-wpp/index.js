'use strict';
const mysql   = require('mysql2/promise');
const cron    = require('node-cron');
const ExcelJS = require('exceljs');
const qrcode  = require('qrcode-terminal');
const pino    = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const DB = { host: '192.168.2.252', port: 3306, user: 'root', password: '1900', database: 'central', connectTimeout: 15000 };
const GRUPO_NOME = 'CENTRAL ( Aux ) PREVENÇÃO DE PERDAS';
const logger = pino({ level: 'info' });

let sock = null;

// ── Banco ─────────────────────────────────────────────────────────────────────

async function buscarNegativos() {
  const conn = await mysql.createConnection(DB);
  try {
    const [rows] = await conn.query(`
      SELECT
        i.Codigo,
        i.Descricao,
        COALESCE(g.Descricao, 'SEM GRUPO')    AS Grupo,
        COALESCE(sg.Descricao, 'SEM SUBGRUPO') AS SubGrupo,
        COALESCE(e1.Qtd, 0) AS L1,
        COALESCE(e2.Qtd, 0) AS L2,
        COALESCE(e3.Qtd, 0) AS L3,
        COALESCE(e4.Qtd, 0) AS L4,
        COALESCE(e5.Qtd, 0) AS L5,
        COALESCE(e6.Qtd, 0) AS L6
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
        AND (
          COALESCE(e1.Qtd, 0) < 0 OR
          COALESCE(e2.Qtd, 0) < 0 OR
          COALESCE(e3.Qtd, 0) < 0 OR
          COALESCE(e4.Qtd, 0) < 0 OR
          COALESCE(e5.Qtd, 0) < 0 OR
          COALESCE(e6.Qtd, 0) < 0
        )
      ORDER BY g.Descricao, sg.Descricao, i.Descricao
    `);
    return rows;
  } finally {
    conn.end();
  }
}

// ── Excel ─────────────────────────────────────────────────────────────────────

const NOMES_LOJA = { 1:'CAHU', 2:'MURIBECA', 3:'PONTE', 4:'ATACAREJO', 5:'PORTA LARGA', 6:'JARDIM JORDAO' };

async function gerarExcel(rows) {
  const wb = new ExcelJS.Workbook();

  const AZUL  = 'FF1E40AF';
  const BRNCO = 'FFFFFFFF';
  const VERML = 'FFDC2626';
  const CINZA = 'FFF1F5F9';

  for (let ln = 1; ln <= 6; ln++) {
    const chave    = 'L' + ln;
    const itens    = rows.filter(r => parseFloat(r[chave]) < 0);
    const nomeLoja = NOMES_LOJA[ln] || ('LOJA ' + ln);
    const ws       = wb.addWorksheet(`Loja ${ln} - ${nomeLoja}`);

    ws.columns = [
      { key: 'Codigo',   width: 16 },
      { key: 'Descricao',width: 46 },
      { key: 'contagem', width: 14 },
      { key: 'sistema',  width: 12 },
    ];

    const agora    = new Date();
    const dataHora = agora.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', year:'numeric' })
                   + ' — ' + agora.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });

    // Linha 1: marca
    const r1 = ws.addRow(['ECONÔMICO RELATÓRIOS', '', '', '']);
    ws.mergeCells(`A${r1.number}:D${r1.number}`);
    r1.getCell(1).fill      = { type:'pattern', pattern:'solid', fgColor:{ argb: AZUL } };
    r1.getCell(1).font      = { bold:true, color:{ argb: BRNCO }, size:14, name:'Calibri' };
    r1.getCell(1).alignment = { horizontal:'center', vertical:'middle' };
    r1.height = 28;

    // Linha 2: nome da loja
    const r2 = ws.addRow([`Loja ${ln} — ${nomeLoja}`, '', '', '']);
    ws.mergeCells(`A${r2.number}:D${r2.number}`);
    r2.getCell(1).fill      = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1E3A5F' } };
    r2.getCell(1).font      = { bold:true, color:{ argb: BRNCO }, size:12 };
    r2.getCell(1).alignment = { horizontal:'center', vertical:'middle' };
    r2.height = 22;

    // Linha 3: data/hora + tipo
    const r3 = ws.addRow([`Tipo: AUDITORIA ESTOQUE — Emissão: ${dataHora}`, '', '', '']);
    ws.mergeCells(`A${r3.number}:D${r3.number}`);
    r3.getCell(1).fill      = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE2E8F0' } };
    r3.getCell(1).font      = { italic:true, color:{ argb:'FF334155' }, size:10 };
    r3.getCell(1).alignment = { horizontal:'center', vertical:'middle' };
    r3.height = 18;

    // Linha 4: cabeçalho das colunas
    const hdr = ws.addRow(['Código', 'Descrição', 'Estoque/Loja', 'Sistema']);
    hdr.eachCell(cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
      cell.font      = { bold: true, color: { argb: BRNCO }, size: 11 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    hdr.height = 22;
    ws.views = [{ state: 'frozen', ySplit: 4 }];

    // Agrupa por SubGrupo
    const grupos = {};
    itens.forEach(r => {
      const g = (r.SubGrupo || r.Grupo || 'SEM GRUPO').toUpperCase();
      if (!grupos[g]) grupos[g] = [];
      grupos[g].push(r);
    });

    let linhaIdx = 0;
    for (const [nomeGrupo, produtos] of Object.entries(grupos)) {
      // Linha de cabeçalho do grupo (laranja, estilo ERP)
      const gRow = ws.addRow([nomeGrupo, '', '', '']);
      ws.mergeCells(`A${gRow.number}:D${gRow.number}`);
      gRow.getCell(1).fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFA500' } };
      gRow.getCell(1).font      = { bold: true, color: { argb: 'FF000000' }, size: 10 };
      gRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      gRow.height = 18;

      // Produtos do grupo
      produtos.forEach(r => {
        const row = ws.addRow({ Codigo: r.Codigo, Descricao: r.Descricao, contagem: '', sistema: r[chave] });
        const bg  = linhaIdx % 2 === 0 ? BRNCO : CINZA;
        row.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }; cell.alignment = { vertical: 'middle' }; });
        const cel = row.getCell('sistema');
        if (parseFloat(cel.value) < 0) cel.font = { color: { argb: VERML }, bold: true };
        row.height = 16;
        linhaIdx++;
      });
    }

    // Rodapé total
    const totRow = ws.addRow({ Codigo: '', Descricao: `Total: ${itens.length} produto(s)`, contagem: '', sistema: '' });
    totRow.font = { bold: true, italic: true, color: { argb: 'FF64748B' } };
  }

  return wb.xlsx.writeBuffer();
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth:   state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Handler único — resolve a Promise E trata reconexões futuras
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout conexão WA')), 120000);
    let resolvido = false;

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        logger.info('Escaneie o QR abaixo para autenticar:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        logger.info('WhatsApp conectado');
        if (!resolvido) { resolvido = true; clearTimeout(timer); resolve(); }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          logger.error('Sessão encerrada. Apague a pasta auth_info e reinicie.');
          if (!resolvido) { clearTimeout(timer); reject(new Error('Deslogado')); }
          else process.exit(1);
        } else {
          logger.warn('Conexão encerrada, reconectando...');
          if (resolvido) setTimeout(conectar, 5000); // só reconecta após primeira conexão
        }
      }
    });
  });
}

async function enviarPlanilha(buffer, nProdutos) {
  const grupos = await sock.groupFetchAllParticipating();
  const jid    = Object.keys(grupos).find(id => grupos[id].subject === GRUPO_NOME);

  if (!jid) {
    logger.error(`Grupo "${GRUPO_NOME}" não encontrado`);
    return;
  }

  const hoje    = new Date().toLocaleDateString('pt-BR');
  const caption = `*Estoque Negativo — ${hoje}*\n${nProdutos} produto(s) com estoque negativo (excl. balança)`;

  await sock.sendMessage(jid, {
    document: Buffer.from(buffer),
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `negativos_${new Date().toISOString().slice(0,10)}.xlsx`,
    caption,
  });

  logger.info(`Planilha enviada para "${GRUPO_NOME}" (${nProdutos} itens)`);
}

// ── Rotina principal ──────────────────────────────────────────────────────────

async function rotina() {
  logger.info('Iniciando rotina de negativos...');
  try {
    const rows = await buscarNegativos();
    if (rows.length === 0) {
      logger.info('Nenhum estoque negativo encontrado.');
      return;
    }
    const buffer = await gerarExcel(rows);
    await enviarPlanilha(buffer, rows.length);
  } catch (err) {
    logger.error({ err }, 'Erro na rotina de negativos');
  }
}

// ── Inicialização ─────────────────────────────────────────────────────────────

(async () => {
  logger.info('Conectando ao WhatsApp...');
  await conectar();

  // Seg-sex às 08:00 (America/Sao_Paulo)
  cron.schedule('0 8 * * 1-5', rotina, { timezone: 'America/Sao_Paulo' });
  logger.info('Agendamento ativo: seg-sex 08:00 (Brasília). Aguardando...');
})();
