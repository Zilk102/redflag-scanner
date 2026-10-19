# Project audit

Audit date: 2026-10-19. Scope: whole repository (server, client, deploy config, git history).
Method: code review of the security-relevant paths (auth, CSRF, payments, webhooks, AI service), `npm audit`, secret scan of the working tree and all 49 commits, client typecheck, and a live run (Postgres, server, client, a mock YandexGPT) with a scripted browser to capture the screenshots.

## Summary

RedFlag Scanner is a surprisingly complete product for a solo AI-assisted build: SEO landing pages, OCR, paid reports with a server-side paywall, shareable OG images, PDF export, a privacy-conscious data model (consent, anonymization, auto-delete) and a careful auth layer (HTTP-only cookies, CSRF with Origin check, rate limits, timing-safe comparisons). The weaknesses are maintainability (a 5,400-line `index.js`, a 2,400-line `App.tsx`), no tests, and one payment-flow gap that is fixed below.

## Fixed during this audit

| # | Issue | Severity | Fix |
|---|---|---|---|
| 1 | **Payment webhook could be forged.** The YooKassa handler trusts the request body (event, amount, `metadata.scanId`). With neither `PAYMENT_WEBHOOK_TOKEN` nor `PAYMENT_WEBHOOK_ALLOWED_CIDRS` set, anyone could POST a fake `payment.succeeded` and unlock a paid report for free. | High | In production the webhook now rejects requests unless at least one of the two protections is configured. |
| 2 | `docker-compose.yml` published Postgres on all interfaces (`5432:5432`) with default credentials from `.env.example`. | High on a public VPS | Bound to `127.0.0.1`. |
| 3 | The original operator's full name, tax ID and email were hardcoded in `offer.html`, `privacy.html` and `App.tsx`. | Privacy | Replaced with placeholders (see the note on history below). |
| 4 | `README` and `.env.example` disagreed on webhook variable names (`YOOKASSA_WEBHOOK_*` vs the real `PAYMENT_WEBHOOK_*`), which made the protection in #1 easy to misconfigure. | Medium | Docs corrected. |
| 5 | Generated files (`*.tsbuildinfo`, `vite.config.js`, `vite.config.d.ts`), a domain-verification file for a dead domain, and absolute `file:///D:/...` links were tracked. | Low | Untracked, ignored, links made relative. |

## Secrets and history

- No API keys, tokens or private keys found in the working tree or in the history. `.env` was never committed (`.env.example` contains only empty values and local defaults).
- The first commit included `client/node_modules` and `server/node_modules` (about 78 MB of `.git`). That is bloat, not a leak, but it makes the repository heavy to clone.
- The operator's name, tax ID and email exist in earlier commits (see fix #3). Cleaning the working tree does not remove them from history.

## Open issues (not fixed)

### Security
- **The webhook still trusts the request body.** The robust fix is to re-fetch the payment from the YooKassa API (`GET /payments/{id}`) and compare status, amount and metadata with the stored scan instead of trusting the notification. It could not be tested here without real credentials.
- **CORS reflects any origin with credentials** when `CORS_ORIGIN` is empty (the default in compose). Cookies are `SameSite=Lax` and mutating routes require CSRF plus a same-origin check, which limits the damage, but the default should be a strict allowlist.
- Server image is `node:18-alpine`, which is end of life. `npm audit` reports 3 known advisories in the client and several in the server tree (`npm audit fix` resolves most).
- Raw chat text of users is stored in the database (`scans.text`). Retention and anonymization exist but are opt-in per request, and a real deployment would need at-rest encryption and a clear retention default.

### Engineering quality
- **No automated tests and no CI.** The money path (price, webhook idempotency, paywall redaction) is the first thing to cover.
- **Monolith files:** `server/src/index.js` (about 5,400 lines: routing, auth, payments, OG rendering, PDF, cron-like cleanup) and `client/src/App.tsx` (about 2,400 lines). Both should be split by feature.
- The server is plain CommonJS JavaScript without types or request-schema validation, while the client is strict TypeScript.
- Several overlapping concepts: `Scan` and `Analysis` are near-duplicate models and endpoints (`/api/scan`, `/api/analyze`, `/api/pay`, `/api/payment/create`), and `Robokassa` and `YooKassa` run in parallel.
- UI strings and prompts are hardcoded in Russian with no localization layer.

### Product and legal
- The product sends private conversations (third-party personal data) to a cloud LLM. The code handles consent and anonymization, but a real service would need a data-processing review for the specific jurisdiction.

## Strengths worth keeping
- Server-side redaction of unpaid results, so the paywall cannot be bypassed in the browser.
- Idempotent webhook processing through a `PaymentWebhookEvent` table and amount checks against a single price constant.
- Resilient LLM client: retries, circuit breaker, concurrency and rate limits, tolerant JSON extraction from model output.
- Strict session handling: hashed session tokens, `HttpOnly` cookies, CSRF tokens compared in constant time, startup validation of `SESSION_SECRET` length.
- Good SEO foundation for a solo project: 16 landing pages, sitemap, per-report OG images.

## Suggested next steps if the project is ever revived
1. Re-verify payments through the YooKassa API in the webhook, and add tests for the payment path.
2. Split `index.js` into routers and services, add request validation (zod), move to TypeScript.
3. Replace default-open CORS with an allowlist, upgrade the base image to a supported Node version, run `npm audit fix`.
4. Merge `Scan` and `Analysis`, and drop the payment provider you do not use.
5. Add CI (lint, typecheck, tests).
