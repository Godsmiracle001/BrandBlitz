# Brand Distractors API

## What is a distractor?

In a BrandBlitz challenge round, a player is shown a question and must pick the correct
brand out of several options. The **correct answer** is the brand the challenge is
actually about; the **distractors** are the incorrect answer options shown alongside it.

`GET /brands/:id/distractors` returns other, unrelated brands suitable for use as those
incorrect options — public-safe (id/name/logo only, no owner-only fields) and excluding
the brand itself.

## How distractors are used in question generation

When a challenge is created, `generateChallengeQuestions(challenge.id, brand, distractorBrands)`
(in `apps/api/src/routes/brands.ts`) builds the round's multiple-choice questions from the
challenge's own brand plus a set of distractor brands, so each question presents one
correct brand alongside plausible-looking wrong answers. This endpoint is the source of
those distractor brands — it is not called directly at question-generation time (the
handler that creates a challenge queries distractors itself via the same underlying
`getActiveDistractorBrands` helper), but it exposes the identical selection so a
consumer/integrator can preview or reason about what a round's wrong answers would look
like for a given brand.

## GET /brands/:id/distractors

Returns up to three other active brands, suitable as incorrect answer options for a
challenge round based on the given brand.

### Authentication

**Required.** Send a valid session token the same way as other authenticated routes in
this API (see [`auth.md`](./auth.md)). Unlike `GET /brands/public`, this endpoint does
not accept unauthenticated requests.

### Path Parameters

| Parameter | Type          | Description                                    |
| --------- | ------------- | ----------------------------------------------- |
| `id`      | string (UUID) | The brand to fetch distractors for (excluded from the results). |

### Response

```json
{
  "distractors": [
    {
      "id": "6f1a9e2c-1234-4a3b-9c9d-abcdef123456",
      "name": "Northwind Traders",
      "logo_url": "https://cdn.brandblitz.io/logos/northwind.webp"
    },
    {
      "id": "8e2b7f11-5678-4c1d-9e0f-fedcba654321",
      "name": "Contoso",
      "logo_url": null
    }
  ]
}
```

#### Response Fields

| Field                | Type            | Description                                          |
| --------------------- | --------------- | ----------------------------------------------------- |
| `distractors`         | array            | Up to 3 distractor brands.                             |
| `distractors[].id`    | string (UUID)    | Distractor brand's identifier.                          |
| `distractors[].name`  | string           | Distractor brand's display name.                        |
| `distractors[].logo_url` | string \| null | URL to the distractor brand's logo, or `null` if unset. |

Only `id`, `name`, and `logo_url` are exposed — no owner-only or internal brand fields,
since this data may be shown to any authenticated player, not just the brand's owner.

### Selection

Distractors are drawn from all other non-deleted brands (`deleted_at IS NULL`), most
recently created first, capped to the first 3. The requested brand itself is always
excluded. There is currently no guarantee of variety beyond recency (e.g. no exclusion of
brands the player has already seen as distractors in a prior round).

### Errors

| Status | Condition               |
| ------ | ------------------------ |
| 404    | No brand exists with the given `id`. |

### Example

```bash
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  https://api.brandblitz.io/brands/6f1a9e2c-1234-4a3b-9c9d-abcdef123456/distractors | jq .
```

## See also

- [`public-brands.md`](./public-brands.md) — unauthenticated brand listing (the closest
  existing brands-overview doc; there is no `docs/api/brands.md` in this repo yet).
