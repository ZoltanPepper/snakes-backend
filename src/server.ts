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
import { boardRoutes } from "./routes/board.js";
import overlayRoute from "./routes/overlay.js";

async function main() {
  const app = Fastify({ logger: true });

  const JWT_SECRET = process.env.JWT_SECRET || "dev-change-me";
  await app.register(jwt, { secret: JWT_SECRET });

  app.decorate("authenticate", async (req: any) => {
    await req.jwtVerify();
  });

  const { db, persist } = await createDb();

  app.get("/health", async () => ({ ok: true }));

  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), "public"),
    prefix: "/",
  });

  await gamesRoutes(app, { db, persist });
  await rollRoute(app, { db, persist });
  await stateRoute(app, { db });
  await proofRoute(app, { db, persist });
  await boardRoutes(app, { db, persist });
  await overlayRoute(app, { db });

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
  console.error(err);
  process.exit(1);
});
