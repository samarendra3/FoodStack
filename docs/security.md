# FoodStack — Security & Reliability

## Production security checklist

### OWASP / general

- [ ] OWASP ASVS L2 as baseline; OWASP Top 10 reviewed per release
- [ ] Threat model per module (STRIDE) for auth, payments, sync, public QR
- [ ] Dependency scanning (Dependabot/Renovate + `pnpm audit`), SAST (CodeQL), container scanning (Trivy), secret scanning in CI
- [ ] Security headers via Helmet (HSTS, CSP with nonces in Next.js, X-Content-Type-Options, Referrer-Policy, frame-ancestors none)
- [ ] Pen test before GA and annually

### Input validation

- [ ] All DTOs validated (Zod schemas shared in `packages/validators`, NestJS validation pipe, `whitelist` + `forbidNonWhitelisted`)
- [ ] Strict types for money (integers), ids (UUID), enums; max lengths and array sizes
- [ ] File uploads: presigned S3, MIME sniffing, size limits, image re-encoding, no public buckets

### SQL injection

- [ ] TypeORM parameterized queries only; raw SQL only with bound parameters; lint rule bans string-concatenated queries
- [ ] Least-privilege DB roles; app role without DDL and without BYPASSRLS

### XSS / CSRF

- [ ] React escaping, no `dangerouslySetInnerHTML` without DOMPurify, strict CSP
- [ ] Access tokens in memory; refresh cookie `HttpOnly`, `Secure`, `SameSite=Strict`, path-scoped
- [ ] CSRF: SameSite + Origin/Referer check + custom header on cookie-authenticated endpoints
- [ ] CORS allow-list per environment

### Rate limiting & abuse

- [ ] Redis sliding-window limits: per IP, per user, per tenant; stricter on login, OTP, public QR, webhooks
- [ ] AWS WAF managed rules, bot control on public QR app
- [ ] Request size limits, timeouts, `statement_timeout` in DB

### Authentication & passwords

- [ ] Argon2id, breached password checks, MFA for privileged roles, lockout & alerting
- [ ] JWT short TTL, refresh rotation with reuse detection, JWKS key rotation
- [ ] Device registration for POS/KDS; remote revoke

### Authorization

- [ ] Deny-by-default guards; every controller method has `@RequirePermission` or `@Public` (CI check)
- [ ] Tenant RLS + branch scope checks; cross-tenant test suite
- [ ] Impersonation audited and time-boxed

### Audit logging

- [ ] Append-only `audit_logs` (no UPDATE/DELETE privilege), before/after diff for sensitive entities
- [ ] Logged events: login/logout/failures, permission changes, price changes, discounts, voids, invoice void, credit notes, refunds, cash drawer variance, settings changes, data exports, impersonation
- [ ] Logs exported to S3 with Object Lock (WORM) for tamper evidence

### Backup & recovery

- [ ] RDS Multi-AZ, PITR 35 days, daily snapshots copied cross-region, encrypted
- [ ] RPO ≤ 5 min, RTO ≤ 1 h targets; quarterly restore drills documented
- [ ] Redis treated as non-authoritative (BullMQ jobs reconstructable from outbox)
- [ ] S3 versioning + lifecycle; IaC to rebuild environments

### Payment security

- [ ] **Never store card data (PAN/CVV)**; use gateway-hosted fields / tokenization / external terminals → PCI DSS SAQ-A / SAQ-A-EP scope
- [ ] Webhook signature verification, replay protection (timestamp + event id uniqueness)
- [ ] Idempotency keys on payment and refund creation
- [ ] Amount validated server-side against invoice; refunds ≤ captured − refunded (row lock)
- [ ] Daily reconciliation job against gateway settlement reports

### Data encryption & privacy

- [ ] TLS 1.2+ everywhere (ALB, RDS, ElastiCache in-transit encryption)
- [ ] At rest: RDS/S3/ElastiCache with KMS keys; sensitive columns (customer phone/email, tax IDs, gateway credentials) additionally encrypted at application level (envelope encryption) with blind index for lookup
- [ ] Secrets in AWS Secrets Manager; no secrets in env files committed
- [ ] PII redaction in logs; data retention policies; GDPR / India DPDP Act: consent, export, erasure (anonymisation)

### Reliability

- [ ] Health checks (liveness/readiness), graceful shutdown (drain sockets and jobs)
- [ ] Circuit breakers + timeouts for gateways and messaging providers
- [ ] SLOs: API p95 < 300 ms, availability 99.9 %, KDS event latency < 1 s
- [ ] Alerts: error rate, latency, queue depth, DLQ size, sync backlog per device, DB CPU/connections, replication lag
- [ ] Incident runbooks and status page
