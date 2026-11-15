import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorHandler, notFound } from "./lib/http";
import { loadSessionUser } from "./lib/session";
import { checkOrigin } from "./lib/origin";

const sessionSecret = process.env["SESSION_SECRET"];
if (!sessionSecret) {
  throw new Error("SESSION_SECRET environment variable is required.");
}

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(checkOrigin);
app.use(express.json({ limit: "16kb" }));
app.use(cookieParser(sessionSecret));
app.use(loadSessionUser);

app.use("/api", router);
app.use((_req, _res, next) => next(notFound("المسار غير موجود")));
app.use(errorHandler);

export default app;
