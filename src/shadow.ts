import { PlatformClient, isPlatformError, type Customer, type IdentifyPayload } from "./index.js";

/**
 * Runtime shadow comparison: the app calls Mantle as usual AND passes Mantle's response
 * here; the reporter makes the equivalent platform call, diffs the answers, and emits a
 * mismatch log. Everything is fire-and-safe — a platform failure or mismatch can never
 * affect the host app's behavior.
 *
 * Usage in an app (next to the existing Mantle call):
 *   const shadow = createShadowReporter({
 *     client: new PlatformClient({ appId, apiKey, shadow: true }),
 *     onMismatch: (m) => logger.warn("platform.shadow_mismatch", m),
 *   });
 *   const mantleCustomer = await mantleClient.getCustomer();       // unchanged
 *   void shadow.compareCustomer(mantleCustomer, { myshopifyDomain: shop }); // added
 */

export interface ShadowMismatch {
  method: string;
  myshopifyDomain: string | null;
  field: string;
  mantle: unknown;
  platform: unknown;
}

export interface ShadowReporterOptions {
  client: PlatformClient;
  /** Defaults to console.warn with a stable prefix (greppable in Loki). */
  onMismatch?: (mismatch: ShadowMismatch) => void;
  /** Also called when the shadow call itself errored (visibility, not failure). */
  onShadowError?: (method: string, error: string) => void;
}

/** The subset of Mantle's customer shape the comparison relies on. */
export interface MantleCustomerLike {
  subscription?: {
    active?: boolean;
    plan?: { name?: string | null } | null;
  } | null;
  test?: boolean;
}

export interface ShadowReporter {
  /** Mirror an identify() so the platform tracks the same shops Mantle does. */
  mirrorIdentify(payload: IdentifyPayload): Promise<void>;
  /** Mirror a usage event 1:1. */
  mirrorUsageEvent(params: {
    eventId?: string | null;
    eventName: string;
    myshopifyDomain: string;
    properties?: Record<string, unknown>;
  }): Promise<void>;
  /** Compare Mantle's getCustomer() answer against the platform's, log mismatches. */
  compareCustomer(
    mantleCustomer: MantleCustomerLike | null | undefined,
    params: { myshopifyDomain?: string; customerId?: string },
  ): Promise<ShadowMismatch[]>;
}

export function createShadowReporter(options: ShadowReporterOptions): ShadowReporter {
  const onMismatch =
    options.onMismatch ??
    ((m: ShadowMismatch) => console.warn("[platform-shadow] mismatch", JSON.stringify(m)));
  const onShadowError =
    options.onShadowError ??
    ((method: string, error: string) =>
      console.warn("[platform-shadow] shadow call failed", JSON.stringify({ method, error })));

  return {
    async mirrorIdentify(payload) {
      try {
        const res = await options.client.identify(payload);
        if (isPlatformError(res)) onShadowError("identify", res.error);
      } catch (err) {
        onShadowError("identify", String(err));
      }
    },

    async mirrorUsageEvent(params) {
      try {
        const res = await options.client.sendUsageEvent(params);
        if (isPlatformError(res)) onShadowError("sendUsageEvent", res.error);
      } catch (err) {
        onShadowError("sendUsageEvent", String(err));
      }
    },

    async compareCustomer(mantleCustomer, params) {
      const mismatches: ShadowMismatch[] = [];
      const domain = params.myshopifyDomain ?? null;
      let platformCustomer: Customer;
      try {
        const res = await options.client.getCustomer(params);
        if (isPlatformError(res)) {
          onShadowError("getCustomer", res.error);
          return mismatches;
        }
        platformCustomer = res;
      } catch (err) {
        onShadowError("getCustomer", String(err));
        return mismatches;
      }

      const emit = (field: string, mantle: unknown, platform: unknown): void => {
        const m: ShadowMismatch = {
          method: "getCustomer",
          myshopifyDomain: domain,
          field,
          mantle,
          platform,
        };
        mismatches.push(m);
        try {
          onMismatch(m);
        } catch {
          /* reporter must never throw into the app */
        }
      };

      const mantleActive = mantleCustomer?.subscription?.active === true;
      const platformActive = platformCustomer.subscription?.active === true;
      if (mantleActive !== platformActive) {
        emit("subscription.active", mantleActive, platformActive);
      }

      const mantlePlan = mantleCustomer?.subscription?.plan?.name ?? null;
      const platformPlan = platformCustomer.subscription?.plan.name ?? null;
      if (mantleActive && platformActive && mantlePlan !== platformPlan) {
        emit("subscription.plan", mantlePlan, platformPlan);
      }

      return mismatches;
    },
  };
}
