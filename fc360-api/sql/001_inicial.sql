-- FC360 API — schema inicial (banco `fc360` no Postgres do .254).
-- Tudo tem cliente_id: o banco é um só por instalação, mas cada linha pertence a um tenant.
-- `dados` guarda o documento inteiro exatamente como o app grava hoje no Firestore
-- (migração sem reescrever o app); as colunas soltas são só as que a gente filtra/indexa.

CREATE TABLE IF NOT EXISTS migracao (
  versao      int PRIMARY KEY,
  aplicada_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resultado (
  id             text PRIMARY KEY,
  cliente_id     text NOT NULL,
  loja           text NOT NULL DEFAULT '',
  operador       text NOT NULL DEFAULT '',
  user_id        text NOT NULL DEFAULT '',
  checklist_id   text NOT NULL DEFAULT '',
  checklist_nome text NOT NULL DEFAULT '',
  date_iso       date NOT NULL,
  data_hora      text,
  pct            int,
  resetado       boolean NOT NULL DEFAULT false,
  manual         boolean NOT NULL DEFAULT false,
  dados          jsonb NOT NULL,
  recebido_em    timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resultado_cliente_data ON resultado (cliente_id, date_iso);
CREATE INDEX IF NOT EXISTS resultado_cliente_loja_data ON resultado (cliente_id, loja, date_iso);

-- Fotos: o arquivo fica em disco (data/fotos/<cliente>/<data>/<id>.<ext>), aqui só metadados.
-- colecao = 'fotos' (foto avulsa do checklist em andamento) | 'resultados_fotos' (foto de um envio).
CREATE TABLE IF NOT EXISTS foto (
  id           text PRIMARY KEY,
  colecao      text NOT NULL,
  cliente_id   text NOT NULL,
  loja         text NOT NULL DEFAULT '',
  user_id      text NOT NULL DEFAULT '',
  date_iso     date,
  resultado_id text,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  arquivo      text NOT NULL,
  mime         text NOT NULL DEFAULT 'image/jpeg',
  bytes        int NOT NULL,
  recebido_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS foto_cliente_data ON foto (cliente_id, date_iso);
CREATE INDEX IF NOT EXISTS foto_resultado ON foto (resultado_id);
CREATE INDEX IF NOT EXISTS foto_cliente_user_data ON foto (cliente_id, user_id, date_iso);

-- Estado do checklist em andamento (1 por usuário por dia), igual ao doc `checkstates` do Firestore.
CREATE TABLE IF NOT EXISTS checkstate (
  id            text PRIMARY KEY,
  cliente_id    text NOT NULL,
  user_id       text NOT NULL,
  date_iso      date NOT NULL,
  state         jsonb NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkstate_cliente_data ON checkstate (cliente_id, date_iso);

-- Trilha de tudo que chegou (quem, quando, o quê). É o que o Firestore nunca mostrou.
CREATE TABLE IF NOT EXISTS envio_log (
  id          bigserial PRIMARY KEY,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  cliente_id  text NOT NULL,
  user_id     text NOT NULL DEFAULT '',
  loja        text NOT NULL DEFAULT '',
  tipo        text NOT NULL,
  ref_id      text NOT NULL DEFAULT '',
  bytes       int NOT NULL DEFAULT 0,
  ip          text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS envio_log_cliente_data ON envio_log (cliente_id, recebido_em);
