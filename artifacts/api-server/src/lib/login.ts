import { createHmac, randomBytes } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { db, loginAttemptsTable } from "@workspace/db";
import * as argon2 from "argon2";
import { HttpError } from "./http";
import { now } from "./clock";

export const passwordOptions = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
let dummyHash: Promise<string> | undefined;
export const verifyPassword = async (hash: string | null | undefined, password: string) => {
  dummyHash ??= argon2.hash(randomBytes(32), passwordOptions);
  return argon2.verify(hash ?? await dummyHash, password);
};
const WINDOW_MS = 15 * 60 * 1000;
function bucket(value: string) {
  return createHmac("sha256", process.env.SESSION_SECRET!).update(value).digest("hex");
}
export async function limitLogin(ip: string, loginName: string): Promise<void> {
  for (const [key, limit] of [[bucket(`ip:${ip}`), 30], [bucket(`account:${loginName}`), 5]] as const) {
    const time = now();
    const [row] = await db.insert(loginAttemptsTable)
      .values({ key, count: 1, resetAt: new Date(time.getTime() + WINDOW_MS) })
      .onConflictDoUpdate({
        target: loginAttemptsTable.key,
        set: {
          count: sql`case when ${loginAttemptsTable.resetAt} <= ${time} then 1 else ${loginAttemptsTable.count} + 1 end`,
          resetAt: sql`case when ${loginAttemptsTable.resetAt} <= ${time} then ${new Date(time.getTime() + WINDOW_MS)} else ${loginAttemptsTable.resetAt} end`,
        },
      }).returning();
    if (row!.count > limit) throw new HttpError(429, "محاولات دخول كثيرة. حاول بعد خمس عشرة دقيقة", "RATE_LIMITED");
  }
}
export async function clearLoginFailures(loginName: string) {
  await db.delete(loginAttemptsTable).where(eq(loginAttemptsTable.key, bucket(`account:${loginName}`)));
}
