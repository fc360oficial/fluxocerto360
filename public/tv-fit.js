// tv-fit.js — Auto-escala páginas para caber em TVs (overscan, resolução diferente)
(function() {
  function fit() {
    var b = document.body;
    var html = document.documentElement;
    b.style.zoom = '';
    void b.offsetHeight;

    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // Método 1: medir overflow com overflow temporariamente visível
    var bof = b.style.overflow;
    var hof = html.style.overflow;
    b.style.overflow = 'visible';
    html.style.overflow = 'visible';
    void b.offsetHeight;
    var cw = Math.max(b.scrollWidth, html.scrollWidth);
    var ch = Math.max(b.scrollHeight, html.scrollHeight);
    b.style.overflow = bof;
    html.style.overflow = hof;

    // Método 2: verificar bounding rect dos elementos principais
    var maxR = 0, maxB = 0;
    var sels = 'header,.hdr,main,.main,.kpi-row,.tbl-row,.grid,.grid-compradores,.charts-row,.ops-bar,.alert-bar,.mg-bar,.fixed-bar,.cols';
    var els = b.querySelectorAll(sels);
    for (var i = 0; i < els.length; i++) {
      var rect = els[i].getBoundingClientRect();
      if (rect.width < 1) continue;
      if (rect.right > maxR) maxR = rect.right;
      if (rect.bottom > maxB) maxB = rect.bottom;
    }

    // Usar o maior overflow detectado
    var overX = Math.max(cw - vw, maxR - vw);
    var overY = Math.max(ch - vh, maxB - vh);

    if (overX > 3 || overY > 3) {
      var totalW = Math.max(cw, maxR);
      var totalH = Math.max(ch, maxB);
      var rw = overX > 3 ? vw / totalW : 1;
      var rh = overY > 3 ? vh / totalH : 1;
      var ratio = Math.min(rw, rh) * 0.97;
      if (ratio < 0.99) {
        b.style.zoom = Math.max(0.45, ratio).toFixed(3);
      }
    }
  }

  if (document.readyState === 'complete') setTimeout(fit, 200);
  else window.addEventListener('load', function() { setTimeout(fit, 200); });
  window.addEventListener('resize', function() { setTimeout(fit, 100); });
  setTimeout(fit, 1500);
  setTimeout(fit, 3000);
  setTimeout(fit, 6000);
  setTimeout(fit, 10000);
})();
