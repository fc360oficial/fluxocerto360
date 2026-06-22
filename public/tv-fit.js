// tv-fit.js — Auto-escala páginas para caber em TVs (overscan, resolução diferente)
(function() {
  function fit() {
    var b = document.body;
    var html = document.documentElement;
    b.style.zoom = '';
    void b.offsetHeight;

    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // Salvar overflow original e liberar para medir conteúdo real
    var bof = b.style.overflow;
    var hof = html.style.overflow;
    var bofx = b.style.overflowX;
    var bofy = b.style.overflowY;
    b.style.overflow = 'visible';
    html.style.overflow = 'visible';
    void b.offsetHeight;

    // Medir conteúdo real sem clipping
    var cw = Math.max(b.scrollWidth, html.scrollWidth);
    var ch = Math.max(b.scrollHeight, html.scrollHeight);

    // Restaurar overflow
    b.style.overflow = bof;
    html.style.overflow = hof;
    b.style.overflowX = bofx;
    b.style.overflowY = bofy;

    var overX = cw - vw;
    var overY = ch - vh;

    if (overX > 5 || overY > 5) {
      var rw = overX > 5 ? vw / cw : 1;
      var rh = overY > 5 ? vh / ch : 1;
      var ratio = Math.min(rw, rh) * 0.97; // 3% margem segurança (overscan TV)
      if (ratio < 0.98) {
        b.style.zoom = Math.max(0.45, ratio).toFixed(3);
      }
    }
  }

  if (document.readyState === 'complete') setTimeout(fit, 200);
  else window.addEventListener('load', function() { setTimeout(fit, 200); });
  window.addEventListener('resize', function() { setTimeout(fit, 100); });
  // Re-verificar após dados assíncronos
  setTimeout(fit, 1500);
  setTimeout(fit, 3000);
  setTimeout(fit, 6000);
  setTimeout(fit, 10000);
})();
