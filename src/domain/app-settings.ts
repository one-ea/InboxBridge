import type { Database } from "../ports/database.js";
import type { ConfigMap } from "../runtime/config.js";

export interface AppSetting {
  key: string;
  value: string;
  updatedAt: string;
}

export class AppSettingsService {
  constructor(private readonly db: Database) {}

  async all(): Promise<ConfigMap> {
    const rows = (await this.db.prepare("SELECT key, value FROM app_settings").all()) as Array<{ key: string; value: string }>;
    const env: ConfigMap = {};
    for (const row of rows) env[row.key] = row.value;
    return env;
  }

  async get(key: string): Promise<string | undefined> {
    const row = (await this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)) as { value: string } | undefined;
    return row?.value;
  }

  async setMany(values: Record<string, string>): Promise<void> {
    const updatedAt = new Date().toISOString();
    const statement = this.db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    await this.db.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(values)) await statement.run(key, value, updatedAt);
      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
