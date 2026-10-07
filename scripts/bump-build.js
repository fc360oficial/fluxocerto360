#!/usr/bin/env node
// Sobe o BUILD nos 4 arquivos de uma vez (único jeito certo de mudar versão).
//
//   node scripts/bump-build.js          -> BUILD atual + 1
//   node scripts/bump-build.js 425      -> BUILD = 425
//
// Arquivos tocados: app.js (var BUILD), version.json, index.html (app.js?v=),
// sw.js (CACHE_NAME e ./app.js?v=). Depois roda o check-build.js.
// Nunca edite esses números na mão — foi assim que o 419/420 ficou com o
// app.js preso em 418.

var fs = require('fs');
var path = require('path');
var execFileSync = require('child_process').execFileSync;
var raiz = path.resolve(__dirname, '..');

function arq(nome) { return path.join(raiz, nome); }

var atual = JSON.parse(fs.readFileSync(arq('version.json'), 'utf8')).build;
var novo = process.argv[2] ? String(parseInt(process.argv[2], 10)) : String(parseInt(atual, 10) + 1);
if (!/^\d+$/.test(novo) || parseInt(novo, 10) <= 0) {
  console.error('BUILD inválido: ' + process.argv[2]);
  process.exit(1);
}

function trocar(nome, regex, substituto, esperado) {
  var conteudo = fs.readFileSync(arq(nome), 'utf8');
  var n = 0;
  var saida = conteudo.replace(regex, function() { n++; return substituto; });
  if (n !== esperado) {
    console.error(nome + ': esperava ' + esperado + ' ocorrência(s) de ' + regex + ', achou ' + n + '. Nada foi gravado.');
    process.exit(1);
  }
  return saida;
}

// Prepara tudo antes de gravar qualquer coisa — ou grava os 4, ou nenhum.
var novos = {
  'app.js':       trocar('app.js',       /^var BUILD = '\d+';/m,                       "var BUILD = '" + novo + "';", 1),
  'version.json': '{"build":"' + novo + '"}\n',
  'index.html':   trocar('index.html',   /<script src="app\.js\?v=\d+"/,                '<script src="app.js?v=' + novo + '"', 1),
  'sw.js':        trocar('sw.js',        /^var CACHE_NAME = 'cahu360-v\d+';/m,          "var CACHE_NAME = 'cahu360-v" + novo + "';", 1)
};
novos['sw.js'] = novos['sw.js'].replace(/'\.\/app\.js\?v=\d+'/g, function(){ return "'./app.js?v=" + novo + "'"; });

Object.keys(novos).forEach(function(nome) {
  fs.writeFileSync(arq(nome), novos[nome]);
});

console.log('BUILD ' + atual + ' -> ' + novo + '\n');
execFileSync(process.execPath, [path.join(__dirname, 'check-build.js')], { stdio: 'inherit' });
