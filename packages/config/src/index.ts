const DISABLED_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "payment",
] as const;

/**
 * Permissions-Policy header value that disables camera, microphone,
 * geolocation, and payment APIs. Import this constant in both the API
 * (apps/api) and the web app (apps/web) so the feature list is defined
 * once and can be audited or extended in a single file.
 */
export const PERMISSIONS_POLICY_HEADER = DISABLED_PERMISSIONS.map(
  (f) => `${f}=()`
).join(", ");
