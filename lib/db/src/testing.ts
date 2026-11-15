import pg from "pg";

const databaseName = (value: string) => decodeURIComponent(new URL(value).pathname.slice(1));

/** A different schema, username, spelling, or host is NOT sufficient isolation. */
export function assertTestDatabase(testUrl: string | undefined, demoUrl: string | undefined): asserts testUrl is string {
  if (!testUrl || !demoUrl) throw new Error("TEST_DATABASE_URL and demo DATABASE_URL are required for the safety check");
  const name = databaseName(testUrl);
  if (!/^[a-z][a-z0-9_]*_test$/.test(name) || name === databaseName(demoUrl)) {
    throw new Error("رفض اختبار تدميري: يلزم اسم قاعدة مختلف ينتهي بـ _test، وليس قاعدة العرض أو مخططًا داخلها");
  }
}

export async function assertTestMarker(pool: pg.Pool, demoUrl: string): Promise<void> {
  const result = await pool.query("SELECT current_database() AS name, to_regclass('public._servicna_test_marker') AS marker");
  if (result.rows[0].name === databaseName(demoUrl) || !result.rows[0].name.endsWith("_test") || !result.rows[0].marker) {
    throw new Error("رفض تنظيف قاعدة غير معزولة أو غير موسومة كقاعدة اختبار");
  }
  const marker = await pool.query("SELECT purpose FROM public._servicna_test_marker");
  if (marker.rows.length !== 1 || marker.rows[0].purpose !== "servicna-disposable-tests") throw new Error("وسم قاعدة الاختبار غير صالح");
}

/** Creates a physically separate database once. Existing unmarked DBs are never
 * adopted or cleaned, even if their name looks like a test database. */
export async function prepareTestDatabase(demoUrl: string, configuredUrl?: string): Promise<string> {
  const url = new URL(configuredUrl ?? demoUrl);
  if (!configuredUrl) url.pathname = "/servicna_test";
  const target = url.toString();
  assertTestDatabase(target, demoUrl);
  const name = databaseName(target);
  const admin = new pg.Pool({ connectionString: configuredUrl ? target : demoUrl });
  let created = false;
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!exists.rowCount) {
      // name already restricted to lowercase alphanumeric/underscore above.
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
    }
  } finally { await admin.end(); }
  const pool = new pg.Pool({ connectionString: target });
  try {
    if (created) {
      await pool.query("CREATE TABLE public._servicna_test_marker (purpose text PRIMARY KEY)");
      await pool.query("INSERT INTO public._servicna_test_marker VALUES ('servicna-disposable-tests')");
    }
    await assertTestMarker(pool, demoUrl);
  } finally { await pool.end(); }
  return target;
}
