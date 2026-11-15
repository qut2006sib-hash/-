import type { RequestHandler } from "express";
import { HttpError } from "./http";

/** No forwarded headers are accepted as a source of trusted origins. */
export const checkOrigin: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origins = new Set(
    [process.env.APP_ORIGIN, ...[process.env.REPLIT_DOMAINS, process.env.REPLIT_DEV_DOMAIN]
      .flatMap((value) => value?.split(",").map((domain) => `https://${domain.trim()}`) ?? [])]
      .filter((value): value is string => Boolean(value)),
  );
  // Host cannot be changed by browser JS. This also supports the same-origin
  // reverse proxy without treating client-supplied X-Forwarded-Host as trusted.
  if (req.get("host")) origins.add(`https://${req.get("host")}`);
  const origin = req.get("origin");
  if (!origin || origin === "null" || !origins.has(origin)) {
    return next(new HttpError(403, "مصدر الطلب غير مسموح. افتح التطبيق من صفحته الأصلية وحاول مجددًا", "FORBIDDEN"));
  }
  next();
};
