// Quem pode mexer no cadastro e na senha de quem (25/11/2026).
//
// Antes, qualquer gestor (admin, gerência, supervisor) trocava a senha e o cadastro de QUALQUER usuário
// "do mesmo cliente" — e o documento do superadmin, que não tem clienteId, era lido como se fosse do
// Econômico. Resultado: um gestor virava superadmin trocando a senha dele.
//
// Regra única, usada por /auth/senha, /auth/usuarios e pelas gravações na coleção `usuarios`:
//   - superadmin: tudo;
//   - ninguém além do superadmin toca em documento de superadmin, nem atribui esse perfil;
//   - admin: qualquer usuário do próprio cliente;
//   - gerência e supervisor: só quem está ABAIXO deles (operador, prevenção…), nunca outro gestor,
//     e não mudam o próprio perfil;
//   - os demais: só o que já podiam no próprio cadastro (aparelho, push, foto, telefone).
'use strict';

const NIVEL = { superadmin: 4, admin: 3, gerencia: 2, supervisor: 2 };
const nivel = (perfil) => NIVEL[perfil] || 1;

// Cliente de verdade de um documento de usuário: superadmin não pertence a cliente nenhum;
// documento antigo sem clienteId é do Econômico (anterior ao multi-cliente).
const clienteDe = (u) => (u && u.perfil === 'superadmin') ? '' : ((u && u.clienteId) || 'economico');

/** `quem` (usuário do token) pode alterar cadastro/senha do documento `alvo`? */
function podeGerir(quem, alvo) {
  if (!quem || !alvo) return false;
  if (quem.perfil === 'superadmin') return true;
  if (alvo.perfil === 'superadmin') return false;
  if (!quem.clienteId || clienteDe(alvo) !== quem.clienteId) return false;
  if (quem.perfil === 'admin') return true;
  return nivel(quem.perfil) >= 2 && nivel(alvo.perfil) < nivel(quem.perfil);
}

/** `quem` pode dar o perfil `perfil` a alguém (criando ou editando)? */
function podeAtribuir(quem, perfil) {
  if (!quem) return false;
  if (quem.perfil === 'superadmin') return true;
  if (perfil === 'superadmin') return false;
  if (quem.perfil === 'admin') return true;
  return nivel(quem.perfil) >= 2 && nivel(perfil) < nivel(quem.perfil);
}

module.exports = { nivel, clienteDe, podeGerir, podeAtribuir };
