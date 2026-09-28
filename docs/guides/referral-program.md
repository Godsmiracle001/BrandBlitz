# Referral Program

How BrandBlitz referral links work, how bonuses are earned and credited, and who is eligible.

> Feature surface: **Referral Hub** at `apps/web/src/app/profile/referrals/page.tsx`
> · API: `GET /users/me/referrals`, `GET /users/me/referrals/stats`

## Getting Your Referral Link

1. Sign in and open **Profile → Referral Hub**.
2. Your personal referral link is shown in the "Your Referral Link" card. It looks like:

   ```
   https://brandblitz.app?ref=ABC234
   ```

3. Copy it with the **Copy** button, or share directly with **Share on X**.
4. Your referral code is the 6-character string after `?ref=`. Codes use an unambiguous alphabet (no `I`, `O`, `0`, or `1`) — e.g. `ABC234`.

Every account automatically gets a unique code; you don't need to create one. If someone enters just your code instead of using your link, attribution still works — the code can be attached via the `?ref=` query parameter or a `ref` cookie.

## How Bonuses Are Earned

A referral becomes a conversion when the person who signed up with your link **wins a challenge payout**. At that moment two bonuses are created:

| Who | Amount | When |
|---|---|---|
| **You (referrer)** | 10% of your friend's winning payout — capped at **5 USDC** | When their payout is processed |
| **Your friend (referred)** | Flat **1 USDC** | Same moment |

Key rules:

- Only the friend's **first win** pays a bonus — each referral pays out once, ever.
- The bonus is calculated from the friend's actual USDC prize, not their score.
- Example: your friend wins **20 USDC** in a challenge → you get **2 USDC**, they get an extra **1 USDC**. If they win 60 USDC, your share hits the cap: **5 USDC**.

## When Bonuses Are Credited

Bonuses ride along with the challenge payout pipeline:

1. The challenge ends and the payout job runs (this can take a few minutes after the end date).
2. Each winner's payout is processed on Stellar.
3. Immediately after a winner's payout succeeds, any pending referral bonus tied to that win is queued for its own on-chain payment.
4. Bonus payouts move through statuses: **pending → sent**. You'll see the split in the Referral Hub's **Pending** / **Confirmed** cards.

If a bonus can't be sent yet — for example a missing payout address on either side — it stays out of the queue until the address requirement is met.

## Eligibility Restrictions

Referral attribution is rejected when any of these apply:

- **Self-referrals** — signing up with your own code is blocked.
- **Referral cycles** — A referring B while B refers A is blocked.
- **Device reuse** — if this device fingerprint is already attributed to another account, new attribution is refused (one device = one referrer).
- **One referral per person** — the *first* valid code a person uses wins; later codes have no effect.
- **Fraud-flagged sessions** — if the winning session carries a fraud flag, the bonus is skipped and the skip is written to the audit log. See [Fair Play for Players](./fair-play-for-players.md).
- **Deleted accounts** — deleted referred users disappear from your list.

Both sides need a payout address (embedded wallet or Stellar address) before a bonus can be paid.

## Checking Your Stats

The Referral Hub shows your code, referred users, and bonus totals. The same data is available via the API:

### `GET /users/me/referrals`

```json
{
  "referralCode": "ABC234",
  "referredUsers": [
    {
      "id": "…",
      "username": "john_doe",
      "displayName": "John Doe",
      "avatarUrl": "https://…",
      "joinedAt": "2026-08-01T10:00:00.000Z",
      "bonusPaid": false
    }
  ],
  "bonusStatus": {
    "pendingUsdc": "2.5000000",
    "confirmedUsdc": "10.0000000"
  }
}
```

| Field | Description |
|---|---|
| `referralCode` | Your 6-character referral code |
| `referredUsers[]` | People who signed up with your code, newest first |
| `referredUsers[].bonusPaid` | `true` once the bonus payout has been sent |
| `bonusStatus.pendingUsdc` | Total queued-but-unpaid referrer bonuses (7-decimal USDC) |
| `bonusStatus.confirmedUsdc` | Total referrer bonuses already sent |

### `GET /users/me/referrals/stats`

```json
{
  "referralCode": "ABC234",
  "invitesSent": 12,
  "conversions": 3,
  "totalEarned": "13.5000000",
  "totalEarnedUsdc": "13.5000000"
}
```

| Field | Description |
|---|---|
| `invitesSent` | Tracked invite attempts |
| `conversions` | Referrals that converted (count of referral relationships) |
| `totalEarned` / `totalEarnedUsdc` | Combined referrer + referred bonuses earned (7-decimal USDC) |

Amounts use Stellar's 7-decimal precision (1 USDC = 10,000,000 stroops).

## Related

- [Scoring Explained](./scoring-explained.md) — how winning payouts (and therefore bonus sizes) are computed
- [Fair Play for Players](./fair-play-for-players.md) — how flagged sessions affect eligibility
- [Player FAQ](../faq/player-faq.md)
