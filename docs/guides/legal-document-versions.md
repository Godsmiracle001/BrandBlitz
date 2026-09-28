# Legal Document Versions Guide

## Overview

BrandBlitz maintains versioned legal documents (Terms of Service, Privacy Policy) accessible through standardized API endpoints. This guide explains how to view current and historical versions, why versioning matters, and how to check which version a user accepted.

## Document Types

The system currently supports the following legal document types:

- `tos` - Terms of Service
- `privacy` - Privacy Policy

These types are defined in `apps/api/src/routes/legal.ts` and correspond to the `:type` parameter in API routes.

## API Endpoints

### Get Current Version

Retrieve the latest version of a legal document:

```
GET /legal/:type/current
```

**Examples:**
- Terms of Service: `GET /legal/tos/current`
- Privacy Policy: `GET /legal/privacy/current`

**Response:**
```json
{
  "type": "tos",
  "version": "2024-01-15",
  "content": "...",
  "effectiveDate": "2024-01-15T00:00:00Z"
}
```

### Get Specific Version

Retrieve a specific historical version:

```
GET /legal/:type/:version
```

**Examples:**
- Old ToS: `GET /legal/tos/2023-06-01`
- Old Privacy Policy: `GET /legal/privacy/2023-12-15`

**Response:**
```json
{
  "type": "tos",
  "version": "2023-06-01",
  "content": "...",
  "effectiveDate": "2023-06-01T00:00:00Z"
}
```

### Check User Acceptance Status

View which version a user has accepted:

```
GET /legal/status
```

**Response:**
```json
{
  "tos": {
    "accepted": true,
    "version": "2024-01-15",
    "acceptedAt": "2024-01-20T10:30:00Z"
  },
  "privacy": {
    "accepted": true,
    "version": "2024-01-15",
    "acceptedAt": "2024-01-20T10:30:00Z"
  }
}
```

### Accept a Document

Record acceptance of the current version:

```
POST /legal/accept
Content-Type: application/json

{
  "type": "tos",
  "version": "2024-01-15"
}
```

## Why Versioning Matters

### Legal Compliance
Legal documents change over time to reflect new regulations, business practices, or user protections. Tracking which version a user accepted:

1. **Proves Consent** - Demonstrates the user agreed to specific terms at a specific time
2. **Audit Trail** - Provides evidence of compliance for legal disputes or regulatory audits
3. **Version Control** - Allows users to reference the exact terms they agreed to
4. **Change Management** - Enables notifying users when terms change and requiring re-acceptance

### User Transparency
Users have the right to know:
- What terms they agreed to
- When terms change
- How changes affect their relationship with the platform

## How to Find Your Accepted Version

### As a User

1. **Check your acceptance status:**
   - Visit: `https://api.brandblitz.com/legal/status` (requires authentication)
   - View the `version` field for each document type

2. **View the document you accepted:**
   - Use the version from step 1
   - Visit: `https://api.brandblitz.com/legal/tos/{version}`
   - Or: `https://api.brandblitz.com/legal/privacy/{version}`

3. **Example workflow:**
   ```bash
   # 1. Get your acceptance status
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.brandblitz.com/legal/status

   # Response shows you accepted ToS version "2024-01-15"

   # 2. View that specific version
   curl https://api.brandblitz.com/legal/tos/2024-01-15
   ```

### In the Web Application

The legal document pages display the current version with links to historical versions:

- **Terms of Service**: `/legal/tos`
- **Privacy Policy**: `/legal/privacy`

Each page includes:
- Current version number
- Effective date
- Link to view other versions
- Your acceptance status (if logged in)

## Version Format

Versions use ISO 8601 date format: `YYYY-MM-DD`

Examples:
- `2024-01-15`
- `2023-12-01`
- `2024-03-20`

This format ensures:
- Chronological sorting
- Clear identification of when changes were made
- Easy comparison between versions

## Common Scenarios

### Scenario 1: User Signs Up
1. User is shown the current version during registration
2. User accepts by clicking "I agree"
3. System records: `{ type: "tos", version: "2024-01-15", acceptedAt: "2024-01-20..." }`
4. User can later reference this via `/legal/tos/2024-01-15`

### Scenario 2: Terms Are Updated
1. New version `2024-06-01` is published
2. Existing users see notification of changes
3. Users must accept new version to continue
4. System updates acceptance record: `{ type: "tos", version: "2024-06-01", acceptedAt: "2024-06-05..." }`
5. Old version remains accessible: `/legal/tos/2024-01-15`

### Scenario 3: User Reviews Past Terms
1. User wants to check what they agreed to 6 months ago
2. User calls `GET /legal/status` to see accepted version
3. User retrieves that version: `GET /legal/tos/2024-01-15`
4. User compares with current: `GET /legal/tos/current`

## Technical Implementation

### Database Schema
Acceptances are stored in the `legal_acceptances` table:
```sql
CREATE TABLE legal_acceptances (
  user_id UUID NOT NULL,
  document_type VARCHAR(50) NOT NULL,
  version VARCHAR(50) NOT NULL,
  accepted_at TIMESTAMP NOT NULL,
  ip_address INET,
  PRIMARY KEY (user_id, document_type)
);
```

### Version Storage
Document versions are stored in the `legal_documents` table:
```sql
CREATE TABLE legal_documents (
  type VARCHAR(50) NOT NULL,
  version VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  effective_date TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  PRIMARY KEY (type, version)
);
```

## Best Practices

### For Platform Administrators
1. **Never delete old versions** - They may be needed for legal disputes
2. **Use meaningful version dates** - Match the effective date
3. **Document changes** - Maintain a changelog of what changed between versions
4. **Notify users** - Email users when terms change significantly
5. **Archive old versions** - Keep them accessible but mark as historical

### For Developers
1. **Always use the API** - Don't hardcode document content
2. **Cache appropriately** - Documents don't change often
3. **Handle errors** - Version may not exist
4. **Display version info** - Show users which version they're viewing
5. **Link to acceptance** - Allow users to easily check their status

## Related Documentation

- [Legal Compliance Guide](../docs/06-legal-compliance.md)
- [API Documentation](../docs/api/)
- [Database Schema](../docs/DATABASE.md)

## Support

For questions about legal document versions:
- Technical: Review `apps/api/src/routes/legal.ts`
- Legal: Contact legal@brandblitz.com
- User support: support@brandblitz.com
