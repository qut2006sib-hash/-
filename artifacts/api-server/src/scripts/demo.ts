import { pool } from "@workspace/db";
import { ensureBaseData, resetDynamicData, prepareDemoScenario } from "../lib/seed";
import { logger } from "../lib/logger";

try {
  if (process.env.DEMO_MODE !== "true") throw new Error("يلزم DEMO_MODE=true لأدوات العرض");
  await ensureBaseData();
  if (process.argv.includes("--reset")) await resetDynamicData();
  else if (!process.argv.includes("--base-only")) await prepareDemoScenario();
  logger.info(process.argv.includes("--reset") ? "أُعيد العرض لحالة خالية من الرحلات والطلبات" : "تم إعداد بيانات العرض المطلوبة");
} catch (err) {
  const message = err instanceof Error ? err.message : "";
  logger.error(/^[\u0600-\u06ff]/.test(message) ? message : "تعذّر تحضير العرض؛ راجع المخطط واتصال القاعدة");
  process.exitCode = 1;
} finally { await pool.end(); }
