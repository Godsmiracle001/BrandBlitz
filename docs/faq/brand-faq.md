# Brand Admin FAQ

Frequently asked questions for brand administrators using the BrandBlitz dashboard, analytics, and question-review workflow.

---

### What is the minimum challenge pool amount?

The minimum pool for any challenge is **100 USDC**. This is enforced at challenge creation and applies to both individual challenges and templates.

**Route:** `POST /brands/:id/challenges` or `POST /brands/:id/templates`  
**Dashboard:** [Launch Challenge](/docs/guides/funding-a-challenge)

---

### How do I request a refund?

Refunds are **admin-initiated** — there is no automatic refund window. To request a refund, contact the BrandBlitz support team. Refunds are processed via `POST /admin/challenges/:id/refund` and are subject to these conditions:

- The challenge must **not** already be settled (i.e. payouts have not been distributed).
- A deposit transaction must exist on-chain.
- The full pool amount is returned to the original deposit sender.

If a challenge has already been settled, a refund is not possible.

**Route:** `POST /admin/challenges/:id/refund`  
**Dashboard:** Admin challenges management

---

### Is there a limit on how many times I can regenerate questions?

There is **no hard limit** on individual question regeneration (`POST /brands/:id/questions/:questionId/regenerate`). However, the **question preview** endpoint (`POST /brands/:id/questions/preview`) is rate-limited to **10 requests per hour per brand**. This cap applies per brand regardless of which admin account makes the request.

Each preview request generates between 3 and 10 questions.

**Route:** `POST /brands/:id/questions/preview` (rate-limited)  
**Route:** `POST /brands/:id/questions/:questionId/regenerate` (no separate limit)  
**Dashboard:** [Question Review Workflow](/docs/guides/question-review-workflow)

---

### Why does my analytics data look incomplete?

Analytics are computed from **completed sessions only**. Sessions that are in progress (`warmup_started` or `active`) or flagged for fraud are excluded. Results are computed via live queries against committed data — there is no batch job or caching delay, but the data only reflects sessions that have fully completed and been committed to the database.

You can filter analytics by date range using the `from` and `to` query parameters. By default, cost-per-session data covers the last 30 days.

**Route:** `GET /brands/:id/analytics`  
**Dashboard:** View Analytics

---

### How does fraud flagging affect my payout pool?

When a session is flagged for fraud, that session is **excluded from the leaderboard** and from **payout eligibility**. The flagged session's score is not counted toward the winner calculation, so the payout pool is distributed only among non-flagged participants.

At the payout level, a Postgres trigger blocks payouts to users with open fraud flags. The payout worker treats this as an unrecoverable error — the individual payout is skipped, but other recipients are still paid.

**Route:** `GET /admin/fraud-flags` (admin)  
**Route:** `PATCH /admin/fraud-flags/:id` (admin)  
**Dashboard:** [Fraud Review](/docs/guides/question-review-workflow)

---

### What challenge duration should I set?

The minimum challenge duration is **1 hour**. Each challenge consists of:

- **20-second warmup** — participants prepare before the first question.
- **45-second challenge window** — participants answer questions.
- **3 rounds** — each round has one question.

Plan for enough time to attract participants. Longer challenges (24–72 hours) tend to get more completions.

**Route:** `POST /brands/:id/challenges`  
**Dashboard:** [Launch Challenge](/docs/guides/funding-a-challenge)

---

### How do I view my challenge stats?

The dashboard shows per-challenge statistics including:

- Total and completed sessions
- Completion rate (%)
- Disqualification rate (%)
- Average score and accuracy (%)
- Total paid out (USDC)
- Cost per completed session (USDC)
- Unique participants

For deeper analytics, use the analytics endpoint which provides per-question accuracy breakdowns and daily cost-per-session trends.

**Route:** `GET /challenges/:id/stats`  
**Route:** `GET /brands/:id/analytics`  
**Dashboard:** [View Analytics](/docs/guides/question-review-workflow)

---

### Can I update a challenge after it is created?

Challenge pool amounts and end times are set at creation. You can modify questions via the regenerate endpoint before the challenge starts. Once a challenge is live (warmup or active), its core parameters cannot be changed.

If you need to cancel a live challenge, contact admin support. Refund eligibility depends on whether payouts have already been settled.

**Route:** `POST /brands/:id/questions/:questionId/regenerate`  
**Dashboard:** [Question Review Workflow](/docs/guides/question-review-workflow)

---

### What happens if a challenge has no participants?

If a challenge ends with zero completed sessions, no payouts are processed. The challenge status remains `"ended"` and the pool funds stay in the escrow contract (or the brand's hot wallet if escrow is not configured). You can request a refund of unclaimed funds through admin support, provided the challenge has not been settled.

**Route:** `POST /admin/challenges/:id/refund`  
**Dashboard:** Admin challenges management

---

### How are payout costs calculated?

Payout costs are the sum of Stellar network fees for all payment operations. BrandBlitz batches up to 50 Payment operations per transaction, so the total fee is typically around **$0.0007** regardless of the number of winners. The `cost_per_completed_session_usdc` metric on the dashboard divides total payout costs by the number of completed sessions.

**Route:** `GET /challenges/:id/stats`  
**Dashboard:** [View Analytics](/docs/guides/funding-a-challenge)

---

### Where can I find my brand on the public listing?

BrandBlitz maintains a public brand catalog at `GET /brands/public`. This endpoint requires no authentication and returns brand name, tagline, logo, and active challenge count. It is the only unauthenticated brand-listing endpoint.

If your brand does not appear, ensure you have created at least one brand kit via the dashboard. The listing includes all non-deleted brands ordered alphabetically.

**Route:** `GET /brands/public`  
**Dashboard:** [Brand Dashboard](/docs/guides/question-review-workflow)  
**API Docs:** [Public Brands API](../api/public-brands.md)
