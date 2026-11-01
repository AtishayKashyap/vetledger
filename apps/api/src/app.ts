import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { requireAuth } from "./auth/middleware.js";
import type { Deps } from "./deps.js";
import { createGraphqlMiddleware } from "./graphql/index.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { openapi } from "./openapi.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { inventoryRouter } from "./routes/inventory.js";
import { patientsRouter } from "./routes/patients.js";

export async function createApp(deps: Deps): Promise<Express> {
  const { config, db, redis, metrics, logger } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY); // correct client IPs for rate limiting behind a proxy

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      autoLogging: { ignore: (req) => ["/healthz", "/readyz", "/metrics"].includes(req.url ?? "") },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    }),
  );

  // RED metrics keyed by route *template* (/api/animals/:id), keeping label cardinality bounded.
  app.use((req, res, next) => {
    const end = metrics.httpDuration.startTimer();
    res.on("finish", () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl || "unmatched";
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  });

  app.use(helmet());
  // CORS is deliberately absent: the web app is served same-origin (Vite proxy in dev,
  // nginx/Vercel rewrites in prod), so browsers never make cross-origin API calls.
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", async (_req, res) => {
    try {
      await Promise.all([sql`SELECT 1`.execute(db), redis.ping()]);
      res.json({ status: "ready" });
    } catch (err) {
      logger.warn({ err }, "readiness check failed");
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.get("/metrics", async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });
  app.get("/api/openapi.json", (_req, res) => res.json(openapi));

  const store = (prefix: string) =>
    new RedisStore({ prefix, sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply> });
  const limiter = (limit: number, prefix: string) =>
    rateLimit({ windowMs: 60_000, limit, standardHeaders: "draft-8", legacyHeaders: false, store: store(prefix) });

  app.use("/api/auth/login", limiter(config.AUTH_RATE_LIMIT_PER_MIN, "rl:login:"));
  app.use("/api/auth", authRouter(deps));

  const api = express.Router();
  api.use(limiter(config.RATE_LIMIT_PER_MIN, "rl:api:"));
  api.use(requireAuth(config.JWT_SECRET));
  api.use("/graphql", await createGraphqlMiddleware(db, config.NODE_ENV === "production"));
  api.use(patientsRouter(deps));
  api.use(inventoryRouter(deps));
  api.use(adminRouter(deps));
  app.use("/api", api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
