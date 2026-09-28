-- Notification center: stores per-user notification records for payout
-- receipts, badge awards, and streak milestones.

CREATE TYPE notification_type AS ENUM (
  'payout_received',
  'badge_earned',
  'streak_milestone'
);

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       notification_type NOT NULL,
  payload    JSONB            NOT NULL DEFAULT '{}',
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- Partial index for efficient unread-notification queries per user.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;
