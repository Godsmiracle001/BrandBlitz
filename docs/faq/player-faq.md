# Player FAQ

Frequently asked questions about earnings, challenges, streaks, referrals, and leagues on BrandBlitz.

---

### When will I receive my payout?

After a challenge ends, the payout pipeline runs automatically. Payouts go through these stages:

1. **Pending** — payout is queued for processing.
2. **Sent** — the USDC payment has been submitted to Stellar.
3. **Confirmed** — the transaction has been confirmed on-chain.

Most payouts complete within a few minutes. If a payout fails (e.g. due to a network issue), it is automatically retried up to 5 times with exponential backoff. You can check your payout status on the earnings page.

**Page:** [Earnings](/profile/[username]/earnings)  
**Route:** `GET /users/:username/earnings`

---

### How do streaks work?

A streak counts consecutive days where you complete at least one challenge session. If you play today, your streak increments by 1. If you miss a day, your streak resets to 1.

You earn badge rewards at streak milestones:

| Days | Badge |
|------|-------|
| 3 | `streak_3_days` |
| 7 | `streak_7_days` |
| 14 | `streak_14_days` |
| 30 | `streak_30_days` |

You also receive in-app notifications at 7, 30, and 100 days.

**Page:** Profile  
**Route:** `GET /me/streak`

---

### What is streak repair?

Streak repair lets you restore a broken streak once per month. To use it:

- Your streak must have been at least **3 days** before it broke.
- You must use the repair within **2 days** of your last play day.
- You get **1 repair per month** (resets at the start of each month).

To repair your streak, call `POST /users/streaks/repair` or use the repair button on your profile page.

**Route:** `POST /users/streaks/repair`  
**Route:** `GET /me` (shows `streak_repair_available` and `streak_repairs_this_month`)

---

### How do referral bonuses work?

When someone signs up using your referral link and completes a challenge:

- **You receive 10% of their win amount**, capped at **5 USDC** maximum.
- **They receive a 1 USDC bonus** added to their payout.

Referral bonuses are credited automatically after the referred user's challenge payout is confirmed. Fraud-flagged sessions are excluded from referral bonus calculations.

Your referral code is a 6-character code visible on the referrals page. Share it via the copy-to-clipboard button or the Twitter share link.

**Page:** [Referrals](/profile/referrals)  
**Route:** `GET /users/me/referrals`

---

### Why was my session flagged for fraud?

Sessions are flagged when the system detects unusual patterns such as abnormally fast reaction times, inconsistent device fingerprints, or other suspicious behavior. Flagged sessions are excluded from leaderboards and payouts.

If your session is flagged, you will see it marked as "disqualified" in your session history. The fraud review team evaluates flagged sessions — if the flag was a false positive, it can be resolved and your session restored.

**Route:** `GET /users/:username/sessions` (session history shows `disqualified` outcome)

---

### How do leagues work?

Leagues group players into tiers based on weekly performance:

- **Bronze** — starting tier for all new players.
- **Silver** — promoted from bronze.
- **Gold** — promoted from silver.

Each week, you are placed in a group of 30 players within your tier. The **top 3** players in each group get promoted to the next tier, and the **bottom 3** get demoted. Everyone else stays in their current tier.

League rankings reset every Monday at 00:00 UTC. Final results from the previous week are calculated on Sunday at 23:59 UTC.

**Route:** `GET /leagues/current`

---

### Why is my earnings total different from what I expected?

Earnings are calculated from **completed and confirmed** payouts only. Sessions that were flagged for fraud or disqualification do not count toward your earnings. Additionally, pending payouts (not yet confirmed on Stellar) will not appear in your total until they are confirmed.

Check the earnings page for a full timeline of each payout with its current status.

**Page:** [Earnings](/profile/[username]/earnings)  
**Route:** `GET /users/:username/earnings`

---

### Can I change my Stellar address for payouts?

Your Stellar address is linked to your account at signup via the embedded wallet. To update it, you would need to contact support. Payouts are sent to the Stellar address associated with your account at the time the challenge payout is processed.

**Route:** `GET /me` (shows your current profile)

---

### What happens if a payout fails?

If a payout fails due to a network error or insufficient funds, the system automatically retries up to 5 times with exponential backoff. If all retries fail, the payout is marked as `failed` and added to a dead-letter queue for manual review.

You will not lose your earnings — failed payouts are logged and can be retried by an administrator.

**Route:** `GET /users/:username/earnings` (check payout status)

---

### How is my challenge score calculated?

Each challenge has 3 rounds. In each round, you answer a question within 15 seconds. Your score is based on accuracy and speed. The final score is the sum across all rounds.

Only completed sessions (all 3 rounds answered) are eligible for the leaderboard and payouts. Sessions that are abandoned or disconnected before completion do not count.

**Route:** `GET /challenges/:id/leaderboard`  
**Page:** Challenge pages

---

### How do I view my challenge history?

Your session history shows all challenges you have participated in, with outcomes (won, lost, or disqualified). Each entry shows the challenge title, your score, and whether you won a payout.

**Route:** `GET /users/:username/sessions`

---

### Why is my referral bonus not showing?

Referral bonuses are credited **after** the referred user's challenge payout is confirmed on Stellar. If the referred user's payout is still pending or failed, the bonus will not yet appear. Fraud-flagged sessions are excluded from referral bonus calculations — if the referred user's session was flagged, no bonus is credited.

**Page:** [Referrals](/profile/referrals)  
**Route:** `GET /users/me/referrals`
