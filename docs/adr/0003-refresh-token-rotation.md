# ADR 0003: Refresh-token rotation with reuse detection

**Status:** accepted

## Decision
- **Access token:** a 15-minute HS256 JWT (`sub`, `cid`, `role`). The algorithm is pinned on verify, which blocks `alg: none`, and issuer and audience are checked. The web app keeps it **in memory only**, never in localStorage, where any XSS could read it.
- **Refresh token:** 32 random bytes in an `httpOnly; SameSite=strict; Path=/api/auth` cookie. The database stores **only its SHA-256**, so a leaked database contains no usable tokens.
- **Rotation:** every refresh marks the old token `rotated_at` and issues a new one in the same `family_id`.
- **Reuse detection** follows the OAuth 2.0 Security BCP. If a token that has already been rotated is presented again, someone holds a copy: we revoke the **entire family**. That logs out both the attacker and the real user, who then has to log in again.
- **CSRF:** `SameSite=strict` already prevents cross-site sends. The refresh endpoint additionally requires `X-Requested-With: vetledger`, which can't be set cross-site without a CORS preflight that we never allow.
- **Same-origin deployment:** the SPA reaches the API through Vite's proxy, nginx, or a Vercel rewrite, so no CORS configuration exists at all.
- **Login timing:** argon2id (OWASP parameters) runs even for unknown emails, against a dummy hash, so response time doesn't reveal which emails exist.
- **Rate limiting:** login is limited per IP, stored in Redis so the limit holds across instances.

## Trade-off: concurrent refreshes
Two browser tabs refreshing at the same time would look like reuse. The client therefore funnels every refresh through **one in-flight promise**, and a unit test verifies this. Another option is a short grace period for the previous token; it was rejected because it widens the window an attacker could use.
