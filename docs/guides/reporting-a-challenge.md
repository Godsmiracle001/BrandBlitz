# Reporting a Challenge

This guide explains when and how players can report a challenge that violates community guidelines.

## When to Report

You should report a challenge if it contains:

- **Misleading** content — false claims or deceptive information
- **Offensive** material — hate speech, harassment, or explicit content
- **Spam** — irrelevant or low-quality content designed to manipulate
- **Trademark violation** — unauthorized use of brand names or logos
- **Other** — any other policy violation (provide details)

## How to Report

From the challenge page, submit a report via:

```
POST /challenges/:id/report
```

**Request body:**

```json
{
  "reason": "misleading",
  "details": "Optional description, max 500 characters"
}
```

| Field | Required | Values |
|-------|----------|--------|
| `reason` | Yes | `misleading`, `offensive`, `spam`, `trademark_violation`, `other` |
| `details` | No | Free text, max 500 characters |

**Requirements:**
- You must be authenticated
- You must have an active user account
- The challenge must be in `active` status

## Rate Limits

Reports are rate-limited to **5 per user per hour**. If you exceed this limit, you will receive a 429 response.

## Duplicate Detection

Each user can only report a specific challenge once. If you have already reported a challenge, you will receive a `409 ALREADY_REPORTED` error.

## What Happens After a Report

1. The report is stored in the `challenge_reports` table
2. An entry is logged in the audit log with the reporter's user ID, reason, and details
3. The report is reviewed by the platform's moderation team
4. If the report is upheld, the challenge may be removed from rotation, flagged, or the brand may face consequences

Reports do not immediately remove a challenge from the platform — they enter a review queue.

## Consequences for Violations

Challenges found to violate community guidelines may result in:

- Immediate removal from active rotation
- Brand account restrictions
- Repeated violations may lead to account suspension

See the platform's security and fair-play policies for full details on enforcement.

## Related

- [Funding a Challenge](./funding-a-challenge.md) — how challenges are activated
- [Question Review Workflow](./question-review-workflow.md) — how brands review questions before launch
