import { z } from "zod";

export interface CursorValue {
  values: Record<string, unknown>;
}

export function encodeCursor(values: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

export function decodeCursor(
  cursor: string,
  expectedKeys: string[],
): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid cursor format");
  }

  for (const key of expectedKeys) {
    if (!(key in parsed)) {
      throw new Error(`Cursor missing required key: ${key}`);
    }
  }

  return parsed;
}

export function decodeCursorSafe(
  cursor: string | undefined,
  expectedKeys: string[],
): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    return decodeCursor(cursor, expectedKeys);
  } catch {
    return null;
  }
}

export function buildCursorWhere(
  sortColumns: { column: string; direction: "ASC" | "DESC"; nulls?: "LAST" | "FIRST" }[],
  cursorValues: Record<string, unknown>,
  paramIndex: number,
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (let i = 0; i < sortColumns.length; i++) {
    const col = sortColumns[i];
    const value = cursorValues[col.column];
    const colRef = col.column;
    const dir = col.direction === "DESC" ? "<" : ">";
    const nulls = col.nulls === "LAST" ? "NULLS LAST" : col.nulls === "FIRST" ? "NULLS FIRST" : "";

    if (i === 0) {
      if (col.nulls === "LAST") {
        conditions.push(
          `(${colRef} IS NOT NULL AND (${colRef} ${dir} $${paramIndex} OR (${colRef} = $${paramIndex} AND id ${dir} $${paramIndex + 1})))`,
        );
      } else {
        conditions.push(
          `(${colRef} ${dir} $${paramIndex} OR (${colRef} = $${paramIndex} AND id ${dir} $${paramIndex + 1}))`,
        );
      }
      params.push(value, cursorValues.id);
      paramIndex += 2;
    }
  }

  const nullsPrefix = sortColumns[0]?.nulls === "LAST" ? `${sortColumns[0].column} IS NULL OR ` : "";
  const clause = conditions.length > 0
    ? `AND (${nullsPrefix}${conditions.join(" OR ")})`
    : "";

  return { clause, params };
}

export function buildCursorWhereSimple(
  column: string,
  direction: "ASC" | "DESC",
  cursorValue: unknown,
  idValue: string,
  paramIndex: number,
): { clause: string; params: unknown[] } {
  const dir = direction === "DESC" ? "<" : ">";
  const clause = `AND (${column} ${dir} $${paramIndex} OR (${column} = $${paramIndex} AND id ${dir} $${paramIndex + 1}))`;
  return { clause, params: [cursorValue, idValue] };
}

export const CursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
