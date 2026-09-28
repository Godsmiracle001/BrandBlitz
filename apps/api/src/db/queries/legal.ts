import { query } from "../index";

export interface LegalDocument {
  id: string;
  version: string;
  type: "tos" | "privacy";
  body_markdown: string;
  effective_at: string;
  created_at: string;
}

export interface UserLegalAcceptance {
  id: string;
  user_id: string;
  type: "tos" | "privacy";
  version: string;
  accepted_at: string;
  ip: string;
}

export async function getCurrentLegalDocument(type: "tos" | "privacy"): Promise<LegalDocument | null> {
  const result = await query<LegalDocument>(
    `SELECT * FROM legal_documents
     WHERE type = $1 AND effective_at <= NOW()
     ORDER BY effective_at DESC
     LIMIT 1`,
    [type]
  );
  return result.rows[0] ?? null;
}

export async function getLegalDocumentByVersion(type: "tos" | "privacy", version: string): Promise<LegalDocument | null> {
  const result = await query<LegalDocument>(
    "SELECT * FROM legal_documents WHERE type = $1 AND version = $2",
    [type, version]
  );
  return result.rows[0] ?? null;
}

export async function findUserLegalAcceptance(
  userId: string,
  type: "tos" | "privacy",
  version: string
): Promise<UserLegalAcceptance | null> {
  const result = await query<UserLegalAcceptance>(
    "SELECT * FROM user_legal_acceptances WHERE user_id = $1 AND type = $2 AND version = $3",
    [userId, type, version]
  );
  return result.rows[0] ?? null;
}

export async function recordUserLegalAcceptance(
  userId: string,
  type: "tos" | "privacy",
  version: string,
  ip: string
): Promise<UserLegalAcceptance> {
  const result = await query<UserLegalAcceptance>(
    `INSERT INTO user_legal_acceptances (user_id, type, version, ip)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, type, version) DO NOTHING
     RETURNING *`,
    [userId, type, version, ip]
  );

  const acceptance = result.rows[0];
  // Only log a fresh acceptance — a conflicting (already-accepted) replay
  // returns no row here and should not create a duplicate audit entry.
  if (acceptance) {
    await query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
       VALUES ($1, 'accept', 'user_legal_acceptances', $2, $3)`,
      [userId, `${type}:${version}`, acceptance]
    );
  }

  return acceptance;
}

export async function hasAcceptedLatestVersion(userId: string, type: "tos" | "privacy"): Promise<boolean> {
  const doc = await getCurrentLegalDocument(type);
  if (!doc) return true;
  const acceptance = await findUserLegalAcceptance(userId, type, doc.version);
  return acceptance !== null;
}

export async function getAcceptedVersions(userId: string, type: "tos" | "privacy"): Promise<string[]> {
  const result = await query<{ version: string }>(
    "SELECT version FROM user_legal_acceptances WHERE user_id = $1 AND type = $2 ORDER BY accepted_at DESC",
    [userId, type]
  );
  return result.rows.map((r) => r.version);
}
