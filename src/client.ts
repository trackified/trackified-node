import { ConnectionError, errorFromResponse, parseRetryAfter, TrackifiedError } from "./errors.js";
import type {
  ApiKey,
  ApiKeyCreateParams,
  BulkResult,
  Carrier,
  CarrierCatalog,
  CarrierCatalogParams,
  CarrierDetection,
  CarrierResolution,
  CarrierValidationStatus,
  DeleteResult,
  Health,
  Page,
  PageParams,
  RequestOptions,
  RetrackResult,
  Tracking,
  TrackingCreateParams,
  TrackingListParams,
  TrackingUpdateParams,
  Usage,
  Webhook,
  WebhookCreateParams,
  WebhookDelivery,
  WebhookRotatedSecret,
  WebhookRotateSecretParams,
  WebhookTestResult,
  WebhookUpdateParams,
  WebhookWithSecret,
} from "./types.js";
import { VERSION } from "./version.js";
import { constructEvent, getCrypto, trackingOf, verify, verifyDetailed, webhookHelpers } from "./webhooks.js";

export interface RequestHookInfo {
  method: string;
  url: string;
  /** 1 for the first try, then 2, 3 ... for retries. */
  attempt: number;
  idempotencyKey: string | undefined;
}

export interface ResponseHookInfo extends RequestHookInfo {
  /** undefined when no response arrived. */
  status: number | undefined;
  requestId: string | undefined;
  idempotentReplayed: boolean;
  durationMs: number;
  /** The typed error for status >= 400 or a failed connection. */
  error?: TrackifiedError;
}

export interface ClientOptions {
  /** Defaults to the TRACKIFIED_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to TRACKIFIED_BASE_URL or https://api.trackified.net. */
  baseURL?: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeout?: number;
  /** Retries for network errors, 408, 429 and 5xx (default 2). */
  maxRetries?: number;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof fetch;
  /** Extra headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /** Called before each attempt. Errors it throws are ignored. */
  onRequest?: (info: RequestHookInfo) => void;
  /** Called after each attempt. Errors it throws are ignored. */
  onResponse?: (info: ResponseHookInfo) => void;
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestInit_ extends RequestOptions {
  query?: Query;
  body?: unknown;
  idempotent?: boolean;
}

function env(name: string): string | undefined {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  } catch {
    return undefined; // Deno without --allow-env
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Trackified {
  static readonly webhooks = webhookHelpers;
  static readonly VERSION = VERSION;

  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly trackings = new Trackings(this);
  readonly carriers = new Carriers(this);
  readonly webhooks = new Webhooks(this);
  readonly webhookDeliveries = new WebhookDeliveries(this);
  readonly apiKeys = new ApiKeys(this);
  readonly usage = new UsageResource(this);

  #apiKey: string;
  #fetch: typeof fetch;
  #headers: Record<string, string>;
  #onRequest: ClientOptions["onRequest"];
  #onResponse: ClientOptions["onResponse"];

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env("TRACKIFIED_API_KEY");
    if (!apiKey) {
      throw new TrackifiedError(
        "Missing API key: pass { apiKey } or set the TRACKIFIED_API_KEY environment variable.",
      );
    }
    this.#apiKey = apiKey;
    // Accept the host with or without /v1; paths below add /v1 themselves.
    this.baseURL = (options.baseURL ?? env("TRACKIFIED_BASE_URL") ?? "https://api.trackified.net")
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new TrackifiedError("No fetch available; pass { fetch } (Node >= 18 has it built in).");
    this.#fetch = f;
    this.#headers = options.defaultHeaders ?? {};
    this.#onRequest = options.onRequest;
    this.#onResponse = options.onResponse;
  }

  /** GET /v1/health: {status: "ok"}, or "degraded" with checks (503 raises APIError). */
  health(opts?: RequestOptions): Promise<Health> {
    return this.request("GET", "/v1/health", opts);
  }

  /** Low-level request. Resource methods are preferred. */
  async request<T>(method: string, path: string, init: RequestInit_ = {}): Promise<T> {
    const url = new URL(this.baseURL + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      "user-agent": `trackified-node/${VERSION}`,
      ...this.#headers,
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotent) {
      headers["idempotency-key"] = init.idempotencyKey ?? (await getCrypto()).randomUUID();
    }
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const maxRetries = init.maxRetries ?? this.maxRetries;
    const timeout = init.timeout ?? this.timeout;

    const hookBase = { method, url: url.href, idempotencyKey: headers["idempotency-key"] };
    const hook = <I>(fn: ((info: I) => void) | undefined, info: I) => {
      try {
        fn?.(info);
      } catch {
        // a throwing hook must never break the request
      }
    };

    for (let attempt = 0; ; attempt++) {
      hook(this.#onRequest, { ...hookBase, attempt: attempt + 1 });
      const started = Date.now();
      const controller = new AbortController();
      const onAbort = () => controller.abort(init.signal?.reason);
      init.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeout);
      let res: Response;
      try {
        res = await this.#fetch(url, { method, headers, body, signal: controller.signal });
      } catch (e) {
        const timedOut = controller.signal.aborted && !init.signal?.aborted;
        const error = timedOut
          ? new ConnectionError(`Request timed out after ${timeout} ms`, { cause: e, code: "timeout" })
          : new ConnectionError(`Connection error: ${(e as Error)?.message ?? e}`, {
              cause: e,
              code: "connection",
            });
        hook(this.#onResponse, {
          ...hookBase,
          attempt: attempt + 1,
          status: undefined,
          requestId: undefined,
          idempotentReplayed: false,
          durationMs: Date.now() - started,
          error,
        });
        if (init.signal?.aborted) throw e;
        if (attempt < maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onAbort);
      }

      const info = {
        ...hookBase,
        attempt: attempt + 1,
        status: res.status,
        requestId: res.headers.get("x-request-id") ?? undefined,
        idempotentReplayed: res.headers.get("idempotent-replayed") === "true",
      };
      if (res.ok) {
        const text = await res.text();
        hook(this.#onResponse, { ...info, durationMs: Date.now() - started });
        return (text ? JSON.parse(text) : null) as T;
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      const error = errorFromResponse(res.status, parsed, res.headers);
      hook(this.#onResponse, { ...info, durationMs: Date.now() - started, error });
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const ra = parseRetryAfter(res.headers);
        await sleep(ra !== undefined ? Math.min(ra, 60) * 1000 : backoff(attempt));
        continue;
      }
      throw error;
    }
  }

  /** Iterate every item across pages of a list endpoint. */
  async *paginate<T>(path: string, query: Query & PageParams = {}, opts?: RequestOptions): AsyncGenerator<T> {
    let offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    for (;;) {
      const page = await this.request<Page<T>>("GET", path, { ...opts, query: { ...query, limit, offset } });
      for (const item of page.data) yield item;
      offset += page.data.length;
      const total = page.pagination?.total;
      if (page.data.length === 0 || page.data.length < limit || (total !== undefined && offset >= total))
        return;
    }
  }
}

/** Exponential backoff with jitter: ~0.5s, 1s, 2s ... capped at 8s. */
function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base * (0.75 + Math.random() * 0.25);
}

const enc = encodeURIComponent;

class Resource {
  constructor(protected readonly client: Trackified) {}
}

export class Trackings extends Resource {
  create(params: TrackingCreateParams, opts?: RequestOptions): Promise<Tracking> {
    return this.client.request("POST", "/v1/trackings", { ...opts, body: params, idempotent: true });
  }
  /** Each row succeeds or fails on its own; the max batch size depends on your plan. */
  createBulk(trackings: TrackingCreateParams[], opts?: RequestOptions): Promise<BulkResult> {
    return this.client.request("POST", "/v1/trackings/bulk", {
      ...opts,
      body: { trackings },
      idempotent: true,
    });
  }
  list(params: TrackingListParams = {}, opts?: RequestOptions): Promise<Page<Tracking>> {
    return this.client.request("GET", "/v1/trackings", { ...opts, query: { ...params } });
  }
  /** Iterate all trackings matching the filters, fetching pages as needed. */
  iterate(params: TrackingListParams = {}, opts?: RequestOptions): AsyncGenerator<Tracking> {
    return this.client.paginate("/v1/trackings", { ...params }, opts);
  }
  get(id: string, opts?: RequestOptions): Promise<Tracking> {
    return this.client.request("GET", `/v1/trackings/${enc(id)}`, opts);
  }
  update(id: string, params: TrackingUpdateParams, opts?: RequestOptions): Promise<Tracking> {
    return this.client.request("PUT", `/v1/trackings/${enc(id)}`, { ...opts, body: params });
  }
  /** Stop tracking a parcel. */
  delete(id: string, opts?: RequestOptions): Promise<DeleteResult> {
    return this.client.request("DELETE", `/v1/trackings/${enc(id)}`, opts);
  }
  /** Check the carrier again within a minute. */
  retrack(id: string, opts?: RequestOptions): Promise<RetrackResult> {
    return this.client.request("POST", `/v1/trackings/${enc(id)}/retrack`, opts);
  }
}

export class Carriers extends Resource {
  list(params: PageParams = {}, opts?: RequestOptions): Promise<Page<Carrier>> {
    return this.client.request("GET", "/v1/carriers", { ...opts, query: { ...params } });
  }
  iterate(params: PageParams = {}, opts?: RequestOptions): AsyncGenerator<Carrier> {
    return this.client.paginate("/v1/carriers", { ...params }, opts);
  }
  get(id: string, opts?: RequestOptions): Promise<Carrier> {
    return this.client.request("GET", `/v1/carriers/${enc(id)}`, opts);
  }
  detect(trackingNumber: string, opts?: RequestOptions): Promise<CarrierDetection> {
    return this.client.request("GET", "/v1/carriers/detect", { ...opts, query: { number: trackingNumber } });
  }
  /** Search the full carrier catalog by name. */
  search(params: CarrierCatalogParams = {}, opts?: RequestOptions): Promise<CarrierCatalog> {
    return this.client.request("GET", "/v1/carriers/catalog", { ...opts, query: { ...params } });
  }
  /** Map a free-text carrier name or another provider's slug to our id; null when unknown or unsupported. */
  async resolve(name: string, opts?: RequestOptions): Promise<CarrierResolution | null> {
    const r = await this.client.request<CarrierResolution | { carrier: null }>(
      "GET",
      "/v1/carriers/resolve",
      {
        ...opts,
        query: { name },
      },
    );
    return r?.carrier ? (r as CarrierResolution) : null;
  }
  /** How each carrier has been validated. */
  validationStatus(opts?: RequestOptions): Promise<CarrierValidationStatus> {
    return this.client.request("GET", "/v1/carriers/status", opts);
  }
}

export class Webhooks extends Resource {
  /** The response includes the signing secret; store it, it is not shown again. */
  create(params: WebhookCreateParams, opts?: RequestOptions): Promise<WebhookWithSecret> {
    return this.client.request("POST", "/v1/webhooks", { ...opts, body: params });
  }
  list(params: PageParams = {}, opts?: RequestOptions): Promise<Page<Webhook>> {
    return this.client.request("GET", "/v1/webhooks", { ...opts, query: { ...params } });
  }
  iterate(params: PageParams = {}, opts?: RequestOptions): AsyncGenerator<Webhook> {
    return this.client.paginate("/v1/webhooks", { ...params }, opts);
  }
  /** Change url, event types or enabled; the secret is unchanged. */
  update(id: string, params: WebhookUpdateParams, opts?: RequestOptions): Promise<Webhook> {
    const body = { url: params.url, event_types: params.eventTypes, enabled: params.enabled };
    return this.client.request("PATCH", `/v1/webhooks/${enc(id)}`, { ...opts, body });
  }
  /**
   * New signing secret, shown once. The old one keeps verifying for expiresInHours (default 24).
   * Not retried by default: a second rotation would end the first new secret's window unseen.
   */
  rotateSecret(
    id: string,
    params: WebhookRotateSecretParams = {},
    opts?: RequestOptions,
  ): Promise<WebhookRotatedSecret> {
    return this.client.request("POST", `/v1/webhooks/${enc(id)}/rotate-secret`, {
      maxRetries: 0,
      ...opts,
      body: { expires_in_hours: params.expiresInHours },
    });
  }
  delete(id: string, opts?: RequestOptions): Promise<null> {
    return this.client.request("DELETE", `/v1/webhooks/${enc(id)}`, opts);
  }
  /** Sign a sample event without sending it. */
  test(id: string, opts?: RequestOptions): Promise<WebhookTestResult> {
    return this.client.request("POST", `/v1/webhooks/${enc(id)}/test`, opts);
  }
  verify = verify;
  verifyDetailed = verifyDetailed;
  constructEvent = constructEvent;
  trackingOf = trackingOf;
}

export class WebhookDeliveries extends Resource {
  list(params: PageParams = {}, opts?: RequestOptions): Promise<Page<WebhookDelivery>> {
    return this.client.request("GET", "/v1/webhook-deliveries", { ...opts, query: { ...params } });
  }
  iterate(params: PageParams = {}, opts?: RequestOptions): AsyncGenerator<WebhookDelivery> {
    return this.client.paginate("/v1/webhook-deliveries", { ...params }, opts);
  }
}

export class ApiKeys extends Resource {
  /** The response's token is only shown once. */
  create(params: ApiKeyCreateParams = {}, opts?: RequestOptions): Promise<ApiKey> {
    return this.client.request("POST", "/v1/account/api-keys", { ...opts, body: params });
  }
  list(params: PageParams = {}, opts?: RequestOptions): Promise<Page<ApiKey>> {
    return this.client.request("GET", "/v1/account/api-keys", { ...opts, query: { ...params } });
  }
  revoke(id: string, opts?: RequestOptions): Promise<null> {
    return this.client.request("DELETE", `/v1/account/api-keys/${enc(id)}`, opts);
  }
}

export class UsageResource extends Resource {
  /** This month's usage and limits (UTC calendar month). */
  get(opts?: RequestOptions): Promise<Usage> {
    return this.client.request("GET", "/v1/account/usage", opts);
  }
}
