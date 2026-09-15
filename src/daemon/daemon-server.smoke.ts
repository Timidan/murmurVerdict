import assert from "node:assert/strict";
import express from "express";

import { startDaemonHttpServer } from "./daemon-server.js";

const app = express();
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const runtime = await startDaemonHttpServer(app, 0);

try {
  assert(runtime.port > 0);
  const res = await fetch(`http://127.0.0.1:${runtime.port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  await assert.rejects(startDaemonHttpServer(express(), runtime.port), { code: "EADDRINUSE" });
  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.equal(
    secondClose,
    firstClose,
    "close should return the in-flight server shutdown promise",
  );
  await firstClose;
  await runtime.close();

  console.log("daemon-server smoke ok");
} catch (err) {
  await runtime.close();
  throw err;
}
