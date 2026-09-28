# Cursor Pagination, Async Error Handling, and Warmup Focus Pause

## Summary

This PR implements cursor pagination for challenges and leaderboards (issue #99), fixes error boundary to capture async errors in useEffect (issue #366), and fixes warmup countdown to pause when window loses focus (issue #365).

## What changed

### #99 - Cursor pagination on GET /challenges + GET /leaderboard/:id

- Added backwards compatibility for the legacy `offset` parameter with deprecation headers (`Deprecation: offset` and `Link` header pointing to documentation)
- Updated `CursorQuerySchema` in `apps/api/src/db/pagination.ts` to accept both `cursor` and `offset` parameters
- Modified `apps/api/src/routes/challenges.ts` to emit deprecation headers when `offset` is used
- Modified `apps/api/src/routes/leaderboard.ts` to emit deprecation headers when `offset` is used
- Updated `apps/web/src/hooks/use-live-leaderboard.ts` to remove `offset` from polling URL, using cursor-based pagination instead
- The composite index `(challenge_id, total_score DESC, completed_at ASC, id ASC)` already exists in migration `00012-cursor-paginationIndexes.sql`

### #366 - Error boundary does not capture async errors thrown in useEffect

- Created `apps/web/src/components/error/global-error-handler.tsx` with a global `window.addEventListener('unhandledrejection', ...)` handler
- Added `GlobalErrorHandler` component to `apps/web/src/app/layout.tsx` to catch unhandled promise rejections globally
- Wrapped async `useEffect` callbacks in `apps/web/src/app/(game)/challenge/[id]/challenge-page.tsx` with try/catch blocks and console.error logging
- Wrapped async fetch calls in `apps/web/src/app/profile/[username]/page.tsx` with try/catch blocks and console.error logging
- Added error logging to `apps/web/src/hooks/use-live-leaderboard.ts` for failed leaderboard fetches

### #365 - WarmupPhase countdown does not pause when window loses focus

- Modified `apps/web/src/components/game/warmup-phase.tsx` to capture and pass the server-authoritative `unlockAt` deadline from the warmup-start API response to CountdownTimer
- Added `onPausedChange` callback to `apps/web/src/components/game/countdown-timer.tsx` to notify parent components of pause state changes
- Modified warmup-phase to disable the Start button when the countdown is paused (due to visibility/focus loss)
- The underlying pause logic (visibilitychange, blur/focus events) was already implemented in `use-countdown.ts` and tested in `countdown-timer.test.tsx`
- Added Vitest test in `apps/web/src/components/game/warmup-phase.test.tsx` to verify the Start button is disabled when paused due to visibility change

## Files changed

- `apps/api/src/db/pagination.ts`
- `apps/api/src/routes/challenges.ts`
- `apps/api/src/routes/leaderboard.ts`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/components/error/global-error-handler.tsx` (new file)
- `apps/web/src/hooks/use-live-leaderboard.ts`
- `apps/web/src/app/(game)/challenge/[id]/challenge-page.tsx`
- `apps/web/src/app/profile/[username]/page.tsx`
- `apps/web/src/components/game/countdown-timer.tsx`
- `apps/web/src/components/game/warmup-phase.tsx`
- `apps/web/src/components/game/warmup-phase.test.tsx`

## Notes

- The cursor pagination implementation was already in place in the backend; this PR adds backwards compatibility for the deprecated `offset` parameter
- The global unhandled rejection handler logs errors to console and displays user-facing error toasts
- All async data-fetching callbacks in game and profile components are now wrapped in try/catch blocks
- Load testing for cursor pagination performance (p95 < 100ms vs 500+ms with offset) should be documented in a follow-up
- The countdown pause logic (visibility/focus events) was already implemented; this PR connects it to the warmup phase and prevents advancing while paused
- Playwright testing for mobile/desktop focus scenarios should be added in a follow-up

## Upstream assigned issues

- Closes #99
- Closes #366
- Closes #365
