import { pool } from "../src/index";
import { runMigrations } from "../src/migrations";

try {
  await runMigrations(pool, process.argv.includes("--adopt-existing"));
  process.stdout.write("تم تطبيق الترحيلات المحفوظة بنجاح\n");
} catch (err) {
  // SQL errors may contain parameters/connection details. Only our own messages
  // are safe; otherwise use an explicit generic failure.
  const message = err instanceof Error ? err.message : "";
  process.stderr.write(/^[\u0600-\u06ff]/.test(message) ? `${message}\n` : "تعذّر تطبيق الترحيلات؛ راجع اتصال القاعدة وتوافق المخطط\n");
  process.exitCode = 1;
} finally { await pool.end(); }
