# Consuming the OpenAPI Spec

BrandBlitz serves the generated OpenAPI document from the API process and also keeps a committed YAML copy in the repository.

## Browse the interactive docs

When the API is running, open the Scalar UI at:

```text
http://localhost:4000/docs
```

If you call the API directly without the Docker or proxy layer, use the API server port instead:

```text
http://localhost:3001/docs
```

The Scalar page reads the live JSON spec from `/docs/openapi.json`.

## Fetch the JSON spec

```bash
curl -sS http://localhost:4000/docs/openapi.json \
  -H 'Accept: application/json' \
  -o brandblitz.openapi.json
```

For production, replace the host with the public API origin while keeping the `/docs/openapi.json` path.

## Source of truth

- Runtime route: `apps/api/src/routes/docs.ts`
- OpenAPI registry: `apps/api/src/lib/openapi-registry.ts`
- Registered route schemas: `apps/api/src/routes/openapi/*.openapi.ts`
- Committed spec: `docs/openapi.yml`
- Generator script: `apps/api/scripts/gen-openapi.ts`

## Generate a typed client

A frontend or partner integration can generate TypeScript types from the JSON spec:

```bash
npx openapi-typescript http://localhost:4000/docs/openapi.json \
  -o src/generated/brandblitz-api.ts
```

You can also generate from the committed YAML spec:

```bash
npx openapi-typescript docs/openapi.yml \
  -o src/generated/brandblitz-api.ts
```

Run the command from the package that will consume the generated types, or adjust the output path to match that package.

## Current schema coverage

The OpenAPI registry currently includes schemas for these route groups:

| Route group | Schema file |
|---|---|
| Auth | `apps/api/src/routes/openapi/auth.openapi.ts` |
| Challenges | `apps/api/src/routes/openapi/challenges.openapi.ts` |
| Leaderboard | `apps/api/src/routes/openapi/leaderboard.openapi.ts` |
| Sessions | `apps/api/src/routes/openapi/sessions.openapi.ts` |

These mounted route groups do not yet have dedicated OpenAPI schema files:

- Admin routes: `/admin/*`
- Brand management routes: `/brands/*`
- Config, legal, metrics, and CSP reporting routes
- Upload routes: `/upload/*`
- User profile and account routes: `/users/*`, `/me/delete-account`
- Webhook routes: `/webhooks/*`
- Waitlist routes: `/waitlist/*`
- League routes: `/leagues/*`

## Authentication while exploring

Protected endpoints expect a bearer token:

```bash
curl -sS http://localhost:4000/users/me \
  -H 'Authorization: Bearer <token>'
```

Browser integrations that rely on cookies must be served from the configured `WEB_URL` origin so the API CORS policy can allow credentials.