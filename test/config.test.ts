import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configIssues, loadConfig, loadConfigFromSources, loadDatabaseConfig, loadEnv } from "../src/runtime/config.js";
import { AppSettingsService } from "../src/domain/app-settings.js";
import { createTestDatabase, disposeTestDatabase, handle, testTempDir } from "./support/harness.js";

beforeEach(createTestDatabase);
afterEach(disposeTestDatabase);

describe("configuration", () => {
  it("parses required Telegram and runtime settings", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_UPDATE_MODE: "polling",
      TELEGRAM_ADMIN_USER_IDS: "1, 2",
    });

    assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1, 2]);
    assert.equal(config.DATABASE_URL, "file:./data/inboxbridge.sqlite");
    assert.equal(config.DEFAULT_CONVERSATION_RETENTION_DAYS, 30);
    assert.equal(config.CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES, 60);
  });

  it("supports never as the default conversation retention policy", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_UPDATE_MODE: "polling",
      TELEGRAM_ADMIN_USER_IDS: "1",
      DEFAULT_CONVERSATION_RETENTION_DAYS: "never",
    });

    assert.equal(config.DEFAULT_CONVERSATION_RETENTION_DAYS, null);
  });

  it("loads database-only config without Telegram credentials", () => {
    const config = loadDatabaseConfig({});
    assert.equal(config.DATABASE_URL, "file:./data/inboxbridge.sqlite");
    assert.equal(config.WEB_CONSOLE_PORT, 3000);
  });

  it("loads runtime config from saved settings while allowing env overrides", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({
      TELEGRAM_BOT_TOKEN: "from-db",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1",
      AI_DRAFTS_ENABLED: "false",
    });

    const config = loadConfigFromSources(await settings.all(), { TELEGRAM_BOT_TOKEN: "from-env" });

    assert.equal(config.TELEGRAM_BOT_TOKEN, "from-env");
    assert.equal(config.TELEGRAM_MANAGEMENT_CHAT_ID, -1001);
    assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1]);
    assert.equal(config.AI_DRAFTS_ENABLED, false);
  });

  it("loads saved settings through an async settings API", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ TELEGRAM_BOT_TOKEN: "from-db" });

    const stored = settings.all();

    assert.equal(stored instanceof Promise, true);
    assert.equal((await stored).TELEGRAM_BOT_TOKEN, "from-db");
  });

  it("loads runtime config from a platform-neutral config map", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1,2",
      AI_DRAFTS_ENABLED: "false",
    });

    assert.equal(config.TELEGRAM_BOT_TOKEN, "token");
    assert.equal(config.TELEGRAM_MANAGEMENT_CHAT_ID, -1001);
    assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1, 2]);
    assert.equal(config.AI_DRAFTS_ENABLED, false);
  });

  it("does not let repository .env values override saved runtime settings", async () => {
    const previousCwd = process.cwd();
    const envKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_MANAGEMENT_CHAT_ID", "TELEGRAM_ADMIN_USER_IDS"];
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    await writeFile(
      join(testTempDir(), ".env"),
      [
        "TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_MANAGEMENT_CHAT_ID=-2002",
        "TELEGRAM_ADMIN_USER_IDS=2",
      ].join("\n"),
    );

    try {
      process.chdir(testTempDir());
      for (const key of envKeys) delete process.env[key];
      const config = loadConfigFromSources({
        TELEGRAM_BOT_TOKEN: "from-db",
        TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
        TELEGRAM_ADMIN_USER_IDS: "1",
      });

      assert.equal(config.TELEGRAM_BOT_TOKEN, "from-db");
      assert.equal(config.TELEGRAM_MANAGEMENT_CHAT_ID, -1001);
      assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1]);
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      process.chdir(previousCwd);
    }
  });

  it("reports missing runtime settings for web console setup", () => {
    const issues = configIssues({}, {});

    assert.ok(issues.some((issue) => issue.includes("TELEGRAM_BOT_TOKEN")));
    assert.ok(issues.some((issue) => issue.includes("TELEGRAM_MANAGEMENT_CHAT_ID")));
  });

  it("loads values from .env without overriding shell env", async () => {
    const envPath = join(testTempDir(), ".env");
    await writeFile(
      envPath,
      [
        "TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_MANAGEMENT_CHAT_ID=-1001",
        "TELEGRAM_ADMIN_USER_IDS=1,2",
        "DATABASE_URL=file:./file.sqlite",
      ].join("\n"),
    );

    const loaded = loadEnv({ TELEGRAM_BOT_TOKEN: "from-shell" }, envPath);
    const config = loadConfig(loaded);
    assert.equal(config.TELEGRAM_BOT_TOKEN, "from-shell");
    assert.equal(config.TELEGRAM_MANAGEMENT_CHAT_ID, -1001);
    assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1, 2]);
  });
});
