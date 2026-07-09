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

async function gerarExcel(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Estoque Negativo');

  const AZUL   = '1E40AF';
  const BRANCO = 'FFFFFF';
  const VERML  = 'DC2626';
  const CINZA  = 'F1F5F9';

  ws.columns = [
    { header: 'Código',    key: 'Codigo',   width: 14 },
    { header: 'Descrição', key: 'Descricao',width: 40 },
    { header: 'Grupo',     key: 'Grupo',    width: 20 },
    { header: 'SubGrupo',  key: 'SubGrupo', width: 20 },
    { header: 'Loja 1',    key: 'L1',       width: 9  },
    { header: 'Loja 2',    key: 'L2',       width: 9  },
    { header: 'Loja 3',    key: 'L3',       width: 9  },
    { header: 'Loja 4',    key: 'L4',       width: 9  },
    { header: 'Loja 5',    key: 'L5',       width: 9  },
    { header: 'Loja 6',    key: 'L6',       width: 9  },
  ];

  // Cabeçalho azul
  const hdr = ws.getRow(1);
  hdr.eachCell(cell => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + AZUL } };
    cell.font   = { bold: true, color: { argb: 'FF' + BRANCO }, size: 11 };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF' + BRANCO } } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  hdr.height = 20;

  rows.forEach((r, i) => {
    const row = ws.addRow(r);
    const bg  = i % 2 === 0 ? 'FFFFFFFF' : 'FF' + CINZA;
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'middle' };
    });
    // Células negativas em vermelho
    ['L1','L2','L3','L4','L5','L6'].forEach(col => {
      const cell = row.getCell(col);
      if (parseFloat(cell.value) < 0) {
        cell.font = { color: { argb: 'FF' + VERML }, bold: true };
      }
    });
    row.height = 16;
  });

  ws.autoFilter = { from: 'A1', to: 'J1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

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
