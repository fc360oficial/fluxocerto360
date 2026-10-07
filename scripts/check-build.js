#!/usr/bin/env node
// Verifica se o número de BUILD está igual nos 4 lugares que o app usa.
// Sai com código 1 (e explica) se algum estiver diferente.
//
//   node scripts/check-build.js
//
// Roda no pre-commit (.githooks), no GitHub Actions do base (check-build.yml)
// e dentro do deploy de cada cliente (deploy.yml) — um base inconsistente
// nunca chega a um cliente.
//
// Por que existe: nos BUILDs 419 e 420 o version.json/index.html/sw.js subiram
// mas o `var BUILD` do app.js ficou em 418. Painel de Clientes dizia v420 e o
// app, no menu do usuário, dizia v418.

var fs = require('fs');
var path = require('path');
var raiz = path.resolve(__dirname, '..');

function ler(nome) { return fs.readFileSync(path.join(raiz, nome), 'utf8'); }
function pega(nome, regex) {
  var m = ler(nome).match(regex);
  return m ? m[1] : null;
}

var builds = {
  'version.json  {"build":"N"}':   pega('version.json', /"build"\s*:\s*"(\d+)"/),
  'app.js        var BUILD = N':   pega('app.js', /^var BUILD = '(\d+)';/m),
  'index.html    app.js?v=N':      pega('index.html', /<script src="app\.js\?v=(\d+)"/),
  'sw.js         CACHE_NAME vN':   pega('sw.js', /^var CACHE_NAME = 'cahu360-v(\d+)';/m),
  'sw.js         ./app.js?v=N':    pega('sw.js', /'\.\/app\.js\?v=(\d+)'/)
};

var valores = Object.keys(builds).map(function(k){ return builds[k]; });
var distintos = valores.filter(function(v, i){ return valores.indexOf(v) === i; });
var ok = distintos.length === 1 && distintos[0] !== null;

Object.keys(builds).forEach(function(k) {
  console.log((ok ? '  ' : (builds[k] === distintos[0] ? '  ' : '!! ')) + k.padEnd(32) + (builds[k] || 'NAO ENCONTRADO'));
});

if (!ok) {
  console.error('\nBUILD INCONSISTENTE: ' + distintos.join(' / ') + '. Use `node scripts/bump-build.js` para alinhar os 4 arquivos.');
  process.exit(1);
}
console.log('\nBUILD ' + distintos[0] + ' consistente nos 4 arquivos.');
