import type { Database } from "../storage/client.js";

export interface AppSetting {
  key: string;
  value: string;
  updatedAt: string;
}

export class AppSettingsService {
  constructor(private readonly db: Database) {}

  all(): NodeJS.ProcessEnv {
    const rows = this.db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string }>;
    const env: NodeJS.ProcessEnv = {};
    for (const row of rows) env[row.key] = row.value;
    return env;
  }

  get(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMany(values: Record<string, string>): void {
    const updatedAt = new Date().toISOString();
    const statement = this.db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.db.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(values)) statement.run(key, value, updatedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
