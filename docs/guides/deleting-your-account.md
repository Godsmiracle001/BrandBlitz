# Deleting Your Account

A plain-language guide to requesting deletion of your BrandBlitz account: how to start it,
what happens to your data, and how to cancel if you change your mind.

> This guide is the player-friendly version of the internal
> [gdpr-erasure runbook](../runbooks/gdpr-erasure.md), which has the operational detail
> for the team handling erasure requests. This doc is for the request itself; the runbook
> is background on how it's executed — you shouldn't need to read it to delete your account.

> API: `POST /me/delete-account` and `DELETE /me/delete-account`
> (implemented in `apps/api/src/routes/me/delete-account.ts`)
> · Manifest: `GET /legal/erasure`

## How to request deletion

1. Go to **Settings → Account**, and choose **Delete Account**.
2. Confirm your account's email address when prompted — this is a safety check so a
   deletion request can only be made by someone who actually knows the account's login
   email, not just someone with an active session.
3. Submit. Your account is scheduled for deletion; nothing is erased immediately.

If you'd rather call the API directly (e.g. for testing), the same flow is:

```bash
curl -X POST https://api.brandblitz.io/me/delete-account \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

A successful request returns `202 Accepted`:

```json
{
  "message": "Your account deletion request has been received. Your data will be anonymised after a 30-day grace period.",
  "executeAt": "2026-09-25T00:00:00.000Z"
}
```

`executeAt` is when your data will actually be erased — see [The 30-day grace
period](#the-30-day-grace-period) below.

### If something goes wrong

| Response | What it means |
| --- | --- |
| `403 Forbidden` | The email you entered doesn't match your account's email. |
| `409 Conflict` | You already have a deletion request pending — see [Cancelling a request](#cancelling-a-request) if you want to stop it, or just wait for the existing one to complete. |

## The 30-day grace period

Your account is **not** deleted immediately. Submitting a request starts a 30-day grace
period; your data is anonymised automatically once that window elapses. This gives you
time to change your mind, and gives the team a window to catch anything unexpected before
the erasure runs.

During the grace period your account continues to work normally — you can keep playing,
and canceling is a single request away (see below).

## What actually happens to your data

When the grace period ends, BrandBlitz **anonymises** your account rather than deleting
the row outright. Concretely:

- Your **email, Google login link, display name, username, avatar, phone number, and
  wallet addresses** (both your Stellar address and your embedded wallet) are wiped or
  replaced with anonymous placeholders.
- The **device identifier** stored against your past game sessions is cleared, along with
  any stored device-fingerprint hash used for fraud detection.
- Your account row itself is **kept, not deleted** — this is what lets your **financial
  history stay intact**: past payouts, earnings, and challenge history remain valid
  compliance records, just no longer traceable back to your name, email, or device. This
  is required by law (GDPR Article 17(3)(b) lets financial records be retained even after
  an erasure request) as well as by ordinary bookkeeping.
- The exact list of what's cleared is published at `GET /legal/erasure` — the same list
  the erasure process itself uses, so this documentation (and that endpoint) can never
  drift out of sync with what's actually erased. See the [gdpr-erasure
  runbook](../runbooks/gdpr-erasure.md) if you want the full technical detail on how this
  runs operationally.

### What happens to your balance and pending payouts?

Anonymisation does not touch your financial data — only your identity. Any earnings
already in your wallet balance, and any payouts already in flight, are **not** cancelled
or forfeited by requesting deletion; they're preserved exactly as they are, just no longer
linked to your name/email/device. **If you want to withdraw funds, do that before your
deletion request completes** — once your wallet address is cleared at the end of the
grace period, there's no account identity left to direct a payout to.

## Cancelling a request

Changed your mind? As long as the 30-day grace period hasn't finished yet, you can cancel:

1. Go to **Settings → Account**, and choose **Cancel Deletion Request**.
2. Confirm. Your account returns to normal — nothing was erased.

Via the API:

```bash
curl -X DELETE https://api.brandblitz.io/me/delete-account \
  -H "Authorization: Bearer $TOKEN"
```

A successful cancellation returns:

```json
{ "message": "Your account deletion request has been cancelled." }
```

If there's no pending request to cancel (e.g. it already completed, or you never
requested one), this returns `404 Not Found`.

> **Note:** this only cancels a request *you* started yourself. If your account is subject
> to a legal erasure request initiated by an administrator, it won't show up here, and
> can only be reversed through the admin process described in the [gdpr-erasure
> runbook](../runbooks/gdpr-erasure.md).

## Related

- [`GET /legal/erasure`](../runbooks/gdpr-erasure.md) — the published manifest of exactly
  what's cleared
- [Wallet & Payouts](./wallet-and-payouts.md) — how your balance and payouts work day to day
- [gdpr-erasure runbook](../runbooks/gdpr-erasure.md) — operational/technical background
  for the team executing erasure requests
