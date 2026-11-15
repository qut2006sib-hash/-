import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : "INTERNAL_ERROR",
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = "INVALID_INPUT") => new HttpError(400, msg, code);
export const conflict = (msg: string, code = "INVALID_STATE") => new HttpError(409, msg, code);
export const notFound = (msg: string) => new HttpError(404, msg, "NOT_FOUND");

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ code: err.code, message: err.message });
    return;
  }
  if (err instanceof ZodError) {
    req.log.warn({ issues: err.issues }, "validation failed");
    res.status(400).json({ code: "INVALID_INPUT", message: "البيانات المرسلة غير صالحة" });
    return;
  }
  const bodyError = err as { type?: string };
  if (bodyError?.type === "entity.parse.failed" || bodyError?.type === "entity.too.large") {
    res.status(bodyError.type === "entity.too.large" ? 413 : 400)
      .json({ code: bodyError.type === "entity.too.large" ? "PAYLOAD_TOO_LARGE" : "INVALID_INPUT", message: "البيانات المرسلة غير صالحة أو أكبر من الحجم المسموح" });
    return;
  }
  req.log.error({ err }, "unhandled error");
  res.status(500).json({ code: "INTERNAL_ERROR", message: "حدث خطأ غير متوقع في الخادم" });
}
