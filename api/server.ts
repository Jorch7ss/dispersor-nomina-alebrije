/**
 * API HTTP para conectar el dispersor con el frontend nomillar.vercel.app
 *
 * Uso: npx tsx api/server.ts
 * Puerto: 3001 (evita conflicto con SDP :8000 y UI :3000)
 *
 * Endpoints:
 *   POST /api/dispersar  - Body: { csv: "phone,amount,...\n+52...,1.00,..." }
 *   GET  /health         - Health check
 */
import { createServer } from "node:http";
import { config } from "dotenv";

import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "alebrije-flow/.env") });
import { dispersarDesdeCsv } from "../alebrije-flow/src/dispersar-direct";
import { getBatch } from "../alebrije-flow/src/payroll-store";
import { verifyCommitment } from "../alebrije-flow/src/commitment";

const PORT = parseInt(
  process.env.PORT ?? process.env.API_PORT ?? "3001",
  10
);
const AUDITOR_TOKEN = process.env.AUDITOR_TOKEN;
const STELLAR_EXPERT_TESTNET = "https://stellar.expert/explorer/testnet/tx";

function txExplorerUrl(txHash: string | null): string | null {
  return txHash ? `${STELLAR_EXPERT_TESTNET}/${txHash}` : null;
}
const CORS_ORIGINS = [
  "https://nomillar.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function isAllowedOrigin(origin: string): boolean {
  if (CORS_ORIGINS.some((o) => origin.startsWith(o.replace(/\/$/, "")))) return true;
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allow =
    origin && isAllowedOrigin(origin) ? origin : CORS_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

async function parseBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = { "Content-Type": "application/json", ...corsHeaders(origin) };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, service: "alebrije-dispersor" }));
    return;
  }

  if (url.pathname === "/api/dispersar" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const { csv } = JSON.parse(body || "{}");
      if (!csv || typeof csv !== "string") {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "Se requiere body.csv (string con contenido CSV)" }));
        return;
      }

      const result = await dispersarDesdeCsv(csv);
      res.writeHead(200, headers);
      res.end(
        JSON.stringify({
          ok: result.ok,
          batchId: result.batchId,
          commitmentHash: result.commitmentHash,
          hash: result.hash,
          txHash: result.txHash,
          txExplorerUrl: txExplorerUrl(result.txHash),
          total: result.total,
          asset: result.asset,
          count: result.count,
        })
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        msg.includes("ADMIN_SECRET_KEY") || msg.includes("PAYROLL_STORE_KEY")
          ? 503
          : 400;
      res.writeHead(code, headers);
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  const verifyMatch = url.pathname.match(/^\/api\/batch\/([^/]+)\/verify\/?$/);
  const batchMatch = url.pathname.match(/^\/api\/batch\/([^/]+)\/?$/);
  if (verifyMatch) {
    const batchId = verifyMatch[1];
    const batch = getBatch(batchId);
    if (!batch) {
      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: "Batch no encontrado" }));
      return;
    }
    const verified = verifyCommitment(
      Buffer.from(batch.commitmentHash, "hex"),
      { rows: batch.rows, batchId }
    );
    res.writeHead(200, headers);
    res.end(
      JSON.stringify({
        batchId,
        commitmentHash: batch.commitmentHash,
        txHash: batch.txHash,
        txExplorerUrl: txExplorerUrl(batch.txHash),
        verified,
      })
    );
    return;
  }
  if (batchMatch) {
    const batchId = batchMatch[1];
    const auth =
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ??
      req.headers["x-auditor-key"];
    if (!AUDITOR_TOKEN || auth !== AUDITOR_TOKEN) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "Autorización requerida (Bearer o X-Auditor-Key)" }));
      return;
    }

    const batch = getBatch(batchId);
    if (!batch) {
      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: "Batch no encontrado" }));
      return;
    }
    res.writeHead(200, headers);
    res.end(
      JSON.stringify({
        ...batch,
        txExplorerUrl: txExplorerUrl(batch.txHash),
      })
    );
    return;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`\n📡 API dispersor: http://localhost:${PORT}`);
  console.log(`   POST /api/dispersar     — dispersión LFPDP`);
  console.log(`   GET  /api/batch/:id     — datos batch (Bearer token)`);
  console.log(`   GET  /api/batch/:id/verify — verificación commitment`);
  console.log(`   GET  /health            — health check`);
  console.log(`   CORS: nomillar.vercel.app\n`);
});
