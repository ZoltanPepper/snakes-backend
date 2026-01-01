// src/server.ts
import Fastify from "fastify";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import jwt from "@fastify/jwt";

import { createDb } from "./db.js";
import { gamesRoutes } from "./routes/games.js";
import { rollRoute } from "./routes/roll.js";
import { stateRoute } from "./routes/state.js";
import { proofRoute } from "./routes/proof.js";
import { boardRoutes } from "./routes/board.js"; // ✅ keep .js for ESM consistency
import overlayRoute from "./routes/overlay.js"; // ✅ NEW

async function main() {
  const app = Fastify({ logger: true });

  // JWT
  const JWT_SECRET = process.env.JWT_SECRET || "dev-change-me";
  await app.register(jwt, { secret: JWT_SECRET });

  // Optional: a reusable auth preHandler if you ever want it
  app.decorate("authenticate", async (req: any) => {
    await req.jwtVerify();
  });

  // DB
  const { db, persist } = await createDb();

  // Basic health check (useful for confirming server is up)
  app.get("/health", async () => ({ ok: true }));

  // Serve local editor + tiles from /public
  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), "public"),
    prefix: "/" // editor.html, /tiles/*, etc
  });

  // Routes
  await gamesRoutes(app, { db, persist });
  await rollRoute(app, { db, persist });
  await stateRoute(app, { db });
  await proofRoute(app, { db, persist });
  await boardRoutes(app, { db, persist });
  await overlayRoute(app, { db }); // ✅ NEW

  // Print all registered routes once everything is loaded.
  // This is the fastest way to prove whether POST /games/:gameId/proof exists.
  app.ready((err) => {
    if (err) {
      app.log.error(err);
      return;
    }
    app.log.info("\n" + app.printRoutes());
  });

  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";

  await app.listen({ port, host });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
