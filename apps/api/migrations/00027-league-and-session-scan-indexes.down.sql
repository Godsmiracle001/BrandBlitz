-- Roll back the indexes introduced in 00027-league-and-session-scan-indexes.sql.

DROP INDEX IF EXISTS idx_game_sessions_open_last_activity;
DROP INDEX IF EXISTS idx_game_sessions_completed_window;
