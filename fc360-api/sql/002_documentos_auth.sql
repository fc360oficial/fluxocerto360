-- Fase 3: todas as outras coleções do Firestore numa tabela só (documento), e login próprio.
-- `dados` guarda o documento como o app grava; cliente_id é o tenant (dono) da linha.
-- Marcas d'água do servidor dentro do JSON: {"__ts": "<iso>"} no lugar do Timestamp.

CREATE TABLE IF NOT EXISTS documento (
  colecao       text NOT NULL,
  id            text NOT NULL,
  cliente_id    text NOT NULL DEFAULT '',
  dados         jsonb NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (colecao, id)
);
CREATE INDEX IF NOT EXISTS documento_cliente ON documento (colecao, cliente_id);
CREATE INDEX IF NOT EXISTS documento_dados ON documento USING gin (dados jsonb_path_ops);

-- Senha dos usuários (nunca dentro do documento, nunca sai pela API).
-- origem: 'bcrypt' (definida aqui) | 'firebase' (migrada no 1º login) | 'legado' (sha256 antigo).
CREATE TABLE IF NOT EXISTS credencial (
  usuario_id    text PRIMARY KEY,
  email         text NOT NULL,
  senha_hash    text NOT NULL,
  origem        text NOT NULL DEFAULT 'bcrypt',
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credencial_email ON credencial (lower(email));
