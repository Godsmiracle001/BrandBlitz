-- BrandBlitz Database Schema
-- PostgreSQL 17

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL UNIQUE,
  google_id         TEXT UNIQUE,
  display_name      TEXT NOT NULL,
  username          TEXT UNIQUE,
  avatar_url        TEXT,
  age_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  kyc_complete      BOOLEAN NOT NULL DEFAULT FALSE,
  stellar_address   TEXT,
  embedded_wallet_address TEXT,
  referral_code     TEXT UNIQUE,
  phone_hash        TEXT UNIQUE,
  phone_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified_at TIMESTAMPTZ,
  league            TEXT CHECK (league IN ('bronze', 'silver', 'gold')),
  total_score       BIGINT NOT NULL DEFAULT 0,
  total_earned_usdc NUMERIC(20, 7) NOT NULL DEFAULT 0,
  challenges_played INTEGER NOT NULL DEFAULT 0,
  state_code        TEXT,
  streak            INTEGER NOT NULL DEFAULT 0,
  last_play_day     DATE,
  streak_repairs_this_month INTEGER NOT NULL DEFAULT 0,
  streak_repair_available BOOLEAN NOT NULL DEFAULT FALSE,
  role              TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'brand', 'admin')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  suspension_reason TEXT,
  suspended_at      TIMESTAMPTZ,
  suspended_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email        ON users (email);
CREATE INDEX idx_users_google_id    ON users (google_id);
CREATE INDEX idx_users_phone_hash   ON users (phone_hash);
CREATE INDEX idx_users_total_score  ON users (total_score DESC);
CREATE INDEX idx_users_league       ON users (league);
CREATE INDEX idx_users_status       ON users (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- BRANDS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE brands (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  tagline             TEXT,
  brand_story         TEXT,
  usp                 TEXT,
  logo_url            TEXT,
  product_image_keys  TEXT[] NOT NULL DEFAULT '{}',
  primary_color       TEXT DEFAULT '#6366f1',
  secondary_color     TEXT DEFAULT '#a5b4fc',
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_brands_owner_user_id ON brands (owner_user_id);
CREATE INDEX idx_brands_deleted_at    ON brands (deleted_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- CHALLENGES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE challenges (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  challenge_id        TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'pending_deposit'
                        CHECK (status IN ('pending_deposit', 'active', 'ended', 'settled', 'payout_failed', 'cancelled', 'refunded')),
  pool_amount_stroops BIGINT NOT NULL DEFAULT 0,
  stellar_deposit_tx  TEXT,
  deposit_address     TEXT,
  deposit_memo        TEXT UNIQUE,
  deposit_tx_hash     TEXT UNIQUE,
  max_players         INTEGER,
  participant_count   INTEGER NOT NULL DEFAULT 0,
  starts_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at             TIMESTAMPTZ,
  payout_tx_hashes    TEXT[],
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT challenges_ends_after_starts CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT challenges_pool_amount_positive CHECK (
    status IN ('pending_deposit', 'cancelled', 'refunded') OR pool_amount_stroops > 0
  )
);

CREATE INDEX idx_challenges_brand_id        ON challenges (brand_id);
CREATE INDEX idx_challenges_status          ON challenges (status);
CREATE INDEX idx_challenges_active_status   ON challenges (status) WHERE status = 'active';
CREATE INDEX idx_challenges_ends_at         ON challenges (ends_at);
CREATE INDEX idx_challenges_challenge_id    ON challenges (challenge_id);
CREATE INDEX idx_challenges_deposit_memo    ON challenges (deposit_memo);

-- ─────────────────────────────────────────────────────────────────────────────
-- CHALLENGE QUESTIONS (3 per challenge, server-side only)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE challenge_questions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id     UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  round            INTEGER NOT NULL CHECK (round IN (1, 2, 3)),
  question_type    TEXT NOT NULL CHECK (question_type IN ('which_brand', 'which_tagline', 'which_product')),
  prompt_type      TEXT NOT NULL CHECK (prompt_type IN ('logo', 'productImage1', 'tagline')),
  question_text    TEXT NOT NULL,
  correct_answer   TEXT NOT NULL,
  option_a         TEXT NOT NULL,
  option_b         TEXT NOT NULL,
  option_c         TEXT NOT NULL,
  option_d         TEXT NOT NULL,
  correct_option   CHAR(1) NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (challenge_id, round)
);

CREATE INDEX idx_challenge_questions_challenge ON challenge_questions (challenge_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- GAME SESSIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE game_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  challenge_id          UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  device_id             TEXT,
  ip_address            INET,
  status                TEXT NOT NULL DEFAULT 'warmup'
                          CHECK (status IN ('warmup', 'active', 'completed', 'flagged', 'abandoned')),
  is_practice           BOOLEAN NOT NULL DEFAULT FALSE,
  warmup_started_at     TIMESTAMPTZ,
  warmup_completed_at   TIMESTAMPTZ,
  challenge_started_at  TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  round_1_answer        CHAR(1) CHECK (round_1_answer IN ('A', 'B', 'C', 'D')),
  round_1_score         INTEGER NOT NULL DEFAULT 0,
  round_1_reaction_ms   INTEGER,
  round_2_answer        CHAR(1) CHECK (round_2_answer IN ('A', 'B', 'C', 'D')),
  round_2_score         INTEGER NOT NULL DEFAULT 0,
  round_2_reaction_ms   INTEGER,
  round_3_answer        CHAR(1) CHECK (round_3_answer IN ('A', 'B', 'C', 'D')),
  round_3_score         INTEGER NOT NULL DEFAULT 0,
  round_3_reaction_ms   INTEGER,
  total_score           INTEGER NOT NULL DEFAULT 0,
  rank                  INTEGER,
  flagged               BOOLEAN NOT NULL DEFAULT FALSE,
  flag_reasons          TEXT[]  NOT NULL DEFAULT '{}',
  fraud_flags           TEXT[]  NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, challenge_id),
  CONSTRAINT game_sessions_score_range CHECK (total_score >= 0 AND total_score <= 450)
);

CREATE INDEX idx_game_sessions_challenge_id ON game_sessions (challenge_id);
CREATE INDEX idx_game_sessions_user_id      ON game_sessions (user_id);
CREATE INDEX idx_game_sessions_user_id_completed_at ON game_sessions (user_id, completed_at DESC);
CREATE INDEX idx_game_sessions_status       ON game_sessions (status);
CREATE INDEX idx_game_sessions_total_score  ON game_sessions (challenge_id, total_score DESC NULLS LAST)
  WHERE status = 'completed';

CREATE TABLE session_round_scores (
  session_id       UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  round            INTEGER NOT NULL CHECK (round IN (1, 2, 3)),
  answer           TEXT,
  score            INTEGER NOT NULL CHECK (score >= 0),
  reaction_time_ms INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, round)
);

CREATE INDEX idx_round_scores_session ON session_round_scores (session_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- PAYOUTS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE payouts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id     UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id       UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  amount_stroops   BIGINT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  tx_hash          TEXT,
  error_message    TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (challenge_id, user_id),
  CONSTRAINT payouts_failed_requires_message
    CHECK ((status = 'failed') = (LENGTH(error_message) > 0)),
  CONSTRAINT payouts_amount_positive CHECK (amount_stroops > 0)
);

CREATE INDEX idx_payouts_challenge_id ON payouts (challenge_id);
CREATE INDEX idx_payouts_user_id      ON payouts (user_id);
CREATE INDEX idx_payouts_status       ON payouts (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT LOG (append-only; records admin config changes)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_key TEXT,
  before     JSONB,
  after      JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_actor_id   ON audit_log (actor_id);
CREATE INDEX idx_audit_log_entity     ON audit_log (entity, entity_key);
CREATE INDEX idx_audit_log_created_at ON audit_log (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- REFUNDS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE refunds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id     UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE UNIQUE,
  admin_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  reason           TEXT NOT NULL,
  amount_stroops   BIGINT NOT NULL CHECK (amount_stroops > 0),
  destination      TEXT NOT NULL,
  tx_hash          TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refunds_admin_id ON refunds (admin_id);
CREATE INDEX idx_refunds_tx_hash  ON refunds (tx_hash);

-- ─────────────────────────────────────────────────────────────────────────────
-- FRAUD FLAGS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE fraud_flags (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  flag_type    TEXT NOT NULL,
  details      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, flag_type)
);

CREATE INDEX idx_fraud_flags_user_id    ON fraud_flags (user_id);
CREATE INDEX idx_fraud_flags_session_id ON fraud_flags (session_id);
CREATE INDEX idx_fraud_flags_created_at ON fraud_flags (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- LEAGUE ASSIGNMENTS (recalculated weekly)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE league_assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league       TEXT NOT NULL CHECK (league IN ('bronze', 'silver', 'gold')),
  group_id     INTEGER NOT NULL,
  week_start   DATE NOT NULL,
  weekly_points BIGINT NOT NULL DEFAULT 0,
  rank_in_group INTEGER,
  promoted    BOOLEAN NOT NULL DEFAULT FALSE,
  demoted     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, week_start)
);

CREATE INDEX idx_league_assignments_week        ON league_assignments (week_start, league, group_id, weekly_points DESC);
CREATE INDEX idx_league_assignments_week_league ON league_assignments (week_start, league);

-- ─────────────────────────────────────────────────────────────────────────────
-- USER BADGES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE user_badges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_slug  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  awarded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, badge_slug)
);

CREATE INDEX idx_user_badges_user_id ON user_badges (user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- REFERRALS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE referrals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  rewarded     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_referrals_referrer_id ON referrals (referrer_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- REFERRAL PAYOUTS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE referral_payouts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id              UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE UNIQUE,
  challenge_id             UUID REFERENCES challenges(id) ON DELETE CASCADE,
  referrer_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referrer_stellar_address TEXT,
  referred_stellar_address TEXT,
  referrer_amount_stroops  BIGINT NOT NULL DEFAULT 0,
  referred_amount_stroops  BIGINT NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'sent', 'failed')),
  tx_hash                  TEXT,
  error_message            TEXT NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT referral_payouts_failed_requires_message
    CHECK ((status = 'failed') = (LENGTH(error_message) > 0)),
  CONSTRAINT referral_payouts_amounts_positive CHECK (
    referrer_amount_stroops > 0 AND referred_amount_stroops > 0
  )
);

CREATE INDEX idx_referral_payouts_referrer_id ON referral_payouts (referrer_id);
CREATE INDEX idx_referral_payouts_referred_id ON referral_payouts (referred_id);
CREATE INDEX idx_referral_payouts_status ON referral_payouts (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATED_AT trigger helper
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at           BEFORE UPDATE ON users             FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER brands_updated_at          BEFORE UPDATE ON brands            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER challenges_updated_at      BEFORE UPDATE ON challenges        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payouts_updated_at         BEFORE UPDATE ON payouts           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER refunds_updated_at         BEFORE UPDATE ON refunds           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER challenge_questions_updated_at BEFORE UPDATE ON challenge_questions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER game_sessions_updated_at   BEFORE UPDATE ON game_sessions    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER fraud_flags_updated_at     BEFORE UPDATE ON fraud_flags      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER league_assignments_updated_at BEFORE UPDATE ON league_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_badges_updated_at     BEFORE UPDATE ON user_badges      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER referrals_updated_at       BEFORE UPDATE ON referrals       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER referral_payouts_updated_at BEFORE UPDATE ON referral_payouts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- APP CONFIG (runtime-tunable key/value store)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER app_config_updated_at BEFORE UPDATE ON app_config FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO app_config (key, value) VALUES
  ('anti_cheat.thresholds', '{"min_human_reaction_ms": 150, "max_human_reaction_ms": 30000}');

-- ─────────────────────────────────────────────────────────────────────────────
-- GDPR ERASURE REQUESTS (tracks 30-day grace period before anonymisation)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE gdpr_erasure_requests (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execute_at   TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  executed_at  TIMESTAMPTZ,
  admin_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gdpr_erasure_user_id ON gdpr_erasure_requests (user_id);

CREATE TRIGGER gdpr_erasure_requests_updated_at
  BEFORE UPDATE ON gdpr_erasure_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- CHALLENGE REPORTS (user-submitted content flags)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE challenge_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL CHECK (reason IN ('misleading_content', 'inappropriate_language', 'factually_incorrect', 'other')),
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (challenge_id, user_id)
);

CREATE INDEX idx_challenge_reports_challenge_id ON challenge_reports (challenge_id);
CREATE INDEX idx_challenge_reports_user_id      ON challenge_reports (user_id);
CREATE INDEX idx_challenge_reports_status       ON challenge_reports (status);

CREATE TRIGGER challenge_reports_updated_at BEFORE UPDATE ON challenge_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- WAITLIST SIGNUPS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE waitlist_signups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL UNIQUE,
  email_hash   TEXT NOT NULL,
  position     SERIAL NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_waitlist_signups_email ON waitlist_signups (email);
CREATE INDEX idx_waitlist_signups_email_hash ON waitlist_signups (email_hash);