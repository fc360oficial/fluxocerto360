/* ═══════════════════════════════════════════════════════════════
   NAVEGAÇÃO ÚNICA — Econômico Relatórios · Executive Ink
   Injeta a MESMA sidebar em todas as páginas do sistema.
   Uso: <script src="/nav.js" defer></script>
   A página só precisa reservar o espaço: margin-left:236px no
   conteúdo (desktop). No mobile (≤820px) vira barra superior fixa
   e o nav.js aplica padding-top no body automaticamente.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var ITENS = [
    { sec: 'Análise' },
    { href: '/index.html',        ic: 'dashboard', txt: 'Dashboard' },
    { href: '/consulta.html',     ic: 'search',    txt: 'Consulta de Vendas' },
    { href: '/itens.html',        ic: 'list',      txt: 'Mercadológico' },
    { href: '/comparativos.html', ic: 'chart',     txt: 'Comparativos' },
    { href: '/gestao-gerencial.html', ic: 'store', txt: 'Gestão Gerencial' },
    { sec: 'Operação' },
    { href: '/fornecedores.html', ic: 'bag',       txt: 'Lista de Compra' },
    { href: '/pendencias.html',   ic: 'alert',     txt: 'Pendências' },
    { href: '/prevencao.html',    ic: 'shield',    txt: 'Prevenção' },
    { href: '/ruptura.html',      ic: 'trend',     txt: 'Gestão de Rupturas' }
  ];

  var css = ''
  + '#dsnav{position:fixed;top:0;left:0;bottom:0;width:236px;z-index:900;'
  +   'background:var(--crd,#FFFFFF);border-right:1px solid var(--ln,#DADAD6);'
  +   'display:flex;flex-direction:column;padding:14px 12px 12px;'
  +   "font-family:'InterVar','Segoe UI',system-ui,sans-serif;overflow-y:auto}"
  + '#dsnav .dn-brand{display:flex;align-items:center;gap:10px;padding:4px 8px 14px;'
  +   'border-bottom:1px solid var(--ln,#DADAD6);margin-bottom:10px;text-decoration:none}'
  + '#dsnav .dn-brand img{height:38px;display:block}'
  + '#dsnav .dn-brand b{font-size:13.5px;color:var(--ink,#0E1626);letter-spacing:-.2px;line-height:1.1}'
  + '#dsnav .dn-brand span{display:block;font-size:9px;color:var(--ink3,#98A0B3);'
  +   'letter-spacing:1.4px;text-transform:uppercase;font-weight:700;margin-top:2px}'
  + '#dsnav .dn-sec{font-size:9.5px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;'
  +   'color:var(--ink3,#98A0B3);padding:12px 10px 6px}'
  + '#dsnav a.dn-item{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:9px;'
  +   'font-size:12.5px;font-weight:600;color:var(--ink2,#4E5A72);text-decoration:none;'
  +   'transition:background .12s ease;margin-bottom:2px;white-space:nowrap}'
  + '#dsnav a.dn-item svg{width:16px;height:16px;stroke:currentColor;stroke-width:1.8;fill:none;'
  +   'stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;color:var(--ink3,#98A0B3)}'
  + '#dsnav a.dn-item:hover{background:var(--wsh,#E4E4E1);color:var(--ink,#0E1626)}'
  + '#dsnav a.dn-item.on{background:var(--amw,#FFF6D9);color:var(--amk,#6B4E00)}'
  + '#dsnav a.dn-item.on svg{color:var(--amk,#6B4E00)}'
  + '#dsnav .dn-foot{margin-top:auto;border-top:1px solid var(--ln,#DADAD6);padding-top:10px;'
  +   'display:flex;align-items:center;gap:9px}'
  + '#dsnav .dn-ava{width:30px;height:30px;border-radius:50%;background:var(--ink,#0E1626);color:#fff;'
  +   'display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}'
  + '#dsnav .dn-user{flex:1;min-width:0}'
  + '#dsnav .dn-user b{display:block;font-size:12px;color:var(--ink,#0E1626);'
  +   'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '#dsnav .dn-user a{font-size:10.5px;color:var(--neg,#C22F49);font-weight:700;text-decoration:none}'
  + 'body.dsnav-pad{margin-left:236px}'
  /* mobile: barra superior fixa com scroll horizontal */
  + '@media(max-width:820px){'
  +   'body.dsnav-pad{margin-left:0;padding-top:96px}'
  +   '#dsnav{width:100%;height:auto;bottom:auto;flex-direction:column;padding:6px 8px;'
  +     'border-right:none;border-bottom:1px solid var(--ln,#DADAD6)}'
  +   '#dsnav .dn-brand{border-bottom:none;padding:2px 6px 4px;margin-bottom:0}'
  +   '#dsnav .dn-brand img{height:26px}'
  +   '#dsnav .dn-brand span{display:none}'
  +   '#dsnav .dn-sec{display:none}'
  +   '#dsnav .dn-rows{display:flex;overflow-x:auto;gap:2px;-webkit-overflow-scrolling:touch}'
  +   '#dsnav a.dn-item{padding:7px 10px;font-size:11px;flex-shrink:0}'
  +   '#dsnav .dn-foot{display:none}'
  + '}';

  function icon(id) {
    return '<svg><use href="/icons.svg#' + id + '"/></svg>';
  }

  function montar() {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    var path = location.pathname.replace(/\/$/, '/index.html');
    if (path === '' || path === '/') path = '/index.html';

    var html = '<a class="dn-brand" href="/index.html">'
      + '<img src="/logo.png" alt="Econômico">'
      + '<span style="min-width:0"><b>Econômico</b><span>Relatórios BI</span></span></a>'
      + '<div class="dn-rows">';
    ITENS.forEach(function (it) {
      if (it.sec) { html += '<div class="dn-sec">' + it.sec + '</div>'; return; }
      var on = path === it.href ? ' on' : '';
      html += '<a class="dn-item' + on + '" href="' + it.href + '">' + icon(it.ic) + it.txt + '</a>';
    });
    html += '</div>'
      + '<div class="dn-foot">'
      + '<div class="dn-ava" id="dn-ava">–</div>'
      + '<div class="dn-user"><b id="dn-nome">…</b><a href="/api/logout">Sair da conta</a></div>'
      + '</div>';

    var aside = document.createElement('aside');
    aside.id = 'dsnav';
    aside.innerHTML = html;
    document.body.insertAdjacentElement('afterbegin', aside);
    document.body.classList.add('dsnav-pad');

    fetch('/api/me').then(function (r) { return r.json(); }).then(function (u) {
      if (u && u.nome) {
        document.getElementById('dn-nome').textContent = u.nome;
        var ini = u.nome.trim().split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase();
        document.getElementById('dn-ava').textContent = ini;
      }
    }).catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', montar);
  } else {
    montar();
  }
})();
