import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    base: { service: "vetledger-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Defence in depth: never log credentials even if a handler logs a whole request.
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']", "*.password", "*.passwordHash"],
      censor: "[redacted]",
    },
  });
}
export type Logger = ReturnType<typeof createLogger>;
