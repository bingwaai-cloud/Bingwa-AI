# Payments Callback Regression — 3 red tests (pre-existing)

**Discovered:** WP-16 gate (99d8dbc)
**Status:** Acknowledged — NOT caused by WP-16
**Failing suite:** `tests/integration/payments.test.ts`

## Failing assertions

All three in `describe('POST /api/payments/callback')`:

1. **`activates subscription on SUCCESSFUL callback`** (line 331)
   - `expect(tx?.status).toBe('successful')` → received `'pending'`
   - After posting SUCCESSFUL callback, the transaction status is not updated
     by `handleMomoCallback` within the 200ms wait.

2. **`marks transaction failed on FAILED callback and notifies user`** (line 358)
   - `expect(tx?.status).toBe('failed')` → received `'pending'`
   - Same symptom: callback processed but status unchanged.

3. **`is idempotent — duplicate SUCCESSFUL callback does not double-activate`** (line 384)
   - `expect(mockedSend).toHaveBeenCalledTimes(1)` → received 2
   - Because the first callback didn't actually change the status (still
     "pending"), the idempotency guard `if (transaction.status !== 'pending')`
     doesn't trigger, and `sendTextMessage` fires on both calls.

## Root cause hypothesis

`handleMomoCallback` runs inside `setImmediate` in the controller. The async
path resolves correctly (it logs no errors), but the `updatePaymentStatus` call
inside `withTenant` may be silently failing, or the `200ms` delay in the test
is insufficient for the `setImmediate` + `withTenant` + DB round-trip chain
(Prisma client connection, etc.).

## Additional symptom

```
A worker process has failed to exit gracefully and has been force exited.
```

Likely an unclosed connection in the payments test (possibly `handleProviderWebhook`
spawning `setImmediate` callbacks that outlive the process). Worth running with
`--detectOpenHandles` on a separate investigation.

## Proof WP-16 did NOT introduce this

```
$ git diff 794395b..99d8dbc --stat
 backend/db/migrations/018_branch_id.sql |  33 +++++++
 backend/db/schema.prisma                |   2 +
 backend/tests/globalSetup.cjs           |   1 +
 docs/ledger-design-note.md              | 158 ++++++++++
```

Zero lines changed in any `.ts` source or test file. Zero changes to payment
controllers, services, repositories, middleware, or test files.

Last commit touching payment test code: `74775bd` (WP-13: move WhatsApp adapter
under channels). Last commit touching payment service/repository: `83d3894`
(WP-11: Payment reconciliation + dunning). Both are ancestors of 794395b.

## Recommended fix

File as a separate bug ticket. Likely needs `--detectOpenHandles` to confirm
the teardown leak, then diagnose why `handleMomoCallback`'s DB writes aren't
committing before the test's 200ms poll expires (or why they fail silently).