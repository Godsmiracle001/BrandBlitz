# ADR 010: Isolate SVG sanitization behind a package boundary

## Status

Proposed

## Context

`apps/api/src/lib/svg-sanitize.ts` exports `sanitizeSvgText`, a
narrow XML-entity escaper (`& < > " '`) used to make untrusted text
safe to interpolate into a server-generated SVG text node. Its only
current call site is `apps/api/src/routes/brands.ts`, where it
escapes a brand's `name` and `tagline` before they're embedded into
a generated SVG (not, as originally assumed, inside the upload
route — `apps/api/src/routes/upload.ts` does not import it and has
no SVG-specific handling at all today).

Because the helper lives as a plain, unenforced import, any future
route that builds SVG output (including a real uploaded-SVG-file
path, if one is added) could interpolate untrusted input without
going through this function, with no review-time signal that
something sanitization-shaped was skipped.

## Decision

Treat `svg-sanitize.ts` as the single audited chokepoint for
interpolating untrusted text into server-generated SVG, and gate it
behind an explicit boundary rather than a plain lib import:

- Move it to its own internal package (e.g. `packages/svg-sanitize`)
  with its own `package.json`, test suite, and changelog, so changes
  to it are reviewable independently of whatever route imports it.
- Document the threat model explicitly: this function defends against
  **XML/markup injection via text-node interpolation** (an attacker
  supplying `</text><script>...` as a brand name, for example). It
  does **not** cover a fundamentally different threat — sanitizing an
  arbitrary user-*uploaded* SVG file (external entity refs, embedded
  `<script>`, `xlink:href` exfiltration) — because no such upload
  path exists yet.
- If/when an actual SVG-file-upload feature is added, it needs a
  separate allow-list-based file sanitizer (e.g. strip all elements
  outside a known-safe tag allow-list), not this text-escaper, and
  that sanitizer should live in the same package under a distinctly
  named export so the two threat models are never conflated.

## Rationale

Keeping this as an internal package with its own tests makes "did
this PR touch sanitization logic" a visible, independently-reviewable
diff instead of a one-line change buried inside a route file.
Documenting the threat model up front prevents the common mistake of
assuming a text-escaper also makes it safe to accept arbitrary
uploaded SVG files.

## Consequences

- Call sites that must migrate to the new package import path:
  `apps/api/src/routes/brands.ts` (current sole caller).
- No behavior change for existing callers — this is a packaging and
  documentation change, not a rewrite of the escaping logic itself.
- Before any uploaded-SVG-file feature ships, it must add the
  separate file-sanitizer described above rather than reusing
  `sanitizeSvgText` for a threat model it wasn't designed for.
