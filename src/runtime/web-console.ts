import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { editableConfigKeys, sensitiveConfigKeys } from "./config.js";
import { createSignedSessionCookie, expireSessionCookie, verifySignedSessionCookie } from "./web-console-session.js";
import { AppSettingsService } from "../domain/app-settings.js";
import { RateLimitService } from "../domain/rate-limit.js";
import { redirect, renderConfigPage, renderLogin, renderOperationsPage, renderOverview, send } from "./web-console-render.js";
import {
  passwordHashKey,
  sessionCookie,
  sessionSecretKey,
  setupTokenKey,
  type SessionKind,
  type WebConsoleOptions,
  type WebConsoleSessionStore,
} from "./web-console-shared.js";

const maxFormBodyBytes = 64 * 1024;
const loginRateLimitWindowSeconds = 300;
const loginRateLimitMaxAttempts = 10;
const passwordHashBytes = 32;

class FormBodyTooLargeError extends Error {}

export async function ensureSetupToken(settings: AppSettingsService): Promise<string | undefined> {
  if (await settings.get(passwordHashKey)) return undefined;
  const existing = await settings.get(setupTokenKey);
  if (existing) return existing;
  const token = randomBytes(16).toString("hex");
  await settings.setMany({ [setupTokenKey]: token });
  return token;
}

// Persist the signing key so signed session cookies survive a restart instead of
// forcing every admin to log in again. Only generated once; never exposed in the
// configuration UI.
export async function ensureSessionSecret(settings: AppSettingsService): Promise<string> {
  const existing = await settings.get(sessionSecretKey);
  if (existing) return existing;
  const secret = randomBytes(32).toString("hex");
  await settings.setMany({ [sessionSecretKey]: secret });
  return secret;
}

export async function startWebConsole(options: WebConsoleOptions): Promise<Server> {
  const sessions = new Map<string, SessionKind>();
  const loginAttempts = new RateLimitService(loginRateLimitWindowSeconds, loginRateLimitMaxAttempts);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/telegram/webhook" && req.method === "POST" && options.telegramWebhook) {
        await options.telegramWebhook(req, res);
        return;
      }

      await writeFetchResponse(
        res,
        await handleWebConsoleRequest(await incomingMessageToRequest(req, url), options, sessions, loginAttempts),
      );
    } catch (error) {
      if (error instanceof FormBodyTooLargeError) {
        send(res, 413, "text/plain", "请求体过大。");
        return;
      }
      send(res, 500, "text/plain", `控制台处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port);
  });
  return server;
}

export async function handleWebConsoleRequest(
  request: Request,
  options: WebConsoleOptions,
  sessions: WebConsoleSessionStore = new Map(),
  loginAttempts: RateLimitService = new RateLimitService(loginRateLimitWindowSeconds, loginRateLimitMaxAttempts),
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const res = new FetchResponseSink();

    if (url.pathname === "/healthz" && request.method === "GET") {
      let dbReachable = false;
      try {
        dbReachable = await options.dbHealthCheck();
      } catch {
        dbReachable = false;
      }
      const botRunning = (await options.getStatus()).bot === "running";
      const healthy = dbReachable && botRunning;
      return jsonResponse(
        {
          status: healthy ? "ok" : "degraded",
          bot: botRunning ? "running" : "stopped",
          db: dbReachable ? "reachable" : "unreachable",
        },
        healthy ? 200 : 503,
      );
    }

    if (url.pathname === "/login" && request.method === "GET") {
      await renderLogin(res.asServerResponse(), options.settings);
      return res.toResponse();
    }

    if (url.pathname === "/login" && request.method === "POST") {
      // Throttle before reading the body so password guessing costs an attempt.
      if (!loginAttempts.check(clientKeyFromRequest(request)).allowed) {
        return textResponse("登录尝试过于频繁，请稍后再试。", 429);
      }
      const form = await readRequestForm(request);
      const sessionKind = await loginSessionKind(options.settings, form);
      if (sessionKind) {
        const serverResponse = res.asServerResponse();
        if (options.sessionSecret) {
          serverResponse.setHeader("set-cookie", await createSignedSessionCookie({
            secret: options.sessionSecret,
            kind: sessionKind,
            now: currentDate(options),
            maxAgeSeconds: options.sessionMaxAgeSeconds ?? 60 * 60 * 8,
          }));
        } else {
          const session = randomBytes(24).toString("hex");
          sessions.set(session, sessionKind);
          serverResponse.setHeader("set-cookie", `${sessionCookie}=${session}; HttpOnly; SameSite=Lax; Path=/`);
        }
        redirect(serverResponse, "/");
        return res.toResponse();
      }
      await renderLogin(res.asServerResponse(), options.settings, "登录凭据无效。");
      return res.toResponse();
    }

    const sessionKind = await authenticatedFetchSessionKind(request, options, sessions);
    if (!sessionKind) return redirectResponse("/login");

    if (url.pathname === "/logout" && request.method === "POST") {
      const token = sessionTokenFromCookie(request.headers.get("cookie") ?? "");
      if (token) sessions.delete(token);
      const serverResponse = res.asServerResponse();
      serverResponse.setHeader("set-cookie", expireSessionCookie());
      redirect(serverResponse, "/login");
      return res.toResponse();
    }

    if (url.pathname === "/metrics" && request.method === "GET") {
      try {
        return jsonResponse(await options.collectMetrics(), 200);
      } catch {
        return jsonResponse({ error: "metrics query failed" }, 500);
      }
    }

    if (url.pathname === "/operations/deliveries/retry" && request.method === "POST") {
      const form = await readRequestForm(request);
      const deliveryId = Number(form.get("delivery_id"));
      if (deliveryId > 0) await options.scheduleRetry(deliveryId);
      return redirectResponse("/operations/deliveries?retryed=1");
    }

    if (url.pathname === "/config" && request.method === "POST") {
      const form = await readRequestForm(request);
      const values = await configValuesFromForm(options.settings, form);
      const password = form.get("WEB_CONSOLE_PASSWORD")?.trim();
      if (sessionKind === "setup" && !password) return textResponse("首次配置必须设置控制台密码。", 400);
      if (password) values[passwordHashKey] = hashPassword(password);
      if (password) values[setupTokenKey] = "";
      await options.settings.setMany(values);
      await options.onConfigSaved();
      const group = form.get("group") ?? "security";
      return redirectResponse(`/config/${group}?saved=1`);
    }

    if (url.pathname === "/" && request.method === "GET") {
      await renderOverview(res.asServerResponse(), options, url.searchParams.get("saved") === "1");
      return res.toResponse();
    }

    if (url.pathname.startsWith("/config") && request.method === "GET") {
      await renderConfigPage(res.asServerResponse(), options, url.pathname, url.searchParams);
      return res.toResponse();
    }

    if (url.pathname.startsWith("/operations") && request.method === "GET") {
      await renderOperationsPage(res.asServerResponse(), options, url.pathname, url.searchParams);
      return res.toResponse();
    }

    return textResponse("页面不存在", 404);
  } catch (error) {
    if (error instanceof FormBodyTooLargeError) return textResponse("请求体过大。", 413);
    return textResponse(`控制台处理失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}

async function incomingMessageToRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (typeof value === "string") headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readNodeRequestBody(req);
  return new Request(url, { method, headers, body });
}

async function readNodeRequestBody(req: IncomingMessage): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
  res.end(body);
}

class FetchResponseSink {
  statusCode = 200;
  private readonly headers = new Headers();
  private body = "";

  asServerResponse(): ServerResponse {
    const sink = this;
    return {
      setHeader: (name: string, value: number | string | readonly string[]) => {
        if (Array.isArray(value)) sink.headers.set(name, value.join(", "));
        else sink.headers.set(name, String(value));
      },
      end: (body?: string | Buffer) => {
        if (body !== undefined) sink.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      },
      get statusCode() {
        return sink.statusCode;
      },
      set statusCode(value: number) {
        sink.statusCode = value;
      },
    } as unknown as ServerResponse;
  }

  toResponse(): Response {
    return new Response(this.body, { status: this.statusCode, headers: this.headers });
  }
}

async function authenticatedFetchSessionKind(
  request: Request,
  options: WebConsoleOptions,
  sessions: WebConsoleSessionStore,
): Promise<SessionKind | undefined> {
  if (options.sessionSecret) {
    return (await verifySignedSessionCookie({
      secret: options.sessionSecret,
      cookieHeader: request.headers.get("cookie") ?? "",
      now: currentDate(options),
    })) ?? undefined;
  }
  const token = sessionTokenFromCookie(request.headers.get("cookie") ?? "");
  return token ? sessions.get(token) : undefined;
}

function currentDate(options: WebConsoleOptions): Date {
  return options.now?.() ?? new Date();
}

function sessionTokenFromCookie(cookie: string): string | undefined {
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`))
    ?.slice(sessionCookie.length + 1);
}

// Best-effort client identity for login throttling. Without a trusted proxy header
// every caller shares the "unknown" bucket, which still bounds guessing but means
// one attacker can also delay legitimate logins.
function clientKeyFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? "unknown";
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

async function readRequestForm(request: Request): Promise<URLSearchParams> {
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > maxFormBodyBytes) throw new FormBodyTooLargeError("form body too large");
  return new URLSearchParams(body.toString("utf8"));
}

async function configValuesFromForm(settings: AppSettingsService, form: URLSearchParams): Promise<Record<string, string>> {
  const current = await settings.all();
  const values: Record<string, string> = {};
  for (const key of editableConfigKeys) {
    const value = form.get(key)?.trim() ?? "";
    if (sensitiveConfigKeys.has(key) && !value && current[key]) continue;
    values[key] = value;
  }
  return values;
}

async function loginSessionKind(settings: AppSettingsService, form: URLSearchParams): Promise<SessionKind | undefined> {
  const hash = await settings.get(passwordHashKey);
  if (hash) return verifyPassword(form.get("password") ?? "", hash) ? "password" : undefined;
  const setupToken = await settings.get(setupTokenKey);
  return setupToken && form.get("setupToken") === setupToken ? "setup" : undefined;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, passwordHashBytes).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  // A malformed hash (invalid hex) decodes to an empty buffer, and comparing two
  // empty buffers makes every password match. Require the exact length that
  // hashPassword produces so a damaged row can never authenticate anyone.
  if (expected.length !== passwordHashBytes) return false;
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
