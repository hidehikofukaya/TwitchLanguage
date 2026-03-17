-- TwitchLaunguage Database Schema
-- Run in Supabase SQL Editor

-- ============================================================
-- Enable UUID extension
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Users (managed by Supabase Auth, extended here)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Coin balances (source of truth for coins)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.coin_balances (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Coin transactions (audit log)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.coin_transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount          INTEGER NOT NULL,          -- positive=credit, negative=debit
  reason          TEXT NOT NULL,             -- 'registration', 'purchase', 'display'
  stripe_event_id TEXT UNIQUE,               -- idempotency key for Stripe webhooks
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_coin_transactions_user ON public.coin_transactions(user_id);
CREATE INDEX idx_coin_transactions_stripe ON public.coin_transactions(stripe_event_id) WHERE stripe_event_id IS NOT NULL;

-- ============================================================
-- Phrase cache (shared across users, keyed by lang-pair + phrase)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.phrase_cache (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cache_key       TEXT NOT NULL UNIQUE,      -- "{native_lang}-{target_lang}::{phrase}"
  phrase          TEXT NOT NULL,
  native_lang     TEXT NOT NULL,
  target_lang     TEXT NOT NULL,
  translation     TEXT NOT NULL,
  nuance          TEXT NOT NULL,
  example         TEXT NOT NULL,
  similar_phrases TEXT[],                    -- array of similar expressions
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days'
);

CREATE INDEX idx_phrase_cache_key ON public.phrase_cache(cache_key);
CREATE INDEX idx_phrase_cache_expires ON public.phrase_cache(expires_at);

-- ============================================================
-- Selection history (per-user phrase display count)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.selection_history (
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cache_key       TEXT NOT NULL,
  selection_count INTEGER NOT NULL DEFAULT 1,
  last_selected   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, cache_key)
);

CREATE INDEX idx_selection_history_user ON public.selection_history(user_id);

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coin_balances     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coin_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.selection_history ENABLE ROW LEVEL SECURITY;
-- phrase_cache is shared (no RLS needed, read-only for users)

-- profiles: users can read/update their own
CREATE POLICY "profiles_own" ON public.profiles
  FOR ALL USING (auth.uid() = id);

-- coin_balances: only service role can write; users can read own
CREATE POLICY "coin_balances_read_own" ON public.coin_balances
  FOR SELECT USING (auth.uid() = user_id);

-- coin_transactions: users can read own
CREATE POLICY "coin_transactions_read_own" ON public.coin_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- selection_history: users can read own
CREATE POLICY "selection_history_read_own" ON public.selection_history
  FOR SELECT USING (auth.uid() = user_id);

-- ============================================================
-- Functions
-- ============================================================

-- Atomically consume 1 coin. Returns new balance or -1 if insufficient.
CREATE OR REPLACE FUNCTION public.consume_coin(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_balance INTEGER;
BEGIN
  UPDATE public.coin_balances
  SET balance = balance - 1, updated_at = NOW()
  WHERE user_id = p_user_id AND balance >= 1
  RETURNING balance INTO v_new_balance;

  IF NOT FOUND THEN
    RETURN -1;
  END IF;

  INSERT INTO public.coin_transactions(user_id, amount, reason)
  VALUES (p_user_id, -1, 'display');

  RETURN v_new_balance;
END;
$$;

-- Add coins (called from Stripe webhook via service role)
CREATE OR REPLACE FUNCTION public.add_coins(
  p_user_id       UUID,
  p_amount        INTEGER,
  p_reason        TEXT,
  p_stripe_event  TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_balance INTEGER;
BEGIN
  -- Idempotency check for Stripe events
  IF p_stripe_event IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.coin_transactions WHERE stripe_event_id = p_stripe_event
    ) THEN
      SELECT balance INTO v_new_balance FROM public.coin_balances WHERE user_id = p_user_id;
      RETURN v_new_balance;
    END IF;
  END IF;

  INSERT INTO public.coin_balances(user_id, balance)
  VALUES (p_user_id, p_amount)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = coin_balances.balance + p_amount, updated_at = NOW()
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.coin_transactions(user_id, amount, reason, stripe_event_id)
  VALUES (p_user_id, p_amount, p_reason, p_stripe_event);

  RETURN v_new_balance;
END;
$$;

-- Upsert selection count for a phrase
CREATE OR REPLACE FUNCTION public.record_selection(
  p_user_id  UUID,
  p_key      TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.selection_history(user_id, cache_key, selection_count, last_selected)
  VALUES (p_user_id, p_key, 1, NOW())
  ON CONFLICT (user_id, cache_key) DO UPDATE
    SET selection_count = selection_history.selection_count + 1,
        last_selected   = NOW();
END;
$$;
