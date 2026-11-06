// Login próprio (fase 3). Usuário = documento da coleção `usuarios`; senha = tabela credencial (bcrypt).
// Transição sem ninguém trocar senha: no 1º login sem credencial local a senha é conferida
// no Firebase Auth (REST signInWithPassword) ou no hash SHA-256 legado do documento, e aí
// vira bcrypt aqui. Depois disso o Firebase não é mais consultado.
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { limparSensiveis } = require('./documentos');

const VALIDADE_TOKEN = '30d';
const CACHE_MS = 60 * 1000;

class ErroAuth extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function criarAuth(opts) {
  const { pool, segredo } = opts;
  const firebaseApiKey = opts.firebaseApiKey || '';
  const fetchFn = opts.fetch || global.fetch;
  if (!segredo || segredo.length < 16) throw new Error('JWT_SECRET ausente ou curto');
  const cache = new Map(); // id -> { usuario, ate }

  async function usuarioPorEmail(email) {
    const { rows } = await pool.query("SELECT id, dados FROM documento WHERE colecao='usuarios' AND lower(dados->>'email') = lower($1) LIMIT 1", [email]);
    return rows.length ? Object.assign({ id: rows[0].id }, rows[0].dados) : null;
  }
  async function usuarioPorId(id) {
    const c = cache.get(id);
    if (c && c.ate > Date.now()) return c.usuario;
    const { rows } = await pool.query("SELECT id, dados FROM documento WHERE colecao='usuarios' AND id=$1", [id]);
    const u = rows.length ? Object.assign({ id: rows[0].id }, rows[0].dados) : null;
    cache.set(id, { usuario: u, ate: Date.now() + CACHE_MS });
    return u;
  }
  function esquecer(id) { cache.delete(id); }

  function resumo(u) {
    return { id: u.id, email: (u.email || '').toLowerCase(), clienteId: u.clienteId || (u.perfil === 'superadmin' ? '' : 'economico'),
      loja: u.loja || '', nome: u.nome || '', perfil: u.perfil || '' };
  }

  function emitir(u, extra) {
    const r = Object.assign(resumo(u), extra || {});
    return jwt.sign({ sub: r.id, email: r.email, clienteId: r.clienteId, loja: r.loja, nome: r.nome, perfil: r.perfil, imp: !!(extra && extra.imp) }, segredo, { expiresIn: VALIDADE_TOKEN });
  }

  async function conferirFirebase(email, senha) {
    if (!firebaseApiKey || !fetchFn) return false;
    try {
      const r = await fetchFn('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + firebaseApiKey, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: senha, returnSecureToken: false }), signal: AbortSignal.timeout(10000) });
      return r.ok;
    } catch { return false; }
  }

  function conferirLegado(u, senha) {
    const h = u && u.senha;
    if (!h || typeof h !== 'string') return false;
    if (/^[a-f0-9]{64}$/i.test(h)) return crypto.createHash('sha256').update(senha).digest('hex').toLowerCase() === h.toLowerCase();
    return h === senha; // senha em claro de cadastros muito antigos
  }

  async function definirSenha(usuarioId, email, senha, origem) {
    const hash = await bcrypt.hash(String(senha), 10);
    await pool.query(
      `INSERT INTO credencial (usuario_id, email, senha_hash, origem) VALUES ($1,$2,$3,$4)
       ON CONFLICT (usuario_id) DO UPDATE SET email=EXCLUDED.email, senha_hash=EXCLUDED.senha_hash, origem=EXCLUDED.origem, atualizado_em=now()`,
      [usuarioId, String(email || '').toLowerCase(), hash, origem || 'bcrypt']);
  }

  // → { token, usuario } ou lança ErroAuth(401/403)
  async function login(email, senha) {
    email = String(email || '').trim().toLowerCase();
    senha = String(senha || '');
    if (!email || !senha) throw new ErroAuth(400, 'Informe e-mail e senha');
    const u = await usuarioPorEmail(email);
    if (!u) throw new ErroAuth(401, 'E-mail ou senha incorretos');
    if (u.ativo === false) throw new ErroAuth(403, 'Usuário inativo. Contate o administrador.');
    const { rows } = await pool.query('SELECT senha_hash FROM credencial WHERE usuario_id=$1', [u.id]);
    let ok = false, origem = null;
    if (rows.length) ok = await bcrypt.compare(senha, rows[0].senha_hash);
    else if (await conferirFirebase(email, senha)) { ok = true; origem = 'firebase'; }
    else if (conferirLegado(u, senha)) { ok = true; origem = 'legado'; }
    if (!ok) throw new ErroAuth(401, 'E-mail ou senha incorretos');
    if (origem) await definirSenha(u.id, email, senha, origem);
    esquecer(u.id);
    return { token: emitir(u), usuario: limparSensiveis('usuarios', u) };
  }

  // Bearer → usuário (fresco, cache 60 s). Devolve null se não for um JWT nosso.
  async function verificar(token) {
    let payload;
    try { payload = jwt.verify(token, segredo); } catch { return null; }
    if (payload.imp) { // superadmin operando como um cliente: o próprio token descreve o usuário
      return { id: payload.sub, email: payload.email, clienteId: payload.clienteId, loja: payload.loja || '', nome: payload.nome || 'Super Admin', perfil: payload.perfil || 'admin', imp: true };
    }
    const u = await usuarioPorId(payload.sub);
    if (!u || u.ativo === false) throw new ErroAuth(401, 'Usuário não encontrado ou inativo');
    return resumo(u);
  }

  return { login, verificar, emitir, definirSenha, usuarioPorEmail, usuarioPorId, esquecer, resumo, ErroAuth };
}

module.exports = { criarAuth, ErroAuth };
