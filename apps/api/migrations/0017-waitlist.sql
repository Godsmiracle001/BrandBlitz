-- #483: Pre-launch waitlist table for email capture before full account creation.
-- Separate from waitlist_signups (position queue); this table is a simple opt-in store.
CREATE TABLE waitlist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  referral_code TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_waitlist_email ON waitlist (email);
