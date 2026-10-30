# FoodStack — Authentication

## 1. Identity model

- `users` are global identities; access to a tenant is through `tenant_memberships`. One person can own two restaurant companies or work for a franchisee and the franchisor.
- `platform_users` (super admins) are a **separate** identity store and token audience (`aud=platform`), with mandatory MFA and IP allow-listing.
- Customers using QR ordering are not users; they get short-lived **guest session tokens** bound to a table session (optional phone OTP to link a `customers` record).

## 2. Login methods

| Method                 | Who                                                 | Notes                                                                                                                       |
| ---------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Email/phone + password | Owners, admins, managers, accountants               | Argon2id hashes; MFA (TOTP) required for Owner/Admin, optional for others (tenant policy)                                   |
| Staff PIN              | Cashier, waiter, kitchen on a **registered device** | PIN (4–6 digits, Argon2id) is valid only together with a device token; lockout after 5 failures; fast user switching on POS |
| Device registration    | POS/KDS/Waiter devices                              | Manager approves the device once → long-lived device credential (rotatable, revocable) stored in secure storage             |
| OTP                    | Guests, password-less option                        | Rate-limited, 6 digits, 5-minute TTL, hashed in Redis                                                                       |
| SSO (later)            | Enterprise chains                                   | OIDC/SAML per tenant                                                                                                        |

## 3. Tokens

- **Access token:** JWT, EdDSA (Ed25519) or RS256 signed, 15 minutes. Claims: `sub` (user), `tid` (tenant), `mid` (membership), `sid` (session), `did` (device, optional), `aud` (`tenant`/`platform`/`guest`), `pv` (permission version). Permissions are **not** embedded (kept small); resolved server-side and cached in Redis by `mid:pv`.
- **Refresh token:** opaque 256-bit random value, stored hashed (SHA-256) in `sessions`, 30 days sliding (POS devices: 90 days), **rotated on every use** with _reuse detection_: if an already-used token is presented, the whole token family is revoked and a security event is raised.
- Web apps: refresh token in `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`; access token kept **in memory only** (not localStorage). CSRF on refresh endpoint mitigated by SameSite + custom header requirement + Origin check.
- PWA devices (POS offline): refresh token kept in IndexedDB encrypted with a non-extractable WebCrypto key; offline operation does not require a valid access token — it uses a locally cached, signed **offline grant** (see `offline-pos.md`).
- Key rotation: JWKS with `kid`; keys in AWS KMS/Secrets Manager; rotate quarterly.

## 4. Session management

- `sessions` row per login (device, IP, user agent, last_seen). Users and admins can list/revoke sessions.
- Revocation is immediate: `sid` checked against a Redis deny-list (TTL = access token lifetime) on each request.
- Role/permission change increments `permission_version` → cached permissions invalidated; next request uses new permissions.
- Suspended tenant or membership → all its sessions revoked; subscription lapse → read-only mode (configurable grace period) rather than lock-out, so restaurants can still see data.
- Idle timeout per app: Admin 30 min idle (configurable), POS stays logged in on device but requires PIN after inactivity.

## 5. Tenant switching

`POST /auth/switch-tenant { tenantId }` → validates membership → new session token pair with new `tid`. Frontend clears all query caches on switch.

## 6. Password & account security

Argon2id (memory ≥ 64 MB, t=3), breached-password check (k-anonymity HIBP), min length 10, rate limit on login by IP + account, progressive delays, account lockout notification, email verification, password reset tokens single-use 30 min hashed.
