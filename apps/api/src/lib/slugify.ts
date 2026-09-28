/**
 * Convert a string into a URL-safe, lowercase slug.
 *
 * - Normalizes Unicode to NFKD and strips diacritical marks.
 * - Replaces non-alphanumeric characters with hyphens.
 * - Collapses consecutive hyphens and trims leading/trailing hyphens.
 * - Truncates to 24 characters.
 *
 * Exported as a shared utility so other modules (brand slugs, challenge slugs,
 * etc.) can reuse the same normalization logic without reimplementing it.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 24);
}
