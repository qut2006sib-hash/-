import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Compare a pre-migration DB to the checked-in baseline before adopting it.
 * Uses a temporary schema containing the baseline SQL, not hand-maintained lists.
 * No demo rows are changed. */
async function assertBaseline(client: pg.PoolClient): Promise<void> {
  const baseline = await readFile(path.join(migrationsFolder, "0000_baseline.sql"), "utf8");
  await client.query("CREATE SCHEMA servicna_baseline_check");
  await client.query("SET LOCAL search_path TO servicna_baseline_check");
  await client.query(baseline.replaceAll('"public".', '"servicna_baseline_check".'));
  const signature = async (schema: string) => {
    const cols = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`, [schema]);
    const constraints = await client.query(`
      SELECT t.relname AS table_name, c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1
      ORDER BY t.relname, c.conname`, [schema]);
    const indexes = await client.query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname", [schema]);
    return JSON.stringify([cols.rows, constraints.rows, indexes.rows])
      .replaceAll(`${schema}.`, "").replaceAll(`"${schema}".`, "");
  };
  if (await signature("public") !== await signature("servicna_baseline_check")) {
    throw new Error("المخطط الموجود لا يطابق الترحيل الأولي؛ لم تُعتمد القاعدة ولم تتغير بياناتها");
  }
  await client.query("DROP SCHEMA servicna_baseline_check CASCADE");
  await client.query("SET LOCAL search_path TO public");
}

export async function runMigrations(pool: pg.Pool, adoptExisting = false): Promise<void> {
  const client = await pool.connect();
  try {
    // One connection owns the lock across adoption and Drizzle's transaction.
    await client.query("SELECT pg_advisory_lock(735302)");
    const existing = await client.query("SELECT to_regclass('public.users') AS users, to_regclass('drizzle.__drizzle_migrations') AS journal");
    if (existing.rows[0].users && !existing.rows[0].journal) {
      if (!adoptExisting) throw new Error("قاعدة موجودة بلا سجل ترحيلات؛ استخدم migrate --adopt-existing للمطابقة الآمنة أول مرة");
      await client.query("BEGIN");
      try {
        await assertBaseline(client);
        const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
        const sql = await readFile(path.join(migrationsFolder, "0000_baseline.sql"), "utf8");
        await client.query("CREATE SCHEMA drizzle");
        await client.query("CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)");
        await client.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [createHash("sha256").update(sql).digest("hex"), journal.entries[0].when]);
        await client.query("COMMIT");
      } catch (err) { await client.query("ROLLBACK"); throw err; }
    }
    // Refuse editing already-applied migrations.
    const journalExists = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS journal");
    if (journalExists.rows[0].journal) {
      const applied = await client.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations");
      const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
      for (const entry of journal.entries) {
        const row = applied.rows.find((r) => Number(r.created_at) === entry.when);
        if (row) {
          const contents = await readFile(path.join(migrationsFolder, `${entry.tag}.sql`), "utf8");
          if (row.hash !== createHash("sha256").update(contents).digest("hex")) throw new Error(`ترحيل مطبّق تغيّر: ${entry.tag}`);
        }
      }
    }
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query("SELECT pg_advisory_unlock(735302)");
    client.release();
  }
}
