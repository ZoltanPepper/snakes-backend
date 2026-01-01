// src/routes/roll.ts
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { postDiscordWebhook } from "../discord.js";

/* -------------------- helpers -------------------- */

function headerWebhook(req: any): string | undefined {
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

function msUntil(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return t - Date.now();
}

type TileKind = "empty" | "task" | "jump" | "boss";

/* -------------------- db helpers -------------------- */

function getGame(db: any, gameId: string) {
  const r = db.exec(
    "SELECT id, clan_name, board_size, status, starts_at, ends_at FROM games WHERE id = ? LIMIT 1",
    [gameId]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;
  return {
    id: String(row[0]),
    clanName: String(row[1]),
    boardSize: Number(row[2]),
    status: String(row[3]),
    startsAt: row[4] === null ? null : String(row[4]),
    endsAt: row[5] === null ? null : String(row[5])
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

function getTileWithDefaults(db: any, gameId: string, tileIndex: number, boardSize: number) {
  const t = getTileRaw(db, gameId, tileIndex);
  if (t) return t;

  if (tileIndex === 0)
    return { kind: "empty" as const, jumpTo: null as number | null, title: "Start" as string | null };
  if (tileIndex === boardSize)
    return { kind: "empty" as const, jumpTo: null as number | null, title: "Finish" as string | null };

  // default to task (proof required)
  return { kind: "task" as const, jumpTo: null as number | null, title: null as string | null };
}

/* -------------------- route -------------------- */

export async function rollRoute(app: FastifyInstance, opts: { db: any; persist: () => void }) {
  const { db, persist } = opts;

  // Helpful for testing in a browser
  app.get("/games/:gameId/roll", async () => {
    return { ok: false, message: "Use POST /games/:gameId/roll (requires Authorization bearer JWT)." };
  });

  app.post(
    "/games/:gameId/roll",
    { preHandler: (req) => (req as any).jwtVerify() },
    async (req) => {
      const gameId = String((req.params as any).gameId);
      const auth = (req as any).user as any;

      const game = getGame(db, gameId);
      if (!game) {
        return { ok: false, rollAllowed: false, reason: "not_found", message: "Game not found" };
      }
      if (game.status !== "active") {
        return { ok: false, rollAllowed: false, reason: "inactive", message: "Game inactive", status: game.status };
      }

      // validate session
      const sess = db.exec(
        `SELECT id FROM registrations
         WHERE game_id = ? AND team_id = ? AND rsn = ? AND token_jti = ?
         LIMIT 1`,
        [gameId, auth.teamId, auth.rsn, auth.jti]
      );
      if (!sess?.[0]?.values?.length) {
        return { ok: false, rollAllowed: false, reason: "unauthorized", message: "Unauthorized" };
      }

      const team = getTeamById(db, gameId, auth.teamId);
      if (!team) {
        return { ok: false, rollAllowed: false, reason: "team_missing", message: "Team not found" };
      }

      // ✅ Hard gate: cannot roll while awaiting proof
      if (team.awaitingProof) {
        return {
          ok: true,
          rollAllowed: false,
          reason: "awaiting_proof",
          awaitingProof: true,
          pendingTile: team.pendingTile,
          team: { id: team.id, name: team.name, position: team.position },
          message: "Awaiting proof for the current tile."
        };
      }

      // ✅ Time gating (Option A)
      const serverTime = new Date().toISOString();

      if (game.startsAt) {
        const untilStart = msUntil(game.startsAt);
        if (untilStart !== null && untilStart > 0) {
          return {
            ok: true,
            rollAllowed: false,
            reason: "not_started",
            awaitingProof: false,
            team: { id: team.id, name: team.name, position: team.position },
            message: "Game has not started yet.",
            serverTime,
            startsAt: game.startsAt,
            endsAt: game.endsAt,
            msUntilStart: untilStart
          };
        }
      }

      if (game.endsAt) {
        const untilEnd = msUntil(game.endsAt);
        if (untilEnd !== null && untilEnd <= 0) {
          // NOTE: we do NOT automatically flip status here (avoids accidental expiry spam).
          return {
            ok: true,
            rollAllowed: false,
            reason: "ended",
            awaitingProof: false,
            team: { id: team.id, name: team.name, position: team.position },
            message: "Game has ended.",
            serverTime,
            startsAt: game.startsAt,
            endsAt: game.endsAt,
            msUntilEnd: untilEnd
          };
        }
      }

      // ----- roll -----
      const roll = crypto.randomInt(1, 7);
      const from = team.position;

      // clamp movement to finish tile (boardSize inclusive)
      let to = Math.min(game.boardSize, from + roll);

      // landing tile may be jump
      const landing = getTileWithDefaults(db, gameId, to, game.boardSize);
      let jump: null | { from: number; to: number } = null;

      if (landing.kind === "jump" && typeof landing.jumpTo === "number") {
        const jumpTo = Math.min(game.boardSize, Math.max(0, landing.jumpTo));
        jump = { from: to, to: jumpTo };
        to = jumpTo;
      }

      // proof gate based on FINAL destination
      const dest = getTileWithDefaults(db, gameId, to, game.boardSize);
      const needsProof = dest.kind === "task" || dest.kind === "boss";

      db.run(
        "UPDATE teams SET position = ?, awaiting_proof = ?, pending_tile = ? WHERE id = ? AND game_id = ?",
        [to, needsProof ? 1 : 0, needsProof ? to : null, team.id, gameId]
      );
      persist();

      await discordSay(req, `🎲 **${team.name}** rolled **${roll}** → ${from} → ${to}`);
      if (jump) await discordSay(req, `🪜🐍 **${team.name}** jump triggered: ${jump.from} → ${jump.to}`);
      if (needsProof) await discordSay(req, `🧩 **${team.name}** tile **${to}** requires proof`);

      return {
        ok: true,
        rollAllowed: true,
        reason: "rolled",
        roll,
        from,
        to,
        jump,
        awaitingProof: needsProof,
        serverTime,
        startsAt: game.startsAt,
        endsAt: game.endsAt
      };
    }
  );
}
