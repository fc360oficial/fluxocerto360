// Fotos em disco: data URI (data:image/jpeg;base64,...) vira arquivo em
// <raiz>/<cliente>/<data>/<id>.<ext>. Só metadados vão pro banco.
'use strict';
const fs = require('fs');
const path = require('path');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function decodificarDataUri(dataUri) {
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUri || '');
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!EXT[mime]) return null;
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length) return null;
  return { mime, buf };
}

function nomeSeguro(s) {
  return String(s || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180) || '_';
}

// Devolve { arquivo (relativo à raiz), mime, bytes } ou null se o data URI for inválido.
function salvar(raiz, { clienteId, dateIso, id, dataUri }) {
  const dec = decodificarDataUri(dataUri);
  if (!dec) return null;
  const rel = path.posix.join(nomeSeguro(clienteId), nomeSeguro(dateIso || 'sem-data'), nomeSeguro(id) + '.' + EXT[dec.mime]);
  const abs = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, dec.buf);
  return { arquivo: rel, mime: dec.mime, bytes: dec.buf.length };
}

function ler(raiz, arquivo) {
  const abs = path.join(raiz, arquivo);
  if (!abs.startsWith(path.resolve(raiz))) return null;
  try { return fs.readFileSync(abs); } catch { return null; }
}

function comoDataUri(mime, buf) {
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

module.exports = { decodificarDataUri, salvar, ler, comoDataUri, nomeSeguro };
