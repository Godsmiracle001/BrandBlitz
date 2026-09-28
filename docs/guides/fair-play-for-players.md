# Fair Play for Players

A plain-language summary of how BrandBlitz keeps challenges fair, what happens if your session gets flagged, and what to do if you think a flag was a mistake.

> This guide is the player-friendly version of the internal
> [ANTI-CHEAT-POLICY.md](../../ANTI-CHEAT-POLICY.md), which has the full technical detail.

## Why We Check for Fair Play

BrandBlitz pays real USDC from real prize pools. To protect the pool for honest players, every answer is checked server-side for signs of automation or abuse. You don't need to do anything special to pass these checks — playing normally always qualifies.

## What Gets Checked

| Behavior | What we look at | What happens |
|---|---|---|
| Answering impossibly fast | A reaction time under **80 ms** | The answer is rejected outright (`403 Forbidden`) and the round is not saved |
| Very fast answers | A reaction time between **80–150 ms** | The round still counts, but the session is recorded with a fraud flag |
| Extreme lag / stalled rounds | A reaction time over **30 seconds** | The round still counts, but the session is recorded with a fraud flag |
| Many accounts on one device | **3 or more accounts** from the same device fingerprint within 24 hours | The sessions are recorded with a fraud flag |

A few things worth knowing:

- Scores are computed entirely on the server. Correct answers and scores are never sent to your browser, so they can't be tampered with.
- The warm-up must run at least 20 seconds before the challenge unlocks — this is enforced server-side, not by a timer in your browser.
- Practice sessions never affect payouts.

## What Happens If Your Session Is Flagged

There are two levels of enforcement:

### 1. Blocked round (critical)

If an answer arrives faster than 80 ms (faster than humanly possible), the server rejects it immediately with a `403 Forbidden` error. The round data is discarded and never saved. You'll see an error in the game if this happens.

### 2. Flagged session (warning)

If a session picks up any fraud flag (e.g. several suspiciously fast answers, or many accounts sharing one device):

- The session completes normally, but it is marked **ineligible for the prize pool**.
- The payout worker checks every session for fraud flags before paying out — flagged sessions are excluded from their share of the pool.
- The session may be hidden from public competitive leaderboards.

Your other sessions are unaffected: only the flagged session loses payout eligibility.

## How to Appeal

If you believe your session was flagged in error:

1. Gather details: the challenge name, roughly when you played, and your username.
2. Contact support through the in-app **Report** button (available while playing a challenge) or open an issue on the [BrandBlitz GitHub repository](https://github.com/privexlabs/BrandBlitz/issues).
3. Include your username and challenge details so the session can be located and reviewed.

Flag decisions are reviewable — legitimate network hiccups or device sharing (e.g. a family computer) can be investigated and corrected.

## Tips to Stay Eligible

- Answer as fast as you can — just remember no human answers in under 150 ms consistently, so very fast streaks get reviewed.
- Play on your own device and account.
- If you're on a slow connection, wait for the question to fully load before answering.
- One account per person is all you need — practice mode is free for sharpening recall.

## Related

- [ANTI-CHEAT-POLICY.md](../../ANTI-CHEAT-POLICY.md) — full technical policy (detection signals, enforcement tiers, payout worker behavior)
- [Player FAQ](../faq/player-faq.md) — payouts, streaks, leagues
- [Scoring Explained](./scoring-explained.md) — exactly how points are calculated
