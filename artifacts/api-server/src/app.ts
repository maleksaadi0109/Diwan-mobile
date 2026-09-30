import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
// Replit's public ingress is one proxy hop; use its forwarded client IP rather
// than charging every phone to the proxy's shared address.
app.set("trust proxy", 1);

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// The publishing startup probe requests /. Keep this route lightweight and
// unauthenticated; the API's detailed health response remains at /api/healthz.
app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", router);

export default app;
