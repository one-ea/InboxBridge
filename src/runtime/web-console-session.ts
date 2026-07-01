export type WebConsoleSessionKind = "password" | "setup";

export interface CreateSignedSessionCookieInput {
  secret: string;
  kind: WebConsoleSessionKind;
  now: Date;
  maxAgeSeconds: number;
}

export interface VerifySignedSessionCookieInput {
  secret: string;
  cookieHeader: string;
  now: Date;
}

const cookieName = "inboxbridge_session";

export async function createSignedSessionCookie(input: CreateSignedSessionCookieInput): Promise<string> {
  const expiresAt = Math.floor(input.now.getTime() / 1000) + input.maxAgeSeconds;
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ kind: input.kind, exp: expiresAt })));
  const signature = await sign(input.secret, payload);
  return `${cookieName}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${input.maxAgeSeconds}`;
}

export async function verifySignedSessionCookie(input: VerifySignedSessionCookieInput): Promise<WebConsoleSessionKind | null> {
  const raw = readCookie(input.cookieHeader, cookieName);
  if (!raw) return null;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return null;
  const expected = await sign(input.secret, payload);
  if (!constantTimeEqual(signature, expected)) return null;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { kind?: unknown; exp?: unknown };
    if (decoded.kind !== "password" && decoded.kind !== "setup") return null;
    if (typeof decoded.exp !== "number") return null;
    if (decoded.exp <= Math.floor(input.now.getTime() / 1000)) return null;
    return decoded.kind;
  } catch {
    return null;
  }
}

export function expireSessionCookie(): string {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function readCookie(cookieHeader: string, name: string): string | undefined {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}
