// src/routes/proof.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { postDiscordWebhook } from "../discord.js";
import crypto from "node:crypto";

/* -------------------- helpers -------------------- */

function rid(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function headerWebhook(req: any): string | undefined {
  // Fastify lowercases header keys
  const raw = req.headers?.["x-discord-webhook-url"];
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return undefined;
  if (!/^https:\/\/(canary\.|ptb\.)?discord\.com\/api\/webhooks\/.+/i.test(s)) return undefined;
  return s;
}

async function discordSay(req: any, msg: string) {
  const override = headerWebhook(req);
  const fallback = (process.env.DISCORD_WEBHOOK_URL ?? "").trim();
  const url = override ?? fallback;
  if (!url) return;
  await postDiscordWebhook(url, { content: msg });
}

/* -------------------- schemas -------------------- */

// Support both shapes to avoid backend<->plugin mismatch
const ProofBody = z
  .object({
    url: z.string().url().optional(),
    imageUrl: z.string().url().optional()
  })
  .superRefine((val, ctx) => {
    if (!val.url && !val.imageUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either 'url' or 'imageUrl' must be provided."
      });
    }
  });

type TileKind = "empty" | "task" | "jump";

/* -------------------- db helpers -------------------- */

function getGame(db: any, gameId: string) {
  const r = db.exec(
    "SELECT id, clan_name, board_size, status FROM games WHERE id = ? LIMIT 1",
    [gameId]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;
  return {
    id: String(row[0]),
    clanName: String(row[1]),
    boardSize: Number(row[2]),
    status: String(row[3])
  };
}

function getTeamById(db: any, gameId: string, teamId: string) {
  const r = db.exec(
    "SELECT id, name, position, awaiting_proof, pending_tile FROM teams WHERE game_id = ? AND id = ? LIMIT 1",
    [gameId, teamId]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;
  return {
    id: String(row[0]),
    name: String(row[1]),
    position: Number(row[2]),
    awaitingProof: Number(row[3]) === 1,
    pendingTile: row[4] === null ? null : Number(row[4])
  };
}

function getTileRaw(db: any, gameId: string, tileIndex: number) {
  const r = db.exec(
    "SELECT kind, jump_to, title FROM tile_tasks WHERE game_id = ? AND tile_index = ? LIMIT 1",
    [gameId, tileIndex]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;
  return {
    kind: String(row[0]) as TileKind,
    jumpTo: row[1] === null ? null : Number(row[1]),
    title: row[2] === null ? null : String(row[2])
  };
}

/**
 * DEFAULT RULE:
 * - if tile not defined in tile_tasks:
 *   - tile 0 => empty (no proof)
 *   - tile boardSize => empty (no proof)
 *   - everything else => task (proof required)
 */
function getTileWithDefaults(db: any, gameId: string, tileIndex: number, boardSize: number) {
  const t = getTileRaw(db, gameId, tileIndex);
  if (t) return t;

  if (tileIndex === 0)
    return { kind: "empty" as const, jumpTo: null as number | null, title: "Start" as string | null };
  if (tileIndex === boardSize)
    return { kind: "empty" as const, jumpTo: null as number | null, title: "Finish" as string | null };

  return { kind: "task" as const, jumpTo: null as number | null, title: null as string | null };
}

/* -------------------- route -------------------- */

export async function proofRoute(
  app: FastifyInstance,
  opts: { db: any; persist: () => void }
) {
  const { db, persist } = opts;

  // Helpful for testing in a browser
  app.get("/games/:gameId/proof", async () => {
    return {
      ok: false,
      message: "Use POST /games/:gameId/proof with JSON body { url } (or { imageUrl })."
    };
  });

  app.post(
    "/games/:gameId/proof",
    { preHandler: (req) => (req as any).jwtVerify() },
    async (req) => {
      const gameId = String((req.params as any).gameId);
      const auth = (req as any).user as any;

      const parsed = ProofBody.parse(req.body);
      const proofUrl = (parsed.url ?? parsed.imageUrl)!;

      const game = getGame(db, gameId);
      if (!game) throw new Error("Game not found");
      if (game.status !== "active") throw new Error("Game inactive");

      // validate session
      const sess = db.exec(
        `SELECT id FROM registrations
         WHERE game_id = ? AND team_id = ? AND rsn = ? AND token_jti = ?
         LIMIT 1`,
        [gameId, auth.teamId, auth.rsn, auth.jti]
      );
      if (!sess?.[0]?.values?.length) throw new Error("Unauthorized");

      const team = getTeamById(db, gameId, auth.teamId);
      if (!team || !team.awaitingProof || team.pendingTile === null) {
        throw new Error("No proof expected");
      }

      const tileIndex = team.pendingTile;
      const tile = getTileWithDefaults(db, gameId, tileIndex, game.boardSize);

      // Only TASK tiles are proof-gated. "boss" is just a category on a task, not a mechanic.
      if (tile.kind !== "task") {
        throw new Error("Pending tile is not a proof tile");
      }

      db.run(
        `INSERT INTO proofs (id, game_id, team_id, tile_index, rsn, url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [rid("proof"), gameId, team.id, tileIndex, auth.rsn, proofUrl, nowIso()]
      );

      // unlock rolling
      db.run(
        "UPDATE teams SET awaiting_proof = 0, pending_tile = NULL WHERE id = ? AND game_id = ?",
        [team.id, gameId]
      );

      persist();

      await discordSay(
        req,
        `📸 Proof: **${auth.rsn}** completed tile **${tileIndex}** for **${team.name}**: ${proofUrl}`
      );

      return { ok: true };
    }
  );
}
