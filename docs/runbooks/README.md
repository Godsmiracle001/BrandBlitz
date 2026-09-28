# Runbooks

Operational playbooks for BrandBlitz on-call engineers. Each runbook covers one failure scenario: symptom → impact → diagnosis → mitigation → remediation.

---

## Index

| Runbook | Description |
| --- | --- |
| [horizon-outage.md](horizon-outage.md) | Stellar Horizon API is degraded or unreachable — payouts blocked |
| [hot-wallet-low-balance.md](hot-wallet-low-balance.md) | Hot wallet USDC balance too low to process payouts |
| [payout-stuck-in-queue.md](payout-stuck-in-queue.md) | Payout jobs stuck in BullMQ — recipients not receiving USDC |
| [cdn-purge.md](cdn-purge.md) | Force-invalidate a cached asset from Cloudflare R2 / nginx |
| [leaked-secret.md](leaked-secret.md) | Secret committed to git or exposed in logs — contain and rotate |
| [rotate-minio-certs.md](rotate-minio-certs.md) | Rotate expired or compromised MinIO TLS certificates |
| [rotate-s3-credentials.md](rotate-s3-credentials.md) | Rotate S3 / R2 access keys |
| [rotate-secrets.md](rotate-secrets.md) | General secret rotation procedure for all services |
| [session-forced-signout.md](session-forced-signout.md) | Force-revoke refresh tokens for a user or entire fleet |

---

## Adding a new runbook

1. Copy the template below into a new `docs/runbooks/<name>.md`.
2. Add a row to the table above.
3. Link it from any related ADR or issue.

### Template

```markdown
# Runbook: <Title>

## Symptom
What an engineer sees (alert text, log line, user report).

## Impact
Who is affected and how severely.

## Diagnosis
Step-by-step commands / queries to confirm root cause.

## Mitigation
Fast action to stop the bleeding (may be temporary).

## Remediation
Permanent fix and verification steps.

## Post-mortem
Link to the post-mortem template: [post-mortem template](../post-mortem-template.md)
```
