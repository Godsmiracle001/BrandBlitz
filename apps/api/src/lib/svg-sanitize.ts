const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const ENTITY_RE = /[&<>"']/g;

/**
 * Escape text for safe interpolation into an SVG text node.
 * Converts the five XML special characters into their entity equivalents
 * so they are rendered as visible characters, not parsed as markup.
 */
export function sanitizeSvgText(input: string): string {
  return input.replace(ENTITY_RE, (ch) => XML_ENTITIES[ch] ?? ch);
}
