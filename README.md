# @betterapps/platform-client

Drop-in client for the BA platform (Mantle-compatible API surface). Canonical home of the
SDK previously developed at `ba-dashboard/packages/sdk`.

Migration from `@heymantle/client` is mechanical: same constructor split (`apiKey`
server-side / `customerApiToken` frontend-safe), same method names (`identify`,
`getCustomer`, `subscribe`, `cancelSubscription`, `sendUsageEvent`), same `{ error }`
return convention (`isMantleError` → `isPlatformError`, shape unchanged). The
`/v1/customer` wire response is Mantle-shaped (`presentmentAmount`, `metadata`,
`trialExpiresAt`, `cancelOn`, `currentPeriodEnd`, `usageChargeCappedAmount`), so
consumers of Mantle's `getCustomer()` keep working.

Additions over Mantle's client:

- `confirmSubscription(subscriptionId, { myshopifyDomain })` — the §4 activation
  round-trip. Call it from the app route Shopify redirects back to after charge approval;
  the platform re-queries Shopify and flips the pending subscription active. A paid
  subscribe that never confirms stays `pending` forever.
- `shadow: true` constructor option — every method runs fire-and-safe for dual-write
  shadow testing while Mantle stays the live source of truth.

## Install

```bash
npm install github:BetterAppsLT/platform-client#v0.2.0
```

`prepare` builds `dist/` on install; no registry or token needed.

## Auth headers

`x-ba-app-id` + `x-ba-api-key` (server) or `x-ba-customer-token` (customer-scoped,
returned by `identify` — analogous to Mantle's `customerApiToken`).
