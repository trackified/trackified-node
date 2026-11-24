# Changelog

## 0.2.0

All changes are additive.

- T-3: `baseURL` accepts `https://api.trackified.net` or `https://api.trackified.net/v1`, with or without a trailing slash.
- T-4: `client.health()`.
- T-2: README states that `usage.get()` calls `GET /v1/account/usage`.
- T-5: `carriers.resolve(name)`; `Carrier` gains `aliases`, and `display_name` is documented (`displayName` deprecated).
  `trackings.create` documents free-text carrier names.
- T-6: `WebhookEvent` is a union keyed by `type` (`tracking.status_changed` carries `{tracking, previous_status, current_status}`);
  `Trackified.webhooks.trackingOf(event)`. `WebhookEvent<T>` still works for a custom data type.
- T-9: `SignatureVerificationError.reason` and `webhooks.verifyDetailed()` → `{ valid, reason? }`.
- T-10: verification takes a secret or a list of secrets and accepts any matching `v1`; `webhooks.rotateSecret(id, { expiresInHours })`.
- T-11: `webhooks.update(id, { url, eventTypes, enabled })`.
- T-12: `QuotaExceededError` (402) and `ConflictError` (409); `ConnectionError.code` is `"timeout"` or `"connection"`.
- T-13: `onRequest` / `onResponse` client options, called once per attempt.
- T-7 / T-8: `date` is deprecated (removed after 2027-06-01); `occurred_at` and the newest-first order of `events` are documented.

## 0.1.0

- First release: `Trackified` client covering all 21 API operations (trackings, carriers, webhooks,
  webhook deliveries, API keys, usage), auto-pagination, retries with backoff, typed errors,
  automatic idempotency keys and webhook signature verification. ESM + CommonJS with type declarations.
