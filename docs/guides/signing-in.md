# Signing in to BrandBlitz

BrandBlitz uses Google sign-in for player and brand accounts. On production deployments, the visible sign-in option is Google OAuth, which lets you continue with the Google account tied to the email address you want to use on BrandBlitz.

## Supported sign-in providers

- Google OAuth is the supported end-user sign-in provider.
- A Google mock provider can be enabled only for automated end-to-end testing when `E2E_MOCK_GOOGLE_OAUTH=true`. It is not an end-user sign-in option.

## Account linking and email conflicts

After Google confirms your identity, BrandBlitz sends the Google ID token to the BrandBlitz API. The API uses that verified identity to create or find your BrandBlitz account and then returns the app session token used by the web app.

If you try to sign in with a different provider that uses the same email address, BrandBlitz does not currently expose a second public provider for automatic account linking. If a future provider is added, the API should decide whether to link the account or stop sign-in with a conflict message before giving access to the dashboard.

## Session duration

BrandBlitz keeps the web session in a secure HTTP-only cookie backed by a JWT session. Sessions last up to 7 days. After the session expires, you will be sent back to the sign-in screen and can continue with Google again.

## Signing out and forced sign-out

Use the app's sign-out control when you want to end your current session. The app can also send you back to the login page if your session expires, the server rejects the token, or the secure session cookie is no longer available.

For internal operational background on forced sign-out behavior, see `docs/runbooks/session-forced-signout.md`.
