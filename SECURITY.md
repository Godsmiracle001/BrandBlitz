# Security Policy

BrandBlitz takes security seriously. This document describes how to report security vulnerabilities and access security-related runbooks.

## Reporting a Vulnerability

If you discover a security vulnerability in BrandBlitz, please report it responsibly:

1. **Do not open a public GitHub issue** for the vulnerability
2. Email the security team at [security@brandblitz.app](mailto:security@brandblitz.app) with:
   - A description of the vulnerability
   - Steps to reproduce (if applicable)
   - The potential impact
   - Your contact information (name, email)

3. We will acknowledge receipt within 24 hours and provide a timeline for remediation
4. Once patched and released, we will credit you publicly (unless you prefer anonymity)

## Security Response Timeline

- **24 hours:** Acknowledgment and initial triage
- **3 days:** Confirmation of the issue and preliminary fix plan
- **7 days:** Public disclosure (or 90 days for critical vulnerabilities affecting users)
- **30 days:** Patch release (for critical issues)

## Credentials and Secrets

If you suspect a credential or API key has been leaked:

1. Rotate the secret immediately using the [Secrets Rotation Runbook](docs/runbooks/secrets-rotation.md)
2. Review logs for unauthorized activity during the compromise window
3. File an issue or email [security@brandblitz.app](mailto:security@brandblitz.app) with the timeline

### Secrets Rotation Schedule

All long-lived secrets are rotated on a regular schedule to minimize the impact of a compromise. See [Secrets Rotation Runbook](docs/runbooks/secrets-rotation.md) for:

- Rotation intervals for each secret
- Step-by-step procedures for JWT_SECRET, STELLAR_HOT_WALLET_SECRET, GOOGLE_CLIENT_SECRET, WEBHOOK_SECRET, DATABASE_URL, SESSION_INTEGRITY_KEY, PHONE_HASH_SALT, and TWILIO_AUTH_TOKEN
- Monitoring and rollback procedures

## Security Practices

### In-App

- All user data is encrypted at rest using industry-standard TLS 1.3
- Session tokens are signed with `JWT_SECRET` and expire after 24 hours
- Admin actions are logged in an immutable audit log
- Users must verify their phone number and email before accessing certain features

### Infrastructure

- Secrets are stored in a secure vault (not in version control)
- The CI/CD pipeline enforces secrets scanning via gitleaks
- All deployments are signed and verified
- Access to production is restricted to authorized team members only

### Dependencies

- Dependencies are scanned for known vulnerabilities on every commit
- Security updates are applied within 7 days of release
- Major dependencies are audited annually by a third-party security firm

## Code Review and Testing

All code changes undergo:

- Peer review by at least one maintainer
- Automated security linting (ESLint, clippy, etc.)
- Type checking (TypeScript, Rust)
- Unit and integration test coverage

## Questions?

For security-related questions, contact [security@brandblitz.app](mailto:security@brandblitz.app).
