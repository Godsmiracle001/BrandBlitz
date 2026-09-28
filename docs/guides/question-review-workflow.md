# Question Review Workflow

This guide walks brand admins through reviewing, approving, and regenerating AI-generated questions before a challenge goes live.

## Overview

When you create a challenge, the system generates AI-powered trivia questions across three rounds. Before the challenge becomes visible to players, you can preview each question and decide whether to approve it or flag it for regeneration.

## Accessing the Preview Page

Navigate to **Brand Dashboard > Your Brand > Questions > Preview**. The URL pattern is:

```
/brand/{brandId}/questions/preview
```

The page loads all generated questions and displays a progress bar showing how many have been reviewed.

## Reviewing a Question

Each question card shows:

- **Round number** (1, 2, or 3)
- **Question text** — the prompt players will see
- **Four answer options** (A, B, C, D) — the correct answer is highlighted in green
- **Status badge** — Pending, Approved, or Flagged

Use the **Previous** and **Next** buttons to navigate between questions.

## Approving a Question

Click **Approve** to mark a question as ready for players. Once approved:

- The question enters the active rotation for the challenge
- The status badge changes to "Approved"
- The approve button becomes disabled (you cannot un-approve without regenerating)

**API reference:**

```
POST /brands/:id/questions/:questionId/approve
```

Requires brand owner authentication. Sets `approved = true` on the question.

## Flagging a Question for Regeneration

Click **Flag for Regeneration** if a question is inaccurate, off-brand, or otherwise unsuitable. This action:

1. Deletes the current question
2. Generates a new AI question for the same round
3. Replaces the old question with the new one (still in "Pending" status)

You can regenerate a question as many times as needed — there is no limit on regeneration attempts.

**API reference:**

```
POST /brands/:id/questions/:questionId/regenerate
```

Requires brand owner authentication. Deletes the old question and inserts a newly generated one for the same round. Returns the new question with its `correct_answer`.

## Flagging Without Regenerating

If you want to mark a question as unsuitable without immediately regenerating it, use the flag endpoint:

```
POST /brands/:id/questions/:questionId/flag
```

This sets `approved = false` on the question, removing it from the active rotation. The question remains in the database but will not be served to players.

## What Happens When All Questions Are Approved

Once every question across all three rounds has `approved = true`, the progress bar shows "All approved" and the challenge is ready to go live (subject to funding requirements — see [Funding a Challenge](./funding-a-challenge.md)).

## Summary of API Endpoints

| Endpoint | Method | Effect |
|----------|--------|--------|
| `/brands/:id/questions/preview` | GET | List all questions for review |
| `/brands/:id/questions/:questionId/approve` | POST | Mark question as approved |
| `/brands/:id/questions/:questionId/regenerate` | POST | Delete and regenerate the question |
| `/brands/:id/questions/:questionId/flag` | POST | Mark question as flagged (sets `approved = false`) |
