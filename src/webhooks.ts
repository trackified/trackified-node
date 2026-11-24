import { SignatureVerificationError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

export const SIGNATURE_HEADER = "x-tracking-signature";
export const DEFAULT_TOLERANCE = 300;

/** Web Crypto: global in Node >= 19, Deno, Bun and edge runtimes; node:crypto on Node 18. */
export async function getCrypto(): Promise<Crypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto;
  const mod = await import("node:crypto");
  return mod.webcrypto as unknown as Crypto;
}

export interface VerifyOptions {
  /** Max age of the signature in seconds (default 300). */
  tolerance?: number;
  /** Current time in unix seconds; for tests. */
  now?: number;
}

type RawBody = string | Uint8Array | ArrayBuffer;

function parseHeader(header: string): { t: number; v1: string[] } {
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) throw new SignatureVerificationError("Malformed signature header");
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t") {
      if (!/^\d+$/.test(value)) throw new SignatureVerificationError("Malformed timestamp");
      t = Number(value);
    } else if (key === "v1") {
      v1.push(value);
    }
  }
  if (t === undefined || v1.length === 0) {
    throw new SignatureVerificationError("Signature header needs t and v1");
  }
  return { t, v1 };
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBytes(body: RawBody): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

/** Throws SignatureVerificationError unless the signature is valid and fresh. */
async function assertValid(
  rawBody: RawBody,
  header: string | null | undefined,
  secret: string,
  opts: VerifyOptions,
): Promise<void> {
  if (!header) throw new SignatureVerificationError("Missing signature header");
  if (!secret) throw new SignatureVerificationError("Missing webhook secret");
  const { t, v1 } = parseHeader(header);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.tolerance ?? DEFAULT_TOLERANCE)) {
    throw new SignatureVerificationError("Signature timestamp outside tolerance");
  }
  const body = toBytes(rawBody);
  const prefix = new TextEncoder().encode(`${t}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);

  const { subtle } = await getCrypto();
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const sig of v1) {
    const bytes = hexToBytes(sig);
    // subtle.verify compares in constant time.
    if (bytes && (await subtle.verify("HMAC", key, bytes, signed))) return;
  }
  throw new SignatureVerificationError("Signature mismatch");
}

/** Pass the raw request body exactly as received (not re-serialised JSON). */
export async function verify(
  rawBody: RawBody,
  header: string | null | undefined,
  secret: string,
  opts: VerifyOptions = {},
): Promise<boolean> {
  try {
    await assertValid(rawBody, header, secret, opts);
    return true;
  } catch (e) {
    if (e instanceof SignatureVerificationError) return false;
    throw e;
  }
}

/** Verifies the signature and returns the parsed event, or throws SignatureVerificationError. */
export async function constructEvent<T = WebhookEvent>(
  rawBody: RawBody,
  header: string | null | undefined,
  secret: string,
  opts: VerifyOptions = {},
): Promise<T> {
  await assertValid(rawBody, header, secret, opts);
  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(toBytes(rawBody));
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new SignatureVerificationError("Webhook body is not valid JSON", { cause: e });
  }
}

export const webhookHelpers = { verify, constructEvent, SIGNATURE_HEADER };
