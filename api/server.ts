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

const PORT = parseInt(process.env.API_PORT ?? "3001", 10);
const CORS_ORIGINS = [
  "https://nomillar.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allow = origin && CORS_ORIGINS.some((o) => origin.startsWith(o.replace(/\/$/, "")))
    ? origin
    : CORS_ORIGINS[0];
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

const handler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  const origin = req.headers.origin;
  const headers = { "Content-Type": "application/json", ...corsHeaders(origin) };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // Soporte para rutas de Vercel y locales
  const urlPath = req.url ? req.url.split("?")[0] : "/";

  if (urlPath === "/health" || urlPath === "/api/health") {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, service: "alebrije-dispersor" }));
    return;
  }

  if (urlPath === "/api/dispersar" && req.method === "POST") {
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
          ok: true,
          hash: result.hash,
          total: result.total,
          asset: result.asset,
          recipient: result.recipient,
          count: result.count,
        })
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes("ADMIN_SECRET_KEY") ? 503 : 400;
      res.writeHead(code, headers);
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "Not found" }));
};

export default handler;

// Ejecutar servidor si se llama directamente (p. ej. en local con `npm run backend`)
if (require.main === module || process.env.NODE_ENV !== "production") {
  const isVercelEnvironment = process.env.VERCEL === "1";
  
  if (!isVercelEnvironment) {
    const server = createServer(handler);
    server.listen(PORT, () => {
      console.log(`\n📡 API dispersor: http://localhost:${PORT}`);
      console.log(`   POST /api/dispersar  — dispersión desde CSV`);
      console.log(`   GET  /health         — health check`);
      console.log(`   CORS: nomillar.vercel.app\n`);
    });
  }
}
