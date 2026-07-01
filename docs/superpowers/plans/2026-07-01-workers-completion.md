# Workers Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the post-PR Workers runtime work by making the Web Console Fetch path production-ready, adding Worker-safe sessions, validating Cloudflare D1 deployment, and updating docs.

**Architecture:** Keep one business core and split only at adapters. Node keeps `node:http` hosting, Workers use Fetch `Request`/`Response`, D1, webhook, and scheduled events through platform adapters.

**Tech Stack:** Node 24, TypeScript 6, grammY, pino, zod, node:sqlite, Cloudflare Workers, Cloudflare D1, wrangler.

## Global Constraints

- Run TDD for each implementation task: RED first, then GREEN.
- Run `npm run verify` before any completion claim.
- Keep `SqlValue = string | number | bigint | null | Uint8Array`.
- Keep domain code independent from Node APIs and Cloudflare APIs.
- Keep Node runtime behavior working while adding Workers behavior.
- Do not log or document token, password, setup token, webhook secret, or API key values.
- Keep Web Console visual style aligned with the existing Vercel/Next.js minimalist black, white, gray, and single blue accent design.

---

## File Structure

- Modify `src/runtime/web-console.ts`: expand `handleWebConsoleRequest()` from initial Fetch slice to full Web Console route handler, including auth, dashboard pages, config forms, operations pages, JSON endpoints, redirects, and shared rendering.
- Modify `src/runtime/main.ts`: turn Node `startWebConsole` into a thin Node HTTP adapter that delegates to `handleWebConsoleRequest()`.
- Create `src/runtime/web-console-session.ts`: Worker-safe signed cookie session helpers with HMAC, expiration, and constant-time verification.
- Modify `src/runtime/worker.ts`: route Web Console requests through Fetch handler and pass Worker session options.
- Modify `src/runtime/config.ts`: add optional session secret config parsing if needed by Worker Web Console.
- Modify `test/core.test.ts`: add tests for Fetch routes, signed cookie behavior, Node adapter delegation, and Worker routing.
- Modify `wrangler.toml`: document required Worker variables and keep D1 binding stable.
- Modify Wiki files in `/workspace/InBoxBridge.wiki`: update deployment and Web Console docs after implementation.

---

### Task 1: Expand Web Console Fetch Routing

**Files:**
- Modify: `src/runtime/web-console.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: `handleWebConsoleRequest(request, options, sessions?)`
- Produces: Fetch route coverage for `/`, `/config`, `/config/:section`, `/operations`, `/operations/:section`, `/metrics`, `/login`, `/logout`, and `/healthz`

- [ ] **Step 1: Write failing tests for authenticated Fetch pages**

Add tests in `test/core.test.ts` under the `web console` suite:

```ts
test("serves authenticated Web Console pages through Fetch requests", async () => {
  const sessions = new Map<string, "setup" | "admin">([["session-id", "admin"]]);
  const options = createWebConsoleTestOptions();

  const overview = await handleWebConsoleRequest(
    new Request("http://localhost/", {
      headers: { cookie: "inboxbridge_session=session-id" },
    }),
    options,
    sessions,
  );
  assert.equal(overview.status, 200);
  assert.match(await overview.text(), /Console Overview/);

  const config = await handleWebConsoleRequest(
    new Request("http://localhost/config", {
      headers: { cookie: "inboxbridge_session=session-id" },
    }),
    options,
    sessions,
  );
  assert.equal(config.status, 200);
  assert.match(await config.text(), /Configuration/);

  const operations = await handleWebConsoleRequest(
    new Request("http://localhost/operations", {
      headers: { cookie: "inboxbridge_session=session-id" },
    }),
    options,
    sessions,
  );
  assert.equal(operations.status, 200);
  assert.match(await operations.text(), /Operations/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="serves authenticated Web Console pages through Fetch requests"`

Expected: FAIL because Fetch handler only supports the first Web Console slice.

- [ ] **Step 3: Implement route dispatch in `handleWebConsoleRequest()`**

Use the existing render helpers in `src/runtime/web-console.ts`. Add a route table near the current Fetch handler:

```ts
if (request.method === "GET" && pathname === "/") {
  await renderOverview(sink, options, sessionKind);
  return sink.toResponse();
}

if (request.method === "GET" && pathname === "/config") {
  await renderConfigDashboard(sink, options, sessionKind);
  return sink.toResponse();
}

if (request.method === "GET" && pathname.startsWith("/config/")) {
  await renderConfigSection(sink, options, sessionKind, pathname);
  return sink.toResponse();
}

if (request.method === "GET" && pathname === "/operations") {
  await renderOperationsOverview(sink, options, sessionKind);
  return sink.toResponse();
}

if (request.method === "GET" && pathname.startsWith("/operations/")) {
  await renderOperationsSection(sink, options, sessionKind, pathname, url.searchParams);
  return sink.toResponse();
}
```

If the current render functions are nested inside Node-only code, move them to top-level functions in the same file without changing HTML output.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern="serves authenticated Web Console pages through Fetch requests"`

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run: `npm run verify`

Expected: TypeScript check passes, 63+ tests pass, audit reports 0 vulnerabilities.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/web-console.ts test/core.test.ts
git commit -m "feat(console): route dashboard pages through Fetch"
```

---

### Task 2: Add Fetch POST Login and Logout

**Files:**
- Modify: `src/runtime/web-console.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: `WebConsoleSessionStore`
- Produces: Fetch support for `POST /login` and `POST /logout`

- [ ] **Step 1: Write failing tests for login and logout**

```ts
test("authenticates Web Console sessions through Fetch login", async () => {
  const sessions = new Map<string, "setup" | "admin">();
  const options = createWebConsoleTestOptions({ password: "secret-password" });

  const response = await handleWebConsoleRequest(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "secret-password" }),
    }),
    options,
    sessions,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  assert.match(response.headers.get("set-cookie") ?? "", /inboxbridge_session=/);
  assert.equal(sessions.size, 1);
});

test("logs out Web Console sessions through Fetch logout", async () => {
  const sessions = new Map<string, "setup" | "admin">([["session-id", "admin"]]);
  const options = createWebConsoleTestOptions();

  const response = await handleWebConsoleRequest(
    new Request("http://localhost/logout", {
      method: "POST",
      headers: { cookie: "inboxbridge_session=session-id" },
    }),
    options,
    sessions,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/login");
  assert.equal(sessions.has("session-id"), false);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="Fetch login|Fetch logout"`

Expected: FAIL because POST Fetch auth is incomplete.

- [ ] **Step 3: Implement POST handling**

In `handleWebConsoleRequest()`:

```ts
if (request.method === "POST" && pathname === "/login") {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const sessionKind = await authenticateWebConsolePassword(options, password);
  if (!sessionKind) {
    await renderLogin(sink, options, "Invalid password");
    return sink.toResponse();
  }

  const sessionId = createSessionId();
  sessions.set(sessionId, sessionKind);
  sink.redirect("/");
  sink.setCookie(createSessionCookie(sessionId));
  return sink.toResponse();
}

if (request.method === "POST" && pathname === "/logout") {
  const sessionId = readSessionCookie(request.headers.get("cookie") ?? "");
  if (sessionId) {
    sessions.delete(sessionId);
  }
  sink.redirect("/login");
  sink.setCookie(expireSessionCookie());
  return sink.toResponse();
}
```

Keep the existing unauthenticated body-size guard.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern="Fetch login|Fetch logout"`

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run: `npm run verify`

Expected: TypeScript check passes, all tests pass, audit reports 0 vulnerabilities.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/web-console.ts test/core.test.ts
git commit -m "feat(console): handle Fetch login sessions"
```

---

### Task 3: Add Worker-Safe Signed Cookie Sessions

**Files:**
- Create: `src/runtime/web-console-session.ts`
- Modify: `src/runtime/web-console.ts`
- Modify: `src/runtime/worker.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Produces: `createSignedSessionCookie(input)`, `verifySignedSessionCookie(input)`, `expireSessionCookie()`
- Consumes: Web Crypto `crypto.subtle` available in Workers and Node 24 test runtime

- [ ] **Step 1: Write failing tests for signed cookie verification**

```ts
test("signs and verifies Web Console cookies without server memory", async () => {
  const cookie = await createSignedSessionCookie({
    secret: "session-secret-value",
    kind: "admin",
    now: new Date("2026-07-01T00:00:00.000Z"),
    maxAgeSeconds: 3600,
  });

  const verified = await verifySignedSessionCookie({
    secret: "session-secret-value",
    cookieHeader: cookie,
    now: new Date("2026-07-01T00:10:00.000Z"),
  });

  assert.equal(verified, "admin");
});

test("rejects expired Web Console signed cookies", async () => {
  const cookie = await createSignedSessionCookie({
    secret: "session-secret-value",
    kind: "admin",
    now: new Date("2026-07-01T00:00:00.000Z"),
    maxAgeSeconds: 60,
  });

  const verified = await verifySignedSessionCookie({
    secret: "session-secret-value",
    cookieHeader: cookie,
    now: new Date("2026-07-01T00:02:00.000Z"),
  });

  assert.equal(verified, null);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="signed cookies|expired Web Console"`

Expected: FAIL because `src/runtime/web-console-session.ts` does not exist.

- [ ] **Step 3: Implement signed cookie helpers**

Create `src/runtime/web-console-session.ts`:

```ts
export type SessionKind = "setup" | "admin";

export type CreateSignedSessionCookieInput = {
  secret: string;
  kind: SessionKind;
  now: Date;
  maxAgeSeconds: number;
};

export type VerifySignedSessionCookieInput = {
  secret: string;
  cookieHeader: string;
  now: Date;
};

const COOKIE_NAME = "inboxbridge_session";

export async function createSignedSessionCookie(input: CreateSignedSessionCookieInput): Promise<string> {
  const expiresAt = Math.floor(input.now.getTime() / 1000) + input.maxAgeSeconds;
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ kind: input.kind, exp: expiresAt })));
  const signature = await sign(input.secret, payload);
  return `${COOKIE_NAME}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${input.maxAgeSeconds}`;
}

export async function verifySignedSessionCookie(input: VerifySignedSessionCookieInput): Promise<SessionKind | null> {
  const raw = readCookie(input.cookieHeader, COOKIE_NAME);
  if (!raw) return null;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return null;
  const expected = await sign(input.secret, payload);
  if (!constantTimeEqual(signature, expected)) return null;

  const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { kind?: string; exp?: number };
  if (decoded.kind !== "setup" && decoded.kind !== "admin") return null;
  if (typeof decoded.exp !== "number") return null;
  if (decoded.exp <= Math.floor(input.now.getTime() / 1000)) return null;
  return decoded.kind;
}

export function expireSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
```

Add local helpers `sign`, `base64UrlEncode`, `base64UrlDecode`, `readCookie`, and `constantTimeEqual` in the same file using Web Crypto and no Node imports.

- [ ] **Step 4: Wire Worker session mode into Fetch handler**

Add an optional session secret to the Fetch handler options:

```ts
export type WebConsoleFetchOptions = WebConsoleOptions & {
  sessionSecret?: string;
  now?: () => Date;
};
```

When `sessionSecret` is present, authenticate with signed cookies instead of the in-memory map.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern="signed cookies|expired Web Console"`

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run: `npm run verify`

Expected: TypeScript check passes, all tests pass, audit reports 0 vulnerabilities.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/web-console-session.ts src/runtime/web-console.ts src/runtime/worker.ts test/core.test.ts
git commit -m "feat(console): add signed cookie sessions"
```

---

### Task 4: Delegate Node Web Console to Fetch Handler

**Files:**
- Modify: `src/runtime/web-console.ts`
- Modify: `src/runtime/main.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: `handleWebConsoleRequest()`
- Produces: Node HTTP adapter that converts `IncomingMessage` to Fetch `Request` and Fetch `Response` to `ServerResponse`

- [ ] **Step 1: Write failing test for Node adapter delegation**

```ts
test("Node web console delegates health checks through Fetch handler", async () => {
  const calls: string[] = [];
  const server = await startWebConsole({
    ...createWebConsoleTestOptions(),
    handleRequest: async (request) => {
      calls.push(new URL(request.url).pathname);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/healthz"]);
  await server.close();
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- --test-name-pattern="Node web console delegates"`

Expected: FAIL because `startWebConsole` has no delegation injection.

- [ ] **Step 3: Implement adapter conversion helpers**

In `src/runtime/web-console.ts`, add:

```ts
async function incomingMessageToRequest(req: IncomingMessage, baseUrl: string): Promise<Request> {
  const url = new URL(req.url ?? "/", baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (typeof value === "string") headers.set(key, value);
  }

  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readNodeRequestBody(req);
  return new Request(url, { method, headers, body });
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  res.end(body);
}
```

Make `startWebConsole` call `handleWebConsoleRequest()` for all routes.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern="Node web console delegates"`

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run: `npm run verify`

Expected: TypeScript check passes, all tests pass, audit reports 0 vulnerabilities.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/web-console.ts src/runtime/main.ts test/core.test.ts
git commit -m "refactor(console): use Fetch handler from Node adapter"
```

---

### Task 5: Route Workers Web Console Requests

**Files:**
- Modify: `src/runtime/worker.ts`
- Modify: `src/runtime/config.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: `handleWebConsoleRequest()` and signed cookie sessions
- Produces: Worker routes for `/`, `/login`, `/logout`, `/config`, `/operations`, `/metrics`, `/healthz`, and `/telegram/webhook`

- [ ] **Step 1: Write failing Worker routing tests**

```ts
test("Worker runtime serves Web Console login page", async () => {
  const env = createWorkerTestEnv({ WEB_CONSOLE_SESSION_SECRET: "session-secret-value" });
  const response = await handleWorkerFetch(new Request("http://worker.example/login"), env);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /InboxBridge/);
});

test("Worker runtime keeps Telegram webhook route separate from Web Console", async () => {
  const env = createWorkerTestEnv({ WEB_CONSOLE_SESSION_SECRET: "session-secret-value" });
  const response = await handleWorkerFetch(new Request("http://worker.example/telegram/webhook"), env, {
    telegramWebhookHandler: async () => new Response("telegram", { status: 202 }),
  });

  assert.equal(response.status, 202);
  assert.equal(await response.text(), "telegram");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="Worker runtime serves Web Console|keeps Telegram webhook"`

Expected: FAIL because Worker only handles current limited routes.

- [ ] **Step 3: Implement Worker route dispatch**

In `src/runtime/worker.ts`, after `/telegram/webhook` handling and before fallback:

```ts
if (isWebConsolePath(url.pathname)) {
  const runtime = await createWorkerRuntime(env, options);
  return handleWebConsoleRequest(request, {
    ...runtime.webConsoleOptions,
    sessionSecret: runtime.config.WEB_CONSOLE_SESSION_SECRET,
  });
}
```

Add:

```ts
function isWebConsolePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/login" || pathname === "/logout" || pathname === "/healthz" || pathname === "/metrics" || pathname.startsWith("/config") || pathname.startsWith("/operations");
}
```

- [ ] **Step 4: Add config parsing for session secret**

In `src/runtime/config.ts`, add optional string config:

```ts
WEB_CONSOLE_SESSION_SECRET: getOptionalString(sources, "WEB_CONSOLE_SESSION_SECRET"),
```

Require this value only in Worker Web Console route handling, returning `503` with a safe message when missing.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern="Worker runtime serves Web Console|keeps Telegram webhook"`

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run: `npm run verify`

Expected: TypeScript check passes, all tests pass, audit reports 0 vulnerabilities.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/worker.ts src/runtime/config.ts test/core.test.ts
git commit -m "feat(worker): serve web console over Fetch"
```

---

### Task 6: Add Cloudflare Deployment Smoke Checklist

**Files:**
- Modify: `wrangler.toml`
- Modify: `/workspace/InBoxBridge.wiki/Deployment.md`
- Modify: `/workspace/InBoxBridge.wiki/Web-Console.md`
- Modify: `/workspace/InBoxBridge.wiki/Troubleshooting.md`

**Interfaces:**
- Produces: documented Cloudflare deployment steps and smoke-test checklist

- [ ] **Step 1: Update `wrangler.toml` comments through safe vars only**

Keep placeholder D1 ID until deployment:

```toml
name = "inboxbridge"
main = "src/runtime/worker.ts"
compatibility_date = "2026-07-01"

[vars]
TELEGRAM_UPDATE_MODE = "webhook"

[[d1_databases]]
binding = "DB"
database_name = "inboxbridge"
database_id = "00000000-0000-0000-0000-000000000000"

[triggers]
crons = ["*/15 * * * *"]
```

- [ ] **Step 2: Document required secrets without values**

In Wiki docs, document these commands with placeholders only:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put WEB_CONSOLE_PASSWORD
wrangler secret put WEB_CONSOLE_SESSION_SECRET
```

- [ ] **Step 3: Document smoke tests**

Add this checklist:

```markdown
## Cloudflare Workers Smoke Test

- `GET /healthz` returns JSON and executes D1 `SELECT 1`.
- `GET /login` renders the Web Console login page.
- Login creates an HttpOnly session cookie.
- `GET /operations` renders after authentication.
- Telegram webhook path returns a handled response for valid secret headers.
- Scheduled event runs maintenance without throwing.
```

- [ ] **Step 4: Run docs checks**

Run in Wiki repo: `git diff --check`

Expected: no output.

- [ ] **Step 5: Commit Wiki docs**

```bash
git add Deployment.md Web-Console.md Troubleshooting.md
git commit -m "docs: add Cloudflare Workers smoke checklist"
git push origin master
```

---

### Task 7: Final Verification and PR

**Files:**
- All files touched by Tasks 1-6

**Interfaces:**
- Produces: one GitHub PR against `main`

- [ ] **Step 1: Run final verification**

Run: `npm run verify`

Expected: TypeScript check passes, all tests pass, audit reports 0 vulnerabilities.

- [ ] **Step 2: Inspect Git state**

Run: `git status --short`

Expected: only intended files are modified or staged.

- [ ] **Step 3: Inspect PR diff**

Run: `git diff --stat origin/main...HEAD`

Expected: diff includes runtime, tests, config, and docs intended for this plan.

- [ ] **Step 4: Push branch**

```bash
git push -u origin 260701-feat-worker-console-completion
```

- [ ] **Step 5: Create PR**

```bash
gh pr create --base main --head 260701-feat-worker-console-completion --title "feat(worker): complete Fetch web console support" --body "## Summary
- route Web Console pages and auth through Fetch
- add signed cookie sessions for Workers
- delegate Node Web Console through the shared Fetch handler
- document Cloudflare Workers smoke testing

## Validation
- npm run verify"
```

- [ ] **Step 6: Wait for checks**

Run: `gh pr checks --watch`

Expected: `Verify`, `Analyze TypeScript`, `CodeQL`, and `CodeRabbit` pass.

---

## Acceptance Criteria

- Web Console pages are served through Fetch in both Node and Workers paths.
- Workers Web Console auth uses signed cookies and does not depend on in-memory session state.
- Telegram webhook route remains isolated from Web Console routing.
- D1-backed `/healthz` still runs a database query per request.
- Node runtime still passes all existing tests.
- Wiki documents Cloudflare Workers deployment without leaking secret values.
- `npm run verify` passes before PR creation.

## Self-Review

- Spec coverage: The plan covers Web Console Fetch completion, Worker-safe sessions, Worker routing, Node adapter delegation, Cloudflare smoke docs, and PR validation.
- Placeholder scan: No implementation step uses TBD-style placeholders; secret values are intentionally represented as safe names only.
- Type consistency: Session kind remains `"setup" | "admin"`; Fetch handler remains `handleWebConsoleRequest(request, options, sessions?)`; Worker entry remains `handleWorkerFetch(request, env, options?)`.
