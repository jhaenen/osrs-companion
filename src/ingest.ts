#!/usr/bin/env node
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { playerSyncDataSchema } from "./schema.js";
import { writeSnapshot } from "./snapshotStore.js";

const TOKEN = process.env.INGEST_TOKEN;
if (!TOKEN) {
  console.error("INGEST_TOKEN is not set - refusing to start.");
  process.exit(1);
}

function tokenMatches(presented: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN as string);
  // timingSafeEqual throws on length mismatch rather than returning false,
  // and a length check up front would itself leak length via timing - pad
  // instead so the comparison is always constant-time for the buffer size.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/snapshot", (req, res) => {
  const auth = req.header("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!presented || !tokenMatches(presented)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const parsed = playerSyncDataSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error("Rejected snapshot for", req.body?.player?.username, JSON.stringify(parsed.error.flatten()));
    res.status(400).json({ error: "invalid payload", details: parsed.error.flatten() });
    return;
  }

  writeSnapshot(parsed.data)
    .then(() => res.status(204).end())
    .catch((err) => {
      console.error("Failed to write snapshot:", err);
      res.status(500).json({ error: "internal error" });
    });
});

app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`OSRS ingest endpoint listening on http://0.0.0.0:${port}/snapshot`);
});
