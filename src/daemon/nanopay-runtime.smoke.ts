import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import { openDb } from "../verdict/db-bootstrap.js";
import { NanopayRuntimeConfigError } from "../verdict/nanopay-config.js";
import {
  loadDaemonNanopayRuntime,
  loadDaemonNanopayRuntimeConfig,
} from "./nanopay-runtime.js";

const pipelineId = `0x${"1".repeat(64)}`;
const sellerAddress = `0x${"2".repeat(40)}`;
const domainContract = `0x${"3".repeat(40)}`;

const ambientEnvKeys = [
  "MURMUR_NANOPAY_DOMAIN_CHAIN_ID",
  "MURMUR_NANOPAY_DOMAIN_CONTRACT",
  "MURMUR_NANOPAY_ENABLED",
  "MURMUR_NANOPAY_PIPELINES",
  "MURMUR_NANOPAY_SELLER_ADDRESS",
] as const;
const priorEnv = new Map(ambientEnvKeys.map((key) => [key, process.env[key]]));

process.env.MURMUR_NANOPAY_ENABLED = "true";
process.env.MURMUR_NANOPAY_DOMAIN_CHAIN_ID = "84532";
process.env.MURMUR_NANOPAY_DOMAIN_CONTRACT = `0x${"4".repeat(40)}`;
process.env.MURMUR_NANOPAY_SELLER_ADDRESS = `0x${"5".repeat(40)}`;
process.env.MURMUR_NANOPAY_PIPELINES =
  `${pipelineId}:1000:${process.env.MURMUR_NANOPAY_SELLER_ADDRESS}:84532`;

const tmp = mkdtempSync(join(tmpdir(), "murmur-nanopay-runtime-smoke-"));
const db = openDb({ path: join(tmp, "verdict.db") });
let server: Server | null = null;

const logger = {
  log() {},
  warn() {},
};

try {
  const disabledConfig = loadDaemonNanopayRuntimeConfig({
    env: {},
    fhenixChainId: null,
    fhenixSealedVerdictsAddress: null,
    logger,
  });
  const disabledRuntime = loadDaemonNanopayRuntime({
    db,
    config: disabledConfig,
    logger,
    now: () => new Date("2026-06-12T10:05:00Z"),
  });
  assert.equal(disabledRuntime, null);

  assert.throws(
    () =>
      loadDaemonNanopayRuntimeConfig({
        env: { MURMUR_NANOPAY_ENABLED: "yes" },
        fhenixChainId: null,
        fhenixSealedVerdictsAddress: null,
        logger,
      }),
    (err) =>
      err instanceof NanopayRuntimeConfigError &&
      err.key === "MURMUR_NANOPAY_ENABLED",
  );

  assert.throws(
    () =>
      loadDaemonNanopayRuntimeConfig({
        env: {
          MURMUR_NANOPAY_ENABLED: "true",
          MURMUR_NANOPAY_DOMAIN_CHAIN_ID: "84532",
          MURMUR_NANOPAY_DOMAIN_CONTRACT: domainContract,
          MURMUR_NANOPAY_SELLER_ADDRESS: sellerAddress,
          MURMUR_NANOPAY_NETWORK: "production",
        },
        fhenixChainId: null,
        fhenixSealedVerdictsAddress: null,
        logger,
      }),
    (err) =>
      err instanceof NanopayRuntimeConfigError &&
      err.key === "MURMUR_NANOPAY_NETWORK",
  );

  const runtimeConfig = loadDaemonNanopayRuntimeConfig({
    env: {
      MURMUR_NANOPAY_ENABLED: "true",
      MURMUR_NANOPAY_DOMAIN_CHAIN_ID: "84532",
      MURMUR_NANOPAY_DOMAIN_CONTRACT: domainContract,
      MURMUR_NANOPAY_SELLER_ADDRESS: sellerAddress,
      MURMUR_NANOPAY_DEFAULT_PRICE: "$0.001",
      MURMUR_NANOPAY_PIPELINES: `${pipelineId}:1000:${sellerAddress}:84532`,
    },
    fhenixChainId: null,
    fhenixSealedVerdictsAddress: null,
    logger,
  });
  const runtime = loadDaemonNanopayRuntime({
    db,
    config: runtimeConfig,
    logger,
    now: () => new Date("2026-06-12T10:05:00Z"),
  });
  assert.ok(runtime);

  const app = express();
  runtime.mount(app);
  const started = await listen(app);
  server = started.server;

  const response = await fetch(
    `http://127.0.0.1:${started.port}/v2/nanopay/infer/${pipelineId}`,
    { method: "POST" },
  );
  assert.equal(response.status, 503);
  const body = await response.json() as { error?: string };
  assert.equal(body.error, "NoSignalAvailable");

  console.log("nanopay-runtime smoke ok");
} finally {
  if (server) await closeServer(server);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  restoreEnv();
}

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("server did not bind tcp address"));
        return;
      }
      resolve({ server: s, port: addr.port });
    });
    s.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function restoreEnv(): void {
  for (const key of ambientEnvKeys) {
    const value = priorEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
