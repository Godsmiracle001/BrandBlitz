# Leaked secret runbook

This runbook covers what to do if a secret is accidentally committed and detected by Gitleaks (locally or in CI).

## 1) Contain

1. **Assume compromise**. Disable the secret immediately (rotate/revoke) before doing anything else.
2. **Identify scope**: where the secret is used (API, worker, CI, web), and who has access to the affected system.
3. **Check blast radius**: look for suspicious usage in provider logs (Stellar, Google, Twilio, etc.).

## 2) Rotate / revoke

### Stellar hot wallet secret

1. Generate a new keypair.
2. Update the runtime secret store / environment (e.g. `HOT_WALLET_SECRET` + `HOT_WALLET_PUBLIC_KEY`).
3. If the old key was funded, move funds to the new account.
4. Update any allow-lists or monitoring that reference the old address.

### Google OAuth client secret

1. Rotate the OAuth client secret in Google Cloud Console.
2. Update `GOOGLE_CLIENT_SECRET` in the environment/secret manager.
3. Validate login flow in staging, then production.

### Twilio tokens / Verify service

1. Rotate `TWILIO_AUTH_TOKEN` and any API keys in Twilio Console.
2. Update the runtime secret store / environment.
3. Validate SMS verification flow.

## 3) Remove from Git history (if required)

Even if you delete the secret from the latest commit, it may still exist in Git history.

1. Remove the secret from the codebase.
2. Use a history rewriting tool (e.g. `git filter-repo`) to purge the secret from all commits.
3. Force-push rewritten history and coordinate with all contributors (they must re-clone or hard reset).

If the repo is public, assume the secret was copied already and keep it rotated regardless.

## 4) Post-incident

1. Add/adjust detection rules in `.gitleaks.toml` to prevent recurrence.
2. Review where secrets are stored and ensure all secrets come from the secret manager / environment variables.
3. Add a short incident note in internal tracking (what leaked, when rotated, impact).
