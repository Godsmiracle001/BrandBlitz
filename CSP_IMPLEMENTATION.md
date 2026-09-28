# Content-Security-Policy (CSP) Implementation

## Overview

Implemented strict nonce-based CSP to prevent XSS attacks via brand descriptions and usernames. CSP is fully enforced in production via `apps/web/src/middleware.ts` (using the `Content-Security-Policy` header). An initial 7-day Report-Only phase was previously conducted to collect violation metrics prior to switching to full enforcement.

## Changes Made

### 1. **Next.js Middleware** (`apps/web/src/middleware.ts`)

- Generates cryptographically secure nonce per request using `crypto.randomBytes(16)`
- Injects nonce into response headers (`x-nonce`)
- Builds CSP header with environment-aware CDN and API hosts
- Sets `Content-Security-Policy` header (enforcement mode)
- Maintains existing referral code functionality

**Key Features:**

- Nonce-based script allowlisting: `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
- Reads `NEXT_PUBLIC_CDN_HOST` and `NEXT_PUBLIC_API_URL` from environment
- Fallback values for local development

### 2. **CSP Utility** (`apps/web/src/lib/csp.ts`)

- `getCspNonce()` function to retrieve nonce from request headers
- Used in Server Components to inject nonce into inline scripts

### 3. **Root Layout Update** (`apps/web/src/app/layout.tsx`)

- Imports `getCspNonce()` utility
- Passes nonce to theme initialization script via `nonce` prop
- Ensures inline scripts comply with CSP

### 4. **CSP Report Endpoint** (`apps/api/src/routes/csp-report.ts`)

- POST `/api/csp-report` endpoint
- Receives browser CSP violation reports
- Logs violations with full context:
  - Document URI
  - Violated directive
  - Blocked URI
  - Source file and line number
  - Status code
- Ready for integration with monitoring services (Sentry, DataDog, etc.)

### 5. **API Route Registration** (`apps/api/src/routes/index.ts`)

- Registered CSP report route at `/csp-report`
- Mounted early to avoid shadowing

### 6. **Nginx Configuration** (`nginx/templates/nginx.prod.conf.template`)

- Added CSP header with strict allowlist:
  ```
  default-src 'self'
  script-src 'self' 'nonce-$cspNonce' 'strict-dynamic'
  img-src 'self' data: https://${CDN_HOST}
  font-src 'self' https://fonts.gstatic.com
  style-src 'self' https://fonts.googleapis.com 'unsafe-inline'
  connect-src 'self' https://${API_HOST}
  frame-ancestors 'none'
  report-uri /api/csp-report
  ```
- Uses environment variables: `${CDN_HOST}`, `${API_HOST}`

### 7. **Environment Variables** (`.env.example`)

- Added `NEXT_PUBLIC_CDN_HOST=assets.brandblitz.app`
- Used by middleware to build CSP header

## CSP Policy Breakdown

| Directive         | Value                                                 | Purpose                                                                     |
| ----------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `default-src`     | `'self'`                                              | Deny all by default, allow same-origin                                      |
| `script-src`      | `'self' 'nonce-$cspNonce' 'strict-dynamic'`           | Only self, nonce-based inline scripts, and dynamic imports (XSS protection) |
| `img-src`         | `'self' data: https://${CDN_HOST}`                    | Self, data URIs, and CDN                                                    |
| `font-src`        | `'self' https://fonts.gstatic.com`                    | Self and Google Fonts                                                       |
| `style-src`       | `'self' https://fonts.googleapis.com 'unsafe-inline'` | Self, Google Fonts, inline styles (Tailwind)                                |
| `connect-src`     | `'self' https://${API_HOST}`                          | API calls to same-origin or API host                                        |
| `frame-ancestors` | `'none'`                                              | Prevent clickjacking                                                        |
| `report-uri`      | `/api/csp-report`                                     | Violation reporting endpoint                                                |

## Deployment Timeline & Status

### Phase 1: Report-Only (Completed)

- Initial rollout used `Content-Security-Policy-Report-Only` header to collect violation reports and identify false positives.

### Phase 2: Full Enforcement (Active)

- CSP is enforced as of the current codebase (`apps/web/src/middleware.ts`).
- Header name: `Content-Security-Policy` (enforcing violations are blocked by browsers).
- Automated E2E test coverage in `e2e/tests/csp-nonce.spec.ts` verifies that responses return the enforcing `Content-Security-Policy` header with nonces and strict-dynamic enabled.

> [!NOTE]
> **Process Note for Future Policy Updates:**
> Whenever CSP directives in `apps/web/src/middleware.ts` or Nginx templates are updated, immediately update the CSP Policy Breakdown table in this document to prevent documentation drift.

## Testing CSP

### Automated End-to-End Tests

E2E test `e2e/tests/csp-nonce.spec.ts` asserts that the enforcing `Content-Security-Policy` header is present, contains valid nonces, and correctly includes `'strict-dynamic'`.

### Local Development

1. Set environment variables:

   ```bash
   NEXT_PUBLIC_CDN_HOST=localhost:9000
   NEXT_PUBLIC_API_URL=http://localhost:3001/api
   ```

2. Test nonce injection:

   ```bash
   curl -i http://localhost:3000
   # Look for x-nonce and Content-Security-Policy headers in response
   ```

3. Test CSP report endpoint:
   ```bash
   curl -X POST http://localhost:3001/api/csp-report \
     -H "Content-Type: application/json" \
     -d '{"csp-report":{"document-uri":"http://localhost:3000","violated-directive":"script-src"}}'
   ```

### Production Monitoring

1. Check nginx logs for CSP headers
2. Monitor `/api/csp-report` endpoint for violations
3. Set up alerts for script-src violations (potential XSS attempts)

## Security Benefits

✅ **XSS Prevention**: Inline scripts require matching nonce, preventing injected scripts  
✅ **Clickjacking Protection**: `frame-ancestors 'none'` prevents embedding  
✅ **Data Exfiltration Prevention**: `connect-src` limits API calls  
✅ **Violation Monitoring**: Report endpoint enables security incident detection  
✅ **Enforced Policy**: CSP actively blocks unauthorized scripts in production

## Files Modified

- ✅ `apps/web/src/middleware.ts` — Nonce generation and enforcing CSP header injection
- ✅ `apps/web/src/lib/csp.ts` — Nonce retrieval utility
- ✅ `apps/web/src/app/layout.tsx` — Nonce injection into theme script
- ✅ `apps/api/src/routes/csp-report.ts` — Violation reporting endpoint
- ✅ `apps/api/src/routes/index.ts` — Route registration
- ✅ `e2e/tests/csp-nonce.spec.ts` — E2E enforcement verification
- ✅ `nginx/templates/nginx.prod.conf.template` — CSP header in nginx
- ✅ `.env.example` — CDN_HOST environment variable

## Acceptance Criteria Met

✅ CSP with strict allowlist (default-src 'self', script-src 'self' 'nonce-$cspNonce' 'strict-dynamic', etc.)  
✅ Next.js nonce-based CSP via middleware in enforcement mode (`Content-Security-Policy`)  
✅ Document updated to reflect active enforcement in `apps/web/src/middleware.ts`  
✅ Spot-checked policy breakdown table matching current directives  
✅ Referenced `e2e/tests/csp-nonce.spec.ts`  
✅ Added process note for future policy updates
