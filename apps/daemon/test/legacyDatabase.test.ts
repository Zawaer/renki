import Database from "better-sqlite3";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupConfig, makeTestConfig } from "./helpers.js";
import { openDb } from "../src/db/index.js";

/**
 * The database was `crc.sqlite` before the project was renamed to Renki.
 * Starting fresh on an install that has one is the worst kind of data loss —
 * every session still on disk, none of it visible — so the daemon adopts it.
 */
const created: ReturnType<typeof makeTestConfig>[] = [];
afterEach(() => {
  for (const c of created.splice(0)) cleanupConfig(c);
});

function configWithDataDir() {
  const config = makeTestConfig();
  created.push(config);
  const dataDir = mkdtempSync(join(tmpdir(), "renki-dbtest-"));
  return { ...config, dataDir, dbPath: resolve(dataDir, "renki.sqlite") };
}

describe("adopting the pre-rename database", () => {
  it("takes over crc.sqlite, keeping the rows that were in it", () => {
    const config = configWithDataDir();
    const legacy = resolve(config.dataDir, "crc.sqlite");
    const seed = new Database(legacy);
    seed.exec("CREATE TABLE marker (note TEXT)");
    seed.prepare("INSERT INTO marker VALUES (?)").run("survived the rename");
    seed.close();

    const db = openDb(config);

    expect(existsSync(config.dbPath)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    const row = db.$client.prepare("SELECT note FROM marker").get() as { note: string };
    expect(row.note).toBe("survived the rename");
  });

  it("brings the WAL sidecar along, so a committed-but-uncheckpointed tail isn't stranded", () => {
    const config = configWithDataDir();
    const legacy = resolve(config.dataDir, "crc.sqlite");
    new Database(legacy).close();
    writeFileSync(`${legacy}-wal`, "not really a wal, but it must travel");

    openDb(config);

    expect(existsSync(`${config.dbPath}-wal`)).toBe(true);
    expect(existsSync(`${legacy}-wal`)).toBe(false);
  });

  it("leaves an existing renki.sqlite alone rather than overwriting it", () => {
    const config = configWithDataDir();
    const current = new Database(config.dbPath);
    current.exec("CREATE TABLE marker (note TEXT)");
    current.prepare("INSERT INTO marker VALUES (?)").run("the real one");
    current.close();
    const legacy = new Database(resolve(config.dataDir, "crc.sqlite"));
    legacy.exec("CREATE TABLE marker (note TEXT)");
    legacy.prepare("INSERT INTO marker VALUES (?)").run("the stale one");
    legacy.close();

    const db = openDb(config);

    const row = db.$client.prepare("SELECT note FROM marker").get() as { note: string };
    expect(row.note).toBe("the real one");
  });

  it("does nothing at all on a fresh install", () => {
    const config = configWithDataDir();
    expect(() => openDb(config)).not.toThrow();
    expect(existsSync(config.dbPath)).toBe(true);
  });
});
