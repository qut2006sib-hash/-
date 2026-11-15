import { pool } from "@workspace/db";
import { setupAccounts, setupDemoAccounts } from "../lib/accounts";
import { logger } from "../lib/logger";

try {
  if (process.argv.includes("--demo")) await setupDemoAccounts(process.argv.includes("--if-needed"));
  else await setupAccounts();
  logger.info("تم إعداد الحسابات السبعة مع الحفاظ على معرّفاتها وإبطال جلساتها القديمة");
} catch (err) {
  // Never log env, passwords, hashes, query parameters, or connection strings.
  const message = err instanceof Error ? err.message : "";
  logger.error(/^[\u0600-\u06ff]/.test(message) ? message : "تعذّر إعداد الحسابات؛ راجع المخطط واتصال القاعدة");
  process.exitCode = 1;
} finally { await pool.end(); }
