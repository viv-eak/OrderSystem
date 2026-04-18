import pino from "pino";
import pinoHttp from "pino-http";

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info") {
  return pino({
    name,
    level,
    transport:
      process.env.NODE_ENV === "development"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              ignore: "pid,hostname"
            }
          }
        : undefined
  });
}

export function createHttpLogger(logger: pino.Logger) {
  return pinoHttp({
    logger,
    customProps: (req) => ({
      correlationId: req.headers["x-correlation-id"]
    })
  });
}
