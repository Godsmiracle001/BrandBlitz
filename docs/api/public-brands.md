# Public Brand Discovery API

The public brand listing endpoint provides unauthenticated access to the BrandBlitz brand catalog. This is the only brand-listing endpoint that does not require authentication.

## GET /brands/public

Returns a list of all non-deleted brands with their active challenge counts.

### Authentication

**None required.** This endpoint is publicly accessible.

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Maximum number of brands to return (1–100). **Note:** This parameter is defined in the schema but is not currently enforced by the handler. All matching brands are returned. |

### Response

```json
{
  "brands": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Acme Corp",
      "tagline": "Building the future",
      "logo_url": "https://cdn.brandblitz.io/logos/acme.webp",
      "primary_color": "#6366f1",
      "category": null,
      "active_challenge_count": 3
    }
  ]
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique brand identifier |
| `name` | string | Brand display name |
| `tagline` | string \| null | Short tagline or description |
| `logo_url` | string \| null | URL to the brand's logo image |
| `primary_color` | string \| null | Hex color code for the brand |
| `category` | null | Placeholder — always `null` currently |
| `active_challenge_count` | integer | Number of challenges with `status = 'active'` |

### Sorting

Results are sorted alphabetically by brand name (`name ASC`).

### Filtering

Only non-deleted brands are returned (`deleted_at IS NULL`).

### Example

```bash
curl -s https://api.brandblitz.io/brands/public | jq .
```

```json
{
  "brands": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Acme Corp",
      "tagline": "Building the future",
      "logo_url": "https://cdn.brandblitz.io/logos/acme.webp",
      "primary_color": "#6366f1",
      "category": null,
      "active_challenge_count": 3
    },
    {
      "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "name": "Stellar Labs",
      "tagline": null,
      "logo_url": null,
      "primary_color": null,
      "category": null,
      "active_challenge_count": 0
    }
  ]
}
```

### Notes

- This is the only unauthenticated brand-listing endpoint. The authenticated `GET /brands` endpoint returns the full brand list for the authenticated user's account.
- The `active_challenge_count` reflects challenges with `status = 'active'` at query time. Ended or pending challenges are not counted.
- The `category` field is a placeholder and always returns `null`. It may be populated in a future release.

### Related

- [Authentication](./auth.md) — for authenticated endpoints
- [Distractors](./distractors.md) — `GET /brands/:id/distractors`, the incorrect answer options used in challenge question generation
- [OpenAPI Spec](../openapi.yml) — full API specification
