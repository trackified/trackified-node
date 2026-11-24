// Hand-written from https://api.trackified.net/openapi.json

export const TRACKING_STATUSES = [
  "not_yet_scanned",
  "in_transit",
  "out_for_delivery",
  "available_for_pickup",
  "delivered",
  "exception",
  "returned",
  "unknown",
] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export const EVENT_STATUSES = [
  "info_received",
  "in_transit",
  "out_for_delivery",
  "available_for_pickup",
  "delivered",
  "exception",
  "returned",
  "unknown",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const WEBHOOK_EVENT_TYPES = [
  "tracking.created",
  "tracking.updated",
  "tracking.status_changed",
  "tracking.delivered",
  "tracking.exception",
  "tracking.returned",
  "tracking.expired",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface TrackingEvent {
  /** ISO 8601; with an offset only when time_zone_known. null when unreadable. */
  occurred_at: string | null;
  time_zone_known: boolean;
  status: EventStatus;
  description: string;
  location: string;
  /** @deprecated Use occurred_at. */
  date: string | null;
}

export interface Tracking {
  id: string;
  tracking_number: string;
  carrier: string | null;
  carrier_detected: boolean;
  status: TrackingStatus;
  /** Newest first. */
  events: TrackingEvent[];
  estimated_delivery: string | null;
  delivered_at: string | null;
  delivered_at_time_zone_known: boolean;
  delivery_detected_at: string | null;
  exception: string | null;
  service_level: string | null;
  custom_id: string | null;
  customer_email: string | null;
  last_scraped_at: string | null;
  next_scrape_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrackingCreateParams {
  tracking_number: string;
  /** Leave out to detect it from the number (422 carrier_not_detected if unsure). */
  carrier?: string;
  /** Your own reference, such as an order number. */
  custom_id?: string;
  customer_email?: string;
}

export interface TrackingUpdateParams {
  carrier?: string;
  custom_id?: string;
  customer_email?: string;
}

export interface PageParams {
  limit?: number;
  offset?: number;
}

export interface TrackingListParams extends PageParams {
  status?: TrackingStatus;
  carrier?: string;
  custom_id?: string;
  tracking_number?: string;
}

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

export interface Page<T> {
  data: T[];
  pagination: Pagination;
}

export interface BulkResult {
  data: Array<{ ok: boolean; tracking?: Tracking; error?: string }>;
}

export interface DeleteResult {
  deleted: boolean;
  id: string;
}

export interface RetrackResult {
  queued: boolean;
  tracking: Tracking;
}

export interface Carrier {
  id: string;
  /** The live API returns displayName; the spec documents display_name. */
  displayName?: string;
  display_name?: string;
  [key: string]: unknown;
}

export interface CarrierCandidate {
  carrier: string;
  confidence: number;
  reason: string;
}

export interface CarrierDetection {
  tracking_number: string;
  candidates: CarrierCandidate[];
}

export interface CarrierCatalogParams {
  q?: string;
  support?: "scraper" | "api" | "unsupported";
  limit?: number;
}

export interface CarrierCatalogEntry {
  id: string;
  displayName: string;
  country: string | null;
  url: string | null;
  support?: "scraper" | "api" | "unsupported";
  carrierId?: string;
  [key: string]: unknown;
}

export interface CarrierCatalog {
  total: number;
  data: CarrierCatalogEntry[];
  counts?: Record<string, number>;
}

export interface CarrierValidationStatus {
  counts?: Record<string, number>;
  values?: Array<{ carrier: string; status: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface Webhook {
  id: string;
  url: string;
  event_types: WebhookEventType[];
  enabled: boolean;
  secret_preview: string;
  created_at: string;
}

export interface WebhookWithSecret extends Webhook {
  /** Signing secret, only returned when the webhook is created. */
  secret: string;
}

export interface WebhookCreateParams {
  url: string;
  event_types?: WebhookEventType[];
}

export interface WebhookTestResult {
  signature: string;
  body: WebhookEvent;
  [key: string]: unknown;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  url: string;
  event_type: WebhookEventType;
  /** HTTP status the endpoint returned, null if it could not be reached. */
  status: number | null;
  attempts: number;
  error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  mode: "test" | "live";
  scopes: string[];
  /** Only present in the create response. */
  token?: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyCreateParams {
  name?: string;
  mode?: "test" | "live";
  scopes?: string[];
}

export interface Usage {
  period_start: string;
  period_end: string;
  /** free, starter, pro or scale. */
  plan: string;
  trackings_used: number;
  trackings_limit: number;
  trackings_remaining: number;
  rate_limit_per_minute: number;
  webhook_deliveries: number;
  carrier_volume: Array<{ carrier: string; count: number }>;
}

export interface WebhookEvent<T = Tracking> {
  id: string;
  type: WebhookEventType;
  created_at?: string;
  data: T;
}

export interface RequestOptions {
  /** Sent on POSTs that create trackings; generated automatically when omitted. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
}
