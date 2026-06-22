// tv-fit.js — Auto-escala páginas para caber em TVs de qualquer tamanho
(function() {
  function fit() {
    var b = document.body;
    b.style.zoom = '';
    void b.offsetHeight;

    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var maxOW = 0, maxOH = 0;

    // Verificar containers com overflow cortado
    var els = b.querySelectorAll('main, header, .cols, .grid, .grid-compradores, .main, .kpi-row, .charts-row, .loja-cards, [class*="col"], [class*="panel"], table, .grupos-wrap, .scroll-wrap');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.clientWidth) continue;
      var ow = el.scrollWidth - el.clientWidth;
      var oh = el.scrollHeight - el.clientHeight;
      if (ow > maxOW) maxOW = ow;
      if (oh > maxOH) maxOH = oh;
    }

    // Também verificar se html/body tem scroll
    var htmlOW = document.documentElement.scrollWidth - vw;
    var htmlOH = document.documentElement.scrollHeight - vh;
    if (htmlOW > maxOW) maxOW = htmlOW;
    if (htmlOH > maxOH) maxOH = htmlOH;

    if (maxOW > 5 || maxOH > 5) {
      var rw = maxOW > 5 ? vw / (vw + maxOW) : 1;
      var rh = maxOH > 5 ? vh / (vh + maxOH) : 1;
      var ratio = Math.min(rw, rh);
      // Aplicar com margem extra de 2% para segurança
      ratio = ratio * 0.98;
      if (ratio < 0.98) {
        b.style.zoom = Math.max(0.5, ratio).toFixed(3);
      }
    }
  }

  // Executar após carregar e após dados assíncronos
  if (document.readyState === 'complete') setTimeout(fit, 300);
  else window.addEventListener('load', function() { setTimeout(fit, 300); });
  window.addEventListener('resize', fit);
  // Re-verificar após dados assíncronos carregarem
  setTimeout(fit, 2000);
  setTimeout(fit, 5000);
})();
