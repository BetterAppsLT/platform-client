/**
 * @betterapps/platform-client — drop-in replacement for @heymantle/client.
 *
 * Migration from Mantle in an app is mechanical:
 *   - new MantleClient({ appId, apiKey })            → new PlatformClient({ appId, apiKey })
 *   - new MantleClient({ appId, customerApiToken })  → new PlatformClient({ appId, customerApiToken })
 *   - identify(payload)        → identify(payload)          (same payload keys, returns { apiToken })
 *   - getCustomer()            → getCustomer()              (subscription.active, plans, usage, features)
 *   - subscribe({...})         → subscribe({...})           (returns { confirmationUrl } when approval needed)
 *   - cancelSubscription()     → cancelSubscription()
 *   - sendUsageEvent({...})    → sendUsageEvent({...})
 * Errors are returned as { error } objects, never thrown — same convention the apps'
 * isMantleError() guard expects (rename the guard, keep the shape).
 *
 * `shadow: true` puts the client in shadow-testing mode: all methods run fire-and-safe
 * (network/API errors are swallowed and reported as no-ops) so an app can dual-write to
 * this platform while Mantle remains the live source of truth. See docs/shadow-testing.md.
 */

export interface PlatformClientOptions {
  appId: string;
  /** Server-side API key. NEVER ship to the browser. */
  apiKey?: string;
  /** Customer-scoped token from identify() — safe for frontend use. */
  customerApiToken?: string;
  apiUrl?: string;
  shadow?: boolean;
}

export interface PlatformError {
  error: string;
}

export function isPlatformError(res: unknown): res is PlatformError {
  return typeof res === "object" && res !== null && "error" in res &&
    typeof (res as PlatformError).error === "string";
}

export interface IdentifyPayload {
  platform?: "shopify";
  myshopifyDomain: string;
  platformId?: string | null;
  email?: string | null;
  name?: string | null;
  accessToken?: string | null;
  customFields?: Record<string, unknown>;
  tags?: string[];
  createdAt?: string | Date | null;
  test?: boolean;
  /** Accepted for Mantle-payload compatibility; ignored. */
  merge?: boolean;
  rotateApiToken?: boolean;
}

export interface CustomerFeature {
  name: string;
  type: "boolean" | "limit";
  enabled: boolean;
  limit: number | null;
  used: number | null;
}

export interface CustomerPlan {
  id: string;
  name: string;
  description: string | null;
  amount: number;
  currencyCode: string;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  trialDays: number;
  features: Record<string, string>;
  /** Mantle-compat fields present on the wire (customer/response.ts). */
  presentmentAmount?: number;
  metadata?: Record<string, any>;
}

export interface Customer {
  id: string;
  test: boolean;
  myshopifyDomain: string;
  name: string | null;
  email: string | null;
  installedAt: string | null;
  uninstalledAt: string | null;
  customFields: Record<string, unknown>;
  tags: string[];
  plans: CustomerPlan[];
  subscription: {
    id: string;
    active: boolean;
    status: string;
    plan: {
      id: string;
      name: string;
      presentmentAmount?: number;
      metadata?: Record<string, any>;
      description?: string | null;
    };
    amount: number;
    currencyCode: string;
    interval: string;
    trialEndsAt: string | null;
    activatedAt: string | null;
    currentCycleStart: string | null;
    currentCycleEnd: string | null;
    /** Mantle-compat fields present on the wire (customer/response.ts). */
    trialExpiresAt?: string | null;
    cancelOn?: string | null;
    currentPeriodEnd?: string | null;
    usageChargeCappedAmount?: number | null;
  } | null;
  features: Record<string, CustomerFeature>;
  usage: Record<string, { count: number; valueSum: number }>;
}

export interface SubscribeResult {
  subscriptionId: string;
  confirmationUrl: string | null;
}

export * from "./shadow.js";

const DEFAULT_API_URL = "https://platform.betterapps.pro";

export class PlatformClient {
  private readonly opts: Required<Pick<PlatformClientOptions, "appId" | "apiUrl" | "shadow">> &
    Pick<PlatformClientOptions, "apiKey" | "customerApiToken">;

  constructor(options: PlatformClientOptions) {
    if (!options.appId) throw new Error("PlatformClient: appId is required");
    if (!options.apiKey && !options.customerApiToken) {
      throw new Error("PlatformClient: apiKey or customerApiToken is required");
    }
    this.opts = {
      appId: options.appId,
      apiKey: options.apiKey,
      customerApiToken: options.customerApiToken,
      apiUrl: options.apiUrl ?? DEFAULT_API_URL,
      shadow: options.shadow ?? false,
    };
  }

  get shadowMode(): boolean {
    return this.opts.shadow;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T | PlatformError> {
    const url = new URL(path, this.opts.apiUrl);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    headers["x-ba-app-id"] = this.opts.appId;
    if (this.opts.apiKey) headers["x-ba-api-key"] = this.opts.apiKey;
    if (this.opts.customerApiToken) headers["x-ba-customer-token"] = this.opts.customerApiToken;
    // Shadow mode: billing commands are recorded as shadow events server-side and
    // never reach the billing provider (docs/shadow-testing.md).
    if (this.opts.shadow) headers["x-ba-shadow"] = "1";

    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return { error: typeof json["error"] === "string" ? (json["error"] as string) : `HTTP ${res.status}` };
      }
      return json as T;
    } catch (err) {
      return { error: `network: ${String(err)}` };
    }
  }

  /** In shadow mode, never let a platform failure surface into the host app. */
  private shadowSafe<T>(result: T | PlatformError, fallback: T): T | PlatformError {
    if (this.opts.shadow && isPlatformError(result)) return fallback;
    return result;
  }

  async identify(payload: IdentifyPayload): Promise<{ apiToken: string } | PlatformError> {
    const res = await this.request<{ apiToken: string }>("POST", "/v1/identify", payload);
    return this.shadowSafe(res, { apiToken: "" });
  }

  async getCustomer(params?: {
    customerId?: string;
    myshopifyDomain?: string;
  }): Promise<Customer | PlatformError> {
    return this.request<Customer>("GET", "/v1/customer", undefined, {
      customerId: params?.customerId,
      myshopifyDomain: params?.myshopifyDomain,
    });
  }

  async subscribe(params: {
    planId: string;
    returnUrl: string;
    discountCode?: string | null;
    /** Mantle-compat alias for discountCode-by-id flows; resolved server-side. */
    discountId?: string | null;
    customerId?: string;
    myshopifyDomain?: string;
    /** Accepted for Mantle-payload compatibility; trials come from the plan. */
    trialDays?: number;
  }): Promise<SubscribeResult | PlatformError> {
    return this.request<SubscribeResult>("POST", "/v1/subscriptions", {
      planId: params.planId,
      returnUrl: params.returnUrl,
      discountCode: params.discountCode ?? params.discountId ?? null,
      customerId: params.customerId,
      myshopifyDomain: params.myshopifyDomain,
    });
  }

  /**
   * §4 activation round-trip: after the merchant approves the charge and Shopify redirects
   * back to the app's returnUrl, call this so the platform re-queries Shopify and flips the
   * pending subscription active. Idempotent — safe to call more than once.
   */
  async confirmSubscription(
    subscriptionId: string,
    params?: { customerId?: string; myshopifyDomain?: string },
  ): Promise<{ subscriptionId: string; activated: boolean } | PlatformError> {
    return this.request(
      "POST",
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/confirm`,
      undefined,
      { customerId: params?.customerId, myshopifyDomain: params?.myshopifyDomain },
    );
  }

  async cancelSubscription(params?: {
    customerId?: string;
    myshopifyDomain?: string;
  }): Promise<{ ok: boolean; canceled: string | null } | PlatformError> {
    return this.request("DELETE", "/v1/subscriptions", undefined, {
      customerId: params?.customerId,
      myshopifyDomain: params?.myshopifyDomain,
    });
  }

  async sendUsageEvent(params: {
    eventId?: string | null;
    eventName: string;
    customerId?: string;
    myshopifyDomain?: string;
    properties?: Record<string, unknown>;
    occurredAt?: string | Date;
  }): Promise<{ ok: boolean } | PlatformError> {
    const res = await this.request<{ ok: boolean }>("POST", "/v1/usage_events", params);
    return this.shadowSafe(res, { ok: true });
  }

  async sendUsageEvents(
    events: Array<{
      eventId?: string | null;
      eventName: string;
      customerId?: string;
      myshopifyDomain?: string;
      properties?: Record<string, unknown>;
      occurredAt?: string | Date;
    }>,
  ): Promise<{ ok: boolean } | PlatformError> {
    const res = await this.request<{ ok: boolean }>("POST", "/v1/usage_events", { events });
    return this.shadowSafe(res, { ok: true });
  }

  /** Server-computed entitlement check for one feature key. */
  async checkFeature(
    key: string,
    params?: { customerId?: string; myshopifyDomain?: string },
  ): Promise<{ key: string; enabled: boolean; limit: number } | PlatformError> {
    return this.request("GET", `/v1/features/${encodeURIComponent(key)}`, undefined, {
      customerId: params?.customerId,
      myshopifyDomain: params?.myshopifyDomain,
    });
  }

  /** Client-side helpers matching Mantle's isFeatureEnabled/limitForFeature pattern. */
  static isFeatureEnabled(customer: Customer, key: string): boolean {
    const f = customer.features[key];
    if (!f) return false;
    if (f.type === "boolean") return f.enabled;
    if (f.limit === -1) return true;
    return (f.limit ?? 0) > (f.used ?? 0);
  }

  static limitForFeature(customer: Customer, key: string): number {
    const f = customer.features[key];
    return f?.type === "limit" ? (f.limit ?? 0) : 0;
  }
}
