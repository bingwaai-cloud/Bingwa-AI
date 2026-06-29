# Payments Callback Regression -- resolved by WP-17 greenfix

**Discovered:** WP-16 gate (99d8dbc)
**Status:** Resolved by WP-17 greenfix.
**Suite:** `tests/integration/payments.test.ts`

## What changed

WP-17 intentionally changed the legacy callback contract for security.md section 8: `handleMomoCallback` re-queries MTN with `getCollectionStatus()` and acts only on the authoritative provider status and amount. The public webhook body is now only a trigger.

The old red assertions expected callback-body auto-settle, which is no longer safe. `payments.test.ts` now mocks the provider GET response for each callback scenario:

- provider `SUCCESSFUL` + matching amount activates the subscription and marks the payment `successful`
- provider `FAILED` marks the payment `failed` and notifies the user
- duplicate provider-confirmed success is idempotent and sends one notification
- provider `SUCCESSFUL` + amount mismatch parks the row in `needs_review` and does not activate

## Resolution

No separate timing ticket remains. The previous symptoms were stale test contract plus missing provider re-query mocks, not a production requirement to trust webhook body status. The WP-17 forgery regression remains the critical proof: forged `{ status: "SUCCESSFUL" }` with provider `PENDING` does not activate a subscription.
