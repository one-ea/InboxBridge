import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleWebConsoleRequest, ensureSessionSecret, startWebConsole } from "../src/runtime/web-console.js";
import { AppSettingsService } from "../src/domain/app-settings.js";
import { RateLimitService } from "../src/domain/rate-limit.js";
import { createSignedSessionCookie, verifySignedSessionCookie } from "../src/runtime/web-console-session.js";
import { createTestDatabase, disposeTestDatabase, handle, consolePasswordHash, noopDbHealthCheck, stubMetrics, stubOpsOverview, stubListConversations, stubListFailedDeliveries, stubScheduleRetry, stubListAuditLogs, stubSearchMessages } from "./support/harness.js";

beforeEach(createTestDatabase);
afterEach(disposeTestDatabase);

describe("web console", () => {
  it("signs and verifies Web Console cookies without server memory", async () => {
    const cookie = await createSignedSessionCookie({
      secret: "session-secret-value",
      kind: "password",
      now: new Date("2026-07-01T00:00:00.000Z"),
      maxAgeSeconds: 3600,
    });

    const verified = await verifySignedSessionCookie({
      secret: "session-secret-value",
      cookieHeader: cookie,
      now: new Date("2026-07-01T00:10:00.000Z"),
    });

    assert.equal(verified, "password");
  });

  it("rejects expired Web Console signed cookies", async () => {
    const cookie = await createSignedSessionCookie({
      secret: "session-secret-value",
      kind: "password",
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

  it("handles login and health checks through Fetch requests", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const sessions = new Map<string, never>();
    const options = {
      settings,
      port: 0,
      getStatus: () => ({ bot: "running" as const, issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: async () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    };

    const login = await handleWebConsoleRequest(new Request("https://example.com/login"), options, sessions);
    const health = await handleWebConsoleRequest(new Request("https://example.com/healthz"), options, sessions);
    const body = (await health.json()) as { status: string; bot: string; db: string };

    assert.equal(login.status, 200);
    assert.match(await login.text(), /登录控制台/);
    assert.equal(login.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(health.status, 200);
    assert.deepEqual(body, { status: "ok", bot: "running", db: "reachable" });
  });

  it("throttles repeated login attempts from the same client", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: consolePasswordHash("correct-password") });
    const options = {
      settings,
      port: 0,
      getStatus: () => ({ bot: "running" as const, issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: async () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    };
    const loginAttempts = new RateLimitService(300, 3);
    const attempt = async (password: string, ip: string): Promise<number> => {
      const response = await handleWebConsoleRequest(
        new Request("https://example.com/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
          body: new URLSearchParams({ password }).toString(),
        }),
        options,
        new Map(),
        loginAttempts,
      );
      return response.status;
    };

    assert.equal(await attempt("wrong", "1.1.1.1"), 200);
    assert.equal(await attempt("wrong", "1.1.1.1"), 200);
    assert.equal(await attempt("wrong", "1.1.1.1"), 200);
    assert.equal(await attempt("wrong", "1.1.1.1"), 429);

    // A different client keeps its own budget.
    assert.equal(await attempt("wrong", "2.2.2.2"), 200);
  });

  it("rejects any password when the stored console hash is malformed", async () => {
    const settings = new AppSettingsService(handle.db);
    // Invalid hex decodes to an empty buffer; an empty comparison must not authenticate.
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "salt:hash" });
    const loginAttempts = new RateLimitService(300, 10);

    const login = async (password: string): Promise<Response> =>
      handleWebConsoleRequest(
        new Request("https://example.com/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ password }).toString(),
        }),
        {
          settings,
          port: 0,
          getStatus: () => ({ bot: "running" as const, issues: [] }),
          onConfigSaved: async () => {},
          dbHealthCheck: async () => true,
          collectMetrics: stubMetrics,
          collectOperationsOverview: stubOpsOverview,
          listConversations: stubListConversations,
          listFailedDeliveries: stubListFailedDeliveries,
          scheduleRetry: stubScheduleRetry,
          listAuditLogs: stubListAuditLogs,
          searchMessages: stubSearchMessages,
        },
        new Map(),
        loginAttempts,
      );

    const response = await login("anything");
    assert.equal(response.status, 200);
    assert.match(await response.text(), /登录凭据无效/);
  });

  it("persists the web console session secret across restarts", async () => {
    const settings = new AppSettingsService(handle.db);
    const first = await ensureSessionSecret(settings);
    const second = await ensureSessionSecret(settings);

    assert.ok(first.length >= 32);
    assert.equal(second, first);
    assert.equal(await settings.get("WEB_CONSOLE_SESSION_SECRET"), first);
  });

  it("signs Node web console sessions with the persisted secret", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const secret = await ensureSessionSecret(settings);

    const response = await handleWebConsoleRequest(
      new Request("https://example.com/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ setupToken: "setup-token" }).toString(),
      }),
      {
        settings,
        port: 0,
        sessionSecret: secret,
        getStatus: () => ({ bot: "running" as const, issues: [] }),
        onConfigSaved: async () => {},
        dbHealthCheck: async () => true,
        collectMetrics: stubMetrics,
        collectOperationsOverview: stubOpsOverview,
        listConversations: stubListConversations,
        listFailedDeliveries: stubListFailedDeliveries,
        scheduleRetry: stubScheduleRetry,
        listAuditLogs: stubListAuditLogs,
        searchMessages: stubSearchMessages,
      },
      new Map(),
      new RateLimitService(300, 10),
    );

    const cookie = response.headers.get("set-cookie") ?? "";
    assert.equal(response.status, 302);
    assert.match(cookie, /inboxbridge_session=/);
    assert.equal(
      await verifySignedSessionCookie({ secret, cookieHeader: cookie, now: new Date() }),
      "setup",
    );
  });

  it("serves authenticated Web Console pages through Fetch requests", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const sessions = new Map([["session-id", "password" as const]]);
    const options = {
      settings,
      port: 0,
      getStatus: () => ({ bot: "running" as const, issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: async () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    };

    const overview = await handleWebConsoleRequest(
      new Request("https://example.com/", { headers: { cookie: "inboxbridge_session=session-id" } }),
      options,
      sessions,
    );
    const config = await handleWebConsoleRequest(
      new Request("https://example.com/config", { headers: { cookie: "inboxbridge_session=session-id" } }),
      options,
      sessions,
    );
    const operations = await handleWebConsoleRequest(
      new Request("https://example.com/operations", { headers: { cookie: "inboxbridge_session=session-id" } }),
      options,
      sessions,
    );

    assert.equal(overview.status, 200);
    assert.match(await overview.text(), /控制台概览/);
    assert.equal(config.status, 200);
    assert.match(await config.text(), /配置仪表盘/);
    assert.equal(operations.status, 200);
    assert.match(await operations.text(), /运维仪表盘/);
  });

  it("authenticates and logs out Web Console sessions through Fetch requests", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const sessions = new Map<string, "password" | "setup">();
    const options = {
      settings,
      port: 0,
      getStatus: () => ({ bot: "running" as const, issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: async () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    };

    const login = await handleWebConsoleRequest(
      new Request("https://example.com/login", {
        method: "POST",
        body: new URLSearchParams({ setupToken: "setup-token" }),
      }),
      options,
      sessions,
    );
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "/");
    assert.match(cookie, /^inboxbridge_session=/);
    assert.equal(sessions.size, 1);

    const logout = await handleWebConsoleRequest(
      new Request("https://example.com/logout", {
        method: "POST",
        headers: { cookie },
      }),
      options,
      sessions,
    );

    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get("location"), "/login");
    assert.equal(sessions.size, 0);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
  });

  it("requires a password before setup-token sessions can save configuration", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const login = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        body: new URLSearchParams({ setupToken: "setup-token" }),
        redirect: "manual",
      });
      const cookie = login.headers.get("set-cookie") ?? "";

      const save = await fetch(`http://127.0.0.1:${port}/config`, {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({
          TELEGRAM_BOT_TOKEN: "token",
          TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
          TELEGRAM_ADMIN_USER_IDS: "1",
        }),
        redirect: "manual",
      });

      assert.equal(save.status, 400);
      assert.equal(await settings.get("WEB_CONSOLE_PASSWORD_HASH"), undefined);
      assert.equal(await settings.get("WEB_CONSOLE_SETUP_TOKEN"), "setup-token");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects oversized unauthenticated login form bodies", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        body: `setupToken=${"x".repeat(70 * 1024)}`,
      });

      assert.equal(response.status, 413);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("awaits Telegram webhook errors so they return a handled response", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
      telegramWebhook: async () => {
        throw new Error("webhook failed");
      },
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook`, {
        method: "POST",
        signal: AbortSignal.timeout(1000),
      });

      assert.equal(response.status, 500);
      assert.match(await response.text(), /webhook failed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects when the web console port cannot be opened", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;

    try {
      await assert.rejects(
        startWebConsole({
          settings: new AppSettingsService(handle.db),
          port,
          getStatus: () => ({ bot: "stopped", issues: [] }),
          onConfigSaved: async () => {},
          dbHealthCheck: noopDbHealthCheck,
          collectMetrics: stubMetrics,
          collectOperationsOverview: stubOpsOverview,
          listConversations: stubListConversations,
          listFailedDeliveries: stubListFailedDeliveries,
          scheduleRetry: stubScheduleRetry,
          listAuditLogs: stubListAuditLogs,
          searchMessages: stubSearchMessages,
        }),
        /EADDRINUSE/,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("exposes /healthz without authentication", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { status: string; bot: string; db: string };
      assert.equal(body.status, "degraded");
      assert.equal(body.bot, "stopped");
      assert.equal(body.db, "reachable");
    } finally {
      server.close();
    }
  });

  it("returns 200 from /healthz when bot is running and db is reachable", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      assert.equal(body.status, "ok");
    } finally {
      server.close();
    }
  });

  it("redirects /metrics to /login without authentication", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`, { redirect: "manual" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/login");
    } finally {
      server.close();
    }
  });

  it("returns metrics JSON after authentication", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: () => ({
        messages: { inbound_total: 5, outbound_total: 3, internal_total: 1 },
        deliveries: { pending: 0, sent: 3, failed: 1, permanent_failure: 0 },
        conversations: { open: 2, closed: 1 },
        ai_drafts: { pending: 0, ready: 1, failed: 0 },
        uptime_seconds: 42,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const loginRes = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        body: new URLSearchParams({ setupToken: "setup-token" }),
        redirect: "manual",
      });
      const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { cookie },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { messages: { inbound_total: number }; conversations: { open: number } };
      assert.equal(body.messages.inbound_total, 5);
      assert.equal(body.conversations.open, 2);
    } finally {
      server.close();
    }
  });

  it("redirects unauthenticated /operations to /login", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operations`, { redirect: "manual" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/login");
    } finally {
      server.close();
    }
  });

  it("returns operations overview HTML after authentication", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: () => ({
        messages: { inboundTotal: 10, outboundTotal: 5, internalTotal: 2 },
        deliveries: { pending: 1, sent: 5, failed: 2, permanentFailure: 0 },
        conversations: { open: 3, closed: 1 },
        aiDrafts: { pending: 0, ready: 1, failed: 0, sent: 2, discarded: 1 },
        uptimeSeconds: 3600,
      }),
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const loginRes = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        body: new URLSearchParams({ setupToken: "setup-token" }),
        redirect: "manual",
      });
      const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      const res = await fetch(`http://127.0.0.1:${port}/operations`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /消息总量/);
      assert.match(html, /投递状态/);
      assert.match(html, /10/);
    } finally {
      server.close();
    }
  });

  it("handles Node Web Console logout through the shared Fetch handler", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const loginRes = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        body: new URLSearchParams({ setupToken: "setup-token" }),
        redirect: "manual",
      });
      const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);

      const logoutRes = await fetch(`http://127.0.0.1:${port}/logout`, {
        method: "POST",
        headers: { cookie },
        redirect: "manual",
      });

      assert.equal(logoutRes.status, 302);
      assert.equal(logoutRes.headers.get("location"), "/login");
      assert.match(logoutRes.headers.get("set-cookie") ?? "", /Max-Age=0/);
    } finally {
      server.close();
    }
  });
});
