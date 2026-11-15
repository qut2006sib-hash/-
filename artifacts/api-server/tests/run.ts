import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { prepareTestDatabase } from "@workspace/db/testing";

try {
  const demoUrl = process.env.DATABASE_URL;
  if (!demoUrl) throw new Error("DATABASE_URL required");
  const testUrl = await prepareTestDatabase(demoUrl, process.env.TEST_DATABASE_URL);
  const result = spawnSync("pnpm", ["exec", "vitest", "run"], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent", DEMO_MODE: "true",
      DATABASE_URL: testUrl, TEST_DATABASE_URL: testUrl, SERVICNA_DEMO_DATABASE_URL: demoUrl,
      SERVICNA_ISOLATED_TESTS: "1", SESSION_SECRET: randomBytes(48).toString("hex") },
  });
  process.exitCode = result.status ?? 1;
} catch {
  process.stderr.write("تعذّر بدء الاختبارات: تحقق من قاعدة اختبار مستقلة تنتهي بـ _test ووسمها وصلاحية إنشائها. لم تُنظّف قاعدة العرض.\n");
  process.exitCode = 1;
}
