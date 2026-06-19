CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_ciphertext TEXT,
  provider_type TEXT NOT NULL DEFAULT 'openai_compatible',
  default_model TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_global BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT providers_name_per_user UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS providers_user_id_idx ON providers(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS providers_one_default_per_user_idx ON providers(user_id) WHERE is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS providers_global_name_idx ON providers(name) WHERE is_global = true;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES providers(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '新对话',
  system_prompt TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS conversations_user_id_updated_at_idx ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  token_count INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_at_idx ON messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS messages_user_id_idx ON messages(user_id);

CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settings_key_per_user UNIQUE (user_id, key)
);

CREATE INDEX IF NOT EXISTS settings_user_id_idx ON settings(user_id);

-- Backward-compatible migrations for existing installs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE providers ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT false;
UPDATE providers SET is_global = true WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS providers_global_name_idx ON providers(name) WHERE is_global = true;

-- Skills (管理员创建的技能/提示词模板)
CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  system_prompt TEXT NOT NULL,
  icon TEXT DEFAULT '🤖',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skills_sort_idx ON skills(sort_order ASC, created_at ASC);
