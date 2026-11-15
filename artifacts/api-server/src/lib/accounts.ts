import * as argon2 from "argon2";
import { eq, sql } from "drizzle-orm";
import { appSettingsTable, db, sessionsTable, usersTable } from "@workspace/db";
import { passwordOptions } from "./login";

export const DEMO_ACCOUNTS = [
  { key: "passenger-1", name: "سارة ح.", role: "passenger", secret: "DEMO_PASSENGER_1_PASSWORD" },
  { key: "passenger-2", name: "عمر أ.", role: "passenger", secret: "DEMO_PASSENGER_2_PASSWORD" },
  { key: "passenger-3", name: "ليلى د.", role: "passenger", secret: "DEMO_PASSENGER_3_PASSWORD" },
  { key: "driver-1", name: "أبو خ.", role: "driver", secret: "DEMO_DRIVER_1_PASSWORD" },
  { key: "driver-2", name: "أبو س.", role: "driver", secret: "DEMO_DRIVER_2_PASSWORD" },
  { key: "driver-3", name: "محمود س.", role: "driver", secret: "DEMO_DRIVER_3_PASSWORD" },
  { key: "admin-1", name: "إدارة س.", role: "admin", secret: "DEMO_ADMIN_1_PASSWORD" },
] as const;

/** All secrets are validated before hashing/writing; no fallback credentials. */
export async function setupAccounts(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const missing = DEMO_ACCOUNTS.filter((a) => !env[a.secret]);
  if (missing.length) throw new Error(`أسرار إعداد الحسابات ناقصة: ${missing.map((a) => a.secret).join(", ")}`);
  if (DEMO_ACCOUNTS.some((a) => env[a.secret]!.length < 12 || env[a.secret]!.length > 128)) {
    throw new Error("يجب أن تكون كلمات مرور العرض بين 12 و128 محرفًا");
  }
  const hashes: string[] = [];
  for (const account of DEMO_ACCOUNTS) hashes.push(await argon2.hash(env[account.secret]!, passwordOptions));
  await saveAccounts(hashes);
}

/** Explicit passwordless setup for these seven fictional accounts only. */
export async function setupDemoAccounts(onlyIfNeeded = false): Promise<void> {
  if (process.env.DEMO_MODE !== "true") throw new Error("إعداد الحسابات بلا كلمة مرور متاح فقط مع DEMO_MODE=true");
  await saveAccounts(DEMO_ACCOUNTS.map(() => null), { onlyIfNeeded });
}

async function saveAccounts(hashes: Array<string | null>, demo?: { onlyIfNeeded: boolean }): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(735301)`);
    if (demo?.onlyIfNeeded) {
      const [initialized] = await tx.select().from(appSettingsTable).where(eq(appSettingsTable.key, "demo_accounts_initialized"));
      if (initialized) return;
    }
    for (const [i, account] of DEMO_ACCOUNTS.entries()) {
      const [existing] = await tx.select().from(usersTable).where(eq(usersTable.key, account.key));
      if (existing && existing.role !== account.role) throw new Error(`دور الحساب الحالي لا يطابق حساب العرض: ${account.key}`);
      // Conflict by stable key, never delete/reinsert accounts or change ids.
      const [user] = await tx.insert(usersTable).values({
        key: account.key, loginName: account.key, name: account.name,
        role: account.role, passwordHash: hashes[i]!, enabled: true,
      }).onConflictDoUpdate({
        target: usersTable.key,
        set: { loginName: account.key, name: account.name, passwordHash: hashes[i]!, enabled: true },
      }).returning({ id: usersTable.id });
      await tx.delete(sessionsTable).where(eq(sessionsTable.userId, user!.id));
    }
    if (demo) await tx.insert(appSettingsTable).values({ key: "demo_accounts_initialized", value: "true" }).onConflictDoNothing();
  });
}
