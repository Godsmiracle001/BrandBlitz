import { query } from "../index";

/**
 * Keys that are safe to expose to unauthenticated clients via GET /config.
 * Anything not listed here (e.g. admin-only anti_cheat/payout/escrow config)
 * is never returned by getPublicConfig, regardless of what's in app_config.
 */
export const PUBLIC_CONFIG_KEYS = [
  "game_round_duration_seconds",
  "max_rounds_per_session",
  "maintenance_mode",
] as const;

export type PublicConfigKey = (typeof PUBLIC_CONFIG_KEYS)[number];
export type PublicConfig = Partial<Record<PublicConfigKey, unknown>>;

export async function getPublicConfig(): Promise<PublicConfig> {
  const result = await query<{ key: string; value: unknown }>(
    "SELECT key, value FROM app_config WHERE key = ANY($1::text[])",
    [PUBLIC_CONFIG_KEYS]
  );

  const config: PublicConfig = {};
  for (const row of result.rows) {
    config[row.key as PublicConfigKey] = row.value;
  }
  return config;
}

export interface AppConfigRow {
  key: string;
  value: Record<string, unknown>;
  updated_at: string;
  updated_by: string | null;
}

export async function getConfig(key: string): Promise<Record<string, unknown> | null> {
  const result = await query<{ value: Record<string, unknown> }>(
    "SELECT value FROM app_config WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value ?? null;
}

export async function getConfigRow(key: string): Promise<AppConfigRow | null> {
  const result = await query<AppConfigRow>(
    "SELECT key, value, updated_at, updated_by FROM app_config WHERE key = $1",
    [key]
  );
  return result.rows[0] ?? null;
}

export async function setConfig(
  key: string,
  value: Record<string, unknown>,
  actorId: string
): Promise<void> {
  const existing = await query<{ value: Record<string, unknown> }>(
    "SELECT value FROM app_config WHERE key = $1",
    [key]
  );

  await query(
    `INSERT INTO app_config (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = $3`,
    [key, JSON.stringify(value), actorId]
  );

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, before, after)
     VALUES ($1, 'update', 'app_config', $2, $3, $4)`,
    [actorId, key, existing.rows[0]?.value ?? null, value]
  );
}
