// Limite de tentativas de login, em memória (reiniciar a API zera). 25/11/2026.
// Mesmo desenho do Econômico Relatórios (lib/seguranca-acesso.js → criarLimiteLogin), com folga maior:
// aqui quem loga é operador de loja no celular, e várias pessoas da mesma loja saem pelo mesmo IP.
//
// Três contadores na mesma janela de 15 min, só ERRO conta:
//   conta+IP  (quem erra a própria senha)            10 erros
//   conta     (ataque numa conta vindo de vários IPs) 30 erros
//   IP        (um IP testando várias contas)          60 erros
// Estourou = 15 min de espera; durante a espera a senha nem é conferida.
'use strict';

function criarLimiteLogin(opc) {
  opc = opc || {};
  const janelaMs = opc.janelaMs || 15 * 60 * 1000;
  const bloqueioMs = opc.bloqueioMs || 15 * 60 * 1000;
  const maximos = { par: opc.maxPorContaIp || 10, conta: opc.maxPorConta || 30, ip: opc.maxPorIp || 60 };
  const maxRegistros = opc.maxRegistros || 20000;
  const reg = new Map(); // chave → { falhas: [instantes], ate: fim do bloqueio }

  const normal = (conta) => String(conta == null ? '' : conta).toLowerCase().trim().slice(0, 120);
  const chaves = (conta, ip) => {
    const c = normal(conta), i = String(ip || 'desconhecido').slice(0, 60);
    return [['par', 'p|' + c + '|' + i], ['conta', 'c|' + c], ['ip', 'i|' + i]];
  };
  const faxina = (agora) => {
    if (reg.size < maxRegistros) return;
    for (const [k, v] of reg) {
      const ultima = v.falhas.length ? v.falhas[v.falhas.length - 1] : 0;
      if (v.ate <= agora && agora - ultima > janelaMs) reg.delete(k);
    }
    if (reg.size >= maxRegistros) for (const [k, v] of reg) if (v.ate <= agora) reg.delete(k);
  };

  /** Milissegundos que faltam de bloqueio (0 = pode tentar). */
  function bloqueado(conta, ip, agora) {
    agora = agora || Date.now();
    let falta = 0;
    for (const [, k] of chaves(conta, ip)) {
      const v = reg.get(k);
      if (v && v.ate > agora) falta = Math.max(falta, v.ate - agora);
    }
    return falta;
  }

  /** Registra uma senha errada. Devolve true quando ESTA falha disparou um bloqueio. */
  function falha(conta, ip, agora) {
    agora = agora || Date.now();
    faxina(agora);
    let bloqueou = false;
    for (const [tipo, k] of chaves(conta, ip)) {
      let v = reg.get(k);
      if (!v) { v = { falhas: [], ate: 0 }; reg.set(k, v); }
      v.falhas = v.falhas.filter((t) => agora - t < janelaMs);
      v.falhas.push(agora);
      if (v.falhas.length >= maximos[tipo]) { v.ate = agora + bloqueioMs; v.falhas = []; bloqueou = true; }
    }
    return bloqueou;
  }

  /** Login certo: zera só o contador conta+IP (os outros dois seguem valendo contra ataque em andamento). */
  function sucesso(conta, ip) { reg.delete(chaves(conta, ip)[0][1]); }

  const aviso = (faltaMs) => 'Muitas tentativas de login. Aguarde ' + Math.max(1, Math.ceil(faltaMs / 60000)) + ' min e tente de novo.';

  return { bloqueado, falha, sucesso, aviso, _tamanho: () => reg.size };
}

module.exports = { criarLimiteLogin };
