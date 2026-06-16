import "dotenv/config";
import express from "express";
import { registryRouter } from "./routes/registry.js";
import { eventsRouter } from "./routes/events.js";
import { adminRouter } from "./routes/admin.js";

/**
 * Backend remoto de browser-memory: registro de tools curadas + ingesta de eventos de uso.
 * El cliente MCP le pega siempre (la URL viene hardcodeada en el cliente).
 */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "browser-memory-backend" });
});

app.use("/v1/registry", registryRouter);
app.use("/v1/events", eventsRouter);
app.use("/v1/admin", adminRouter);

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  process.stdout.write(`[backend] escuchando en http://127.0.0.1:${port}\n`);
});
