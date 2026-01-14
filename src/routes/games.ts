// src/routes/games.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { postDiscordWebhook } from "../discord.js";

/* -------------------- helpers -------------------- */

function makeJoinCode(len = 8) {
  return crypto.randomBytes(6).toString("hex").toUpperCase().slice(0, len);
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function rid(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normName(s: string) {
  return s.trim();
}

function parseIsoOrThrow(label: string, value?: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error(`Invalid ${label} (must be ISO date string)`);
  return d.toISOString();
}

async function discordSay(msg: string) {
  const url = (process.env.DISCORD_WEBHOOK_URL ?? "").trim();
  if (!url) return;
  await postDiscordWebhook(url, { content: msg });
}

/* -------------------- schemas -------------------- */

const CreateGameBody = z.object({
  clanName: z.string().min(1),
  hostPassword: z.string().min(4),
  boardSize: z.number().int().min(10).max(500),

  displayName: z.string().min(1).max(80).optional(),

  boardUrl: z.string().url().optional(),

  startsAt: z.string().optional(),
  endsAt: z.string().optional(),

  tiles: z
    .array(
      z.object({
        tileIndex: z.number().int().min(0),
        kind: z.enum(["empty", "task", "jump", "boss"]),
        title: z.string().optional(),
        description: z.string().optional(),
        jumpTo: z.number().int().optional(),
      })
    )
    .optional(),
});

const ResolveGameBody = z.object({
  clanName: z.string().min(1),
  joinCode: z.string().min(3),
});

const CreateTeamBody = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  password: z.string().min(1),
});

const RegisterBody = z
  .object({
    rsn: z.string().min(1),
    teamId: z.string().min(1).optional(),
    teamName: z.string().min(1).optional(),
    teamPassword: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (!v.teamId && !v.teamName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either teamId or teamName.",
      });
    }
  });

/* -------------------- db helpers -------------------- */

function getGame(db: any, gameId: string) {
  const r = db.exec(
    "SELECT id, clan_name, board_size, status, created_at, starts_at, ends_at FROM games WHERE id = ? LIMIT 1",
    [gameId]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;
  return {
    id: String(row[0]),
    clanName: String(row[1]),
    boardSize: Number(row[2]),
    status: String(row[3]),
    createdAt: String(row[4]),
    startsAt: row[5] === null ? null : String(row[5]),
    endsAt: row[6] === null ? null : String(row[6]),
  };
}

function getTeamById(db: any, gameId: string, teamId: string) {
  const r = db.exec(
    "SELECT id, name, color, password_hash, team_index FROM teams WHERE game_id = ? AND id = ? LIMIT 1",
    [gameId, teamId]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;
  return {
    id: String(row[0]),
    name: String(row[1]),
    color: String(row[2]),
    passwordHash: String(row[3]),
    teamIndex: Number(row[4]),
  };
}

function getTeamByName(db: any, gameId: string, name: string) {
  const r = db.exec(
    "SELECT id, name, color, password_hash, team_index FROM teams WHERE game_id = ? AND name = ? LIMIT 1",
    [gameId, name]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;
  return {
    id: String(row[0]),
    name: String(row[1]),
    color: String(row[2]),
    passwordHash: String(row[3]),
    teamIndex: Number(row[4]),
  };
}

function nextTeamIndex(db: any, gameId: string) {
  const r = db.exec("SELECT COALESCE(MAX(team_index), -1) FROM teams WHERE game_id = ?", [gameId]);
  const row = r?.[0]?.values?.[0];
  const max = row ? Number(row[0]) : -1;
  return Number.isFinite(max) ? max + 1 : 0;
}

/* -------------------- routes -------------------- */

export async function gamesRoutes(app: FastifyInstance, opts: { db: any; persist: () => void }) {
  const { db, persist } = opts;

  /* ---------- LIST GAMES BY CLAN (Join flow) ----------
     IMPORTANT: Does NOT return gameId.
  */
  app.get("/clans/:clanName/games", async (req) => {
    const clanName = normName(String((req.params as any).clanName || ""));
    if (!clanName) return { clanName: "", games: [] };

    const rows = db.exec(
      `SELECT clan_name, display_name, board_size, status, created_at, starts_at, ends_at
       FROM games
       WHERE LOWER(clan_name) = LOWER(?)
       ORDER BY created_at DESC`,
      [clanName]
    );

    const games =
      rows?.[0]?.values?.map((r: any[]) => ({
        clanName: String(r[0]),
        displayName: r[1] === null ? "Clan Game" : String(r[1]),
        boardSize: Number(r[2]),
        status: String(r[3]),
        createdAt: String(r[4]),
        startsAt: r[5] === null ? null : String(r[5]),
        endsAt: r[6] === null ? null : String(r[6]),
      })) ?? [];

    return { clanName, games };
  });

  /* ---------- RESOLVE GAME (Join flow step 2) ----------
     clanName + joinCode => gameId
  */
  app.post("/games/resolve", async (req, reply) => {
    const body = ResolveGameBody.parse(req.body);

    const clanName = normName(body.clanName);
    const joinCode = body.joinCode.trim().toUpperCase();
    const joinHash = sha256(joinCode);

    const rows = db.exec(
      `SELECT id, clan_name, display_name, board_size, status, created_at, starts_at, ends_at
       FROM games
       WHERE LOWER(clan_name) = LOWER(?)
         AND join_code_hash = ?
       LIMIT 1`,
      [clanName, joinHash]
    );

    const row = rows?.[0]?.values?.[0];
    if (!row) {
      reply.code(404);
      return { error: "Game not found" };
    }

    return {
      gameId: String(row[0]),
      clanName: String(row[1]),
      displayName: row[2] === null ? null : String(row[2]),
      boardSize: Number(row[3]),
      status: String(row[4]),
      createdAt: String(row[5]),
      startsAt: row[6] === null ? null : String(row[6]),
      endsAt: row[7] === null ? null : String(row[7]),
    };
  });

  /* ---------- CREATE GAME ---------- */
  app.post("/games", async (req) => {
    const body = CreateGameBody.parse(req.body);
    const gameId = rid("game");

    const clanName = normName(body.clanName);
    const displayName = body.displayName ? normName(body.displayName) : `${clanName} Game`;

    const startsAtIso = parseIsoOrThrow("startsAt", body.startsAt);
    const endsAtIso = parseIsoOrThrow("endsAt", body.endsAt);

    if (startsAtIso && endsAtIso) {
      if (new Date(endsAtIso).getTime() <= new Date(startsAtIso).getTime()) {
        throw new Error("endsAt must be after startsAt");
      }
    }

    const joinCode = makeJoinCode(8);
    const joinHash = sha256(joinCode.toUpperCase());

    db.run(
      `INSERT INTO games
       (id, clan_name, host_password_hash, board_size, created_at, turn_team_index, status, discord_webhook_url, board_url, starts_at, ends_at, display_name, join_code_hash)
       VALUES (?, ?, ?, ?, ?, 0, 'active', NULL, ?, ?, ?, ?, ?)`,
      [
        gameId,
        clanName,
        sha256(body.hostPassword),
        body.boardSize,
        nowIso(),
        body.boardUrl ?? null,
        startsAtIso,
        endsAtIso,
        displayName,
        joinHash,
      ]
    );

    body.tiles?.forEach((tile) => {
      if (tile.tileIndex < 0 || tile.tileIndex > body.boardSize) return;
      db.run(
        `INSERT INTO tile_tasks
         (id, game_id, tile_index, kind, title, description, jump_to)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          rid("tile"),
          gameId,
          tile.tileIndex,
          tile.kind,
          tile.title ?? null,
          tile.description ?? null,
          tile.jumpTo ?? null,
        ]
      );
    });

    persist();

    const sched =
      startsAtIso || endsAtIso ? ` (starts ${startsAtIso ?? "now"} • ends ${endsAtIso ?? "unset"})` : "";

    await discordSay(
      `🎲 **${clanName}** Snakes & Ladders game created (**${displayName}**) (boardSize=${body.boardSize})${sched}`
    );

    return {
      gameId,
      joinCode, // only returned on create (admin path)
      clanName,
      displayName,
      startsAt: startsAtIso,
      endsAt: endsAtIso,
    };
  });

  /* ---------- LIST TEAMS ---------- */
  app.get("/games/:id/teams", async (req) => {
    const gameId = String((req.params as any).id);
    const game = getGame(db, gameId);
    if (!game) return { game: null, teams: [] };

    const rows = db.exec(
      `SELECT id, team_index, name, color
       FROM teams
       WHERE game_id = ?
       ORDER BY team_index ASC`,
      [gameId]
    );

    const teams =
      rows?.[0]?.values?.map((r: any[]) => {
        const teamId = String(r[0]);
        const countR = db.exec("SELECT COUNT(*) FROM registrations WHERE game_id = ? AND team_id = ?", [
          gameId,
          teamId,
        ]);
        const countRow = countR?.[0]?.values?.[0];
        const memberCount = countRow ? Number(countRow[0]) : 0;

        return {
          id: teamId,
          index: Number(r[1]),
          name: String(r[2]),
          color: String(r[3]),
          memberCount,
        };
      }) ?? [];

    return { game, teams };
  });

  /* ---------- CREATE TEAM ---------- */
  app.post("/games/:id/teams", async (req) => {
    const gameId = String((req.params as any).id);
    const body = CreateTeamBody.parse(req.body);

    const game = getGame(db, gameId);
    if (!game) throw new Error("Game not found");

    const name = normName(body.name);
    const color = body.color.trim();

    const exists = db.exec("SELECT id FROM teams WHERE game_id = ? AND name = ? LIMIT 1", [gameId, name]);
    if (exists?.[0]?.values?.length) throw new Error("Team name already exists");

    const teamIndex = nextTeamIndex(db, gameId);
    const teamId = rid("team");

    db.run(
      `INSERT INTO teams
       (id, game_id, team_index, name, color, password_hash, position, awaiting_proof, pending_tile)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
      [teamId, gameId, teamIndex, name, color, sha256(body.password)]
    );

    persist();

    await discordSay(`🧑‍🤝‍🧑 Team created: **${name}** (game=${gameId})`);

    return { ok: true, team: { id: teamId, index: teamIndex, name, color } };
  });

  /* ---------- REGISTER ---------- */
  app.post("/games/:id/register", async (req) => {
    const gameId = String((req.params as any).id);
    const body = RegisterBody.parse(req.body);

    const game = getGame(db, gameId);
    if (!game) throw new Error("Game not found");
    if (game.status !== "active") throw new Error("Game inactive");

    const team = body.teamId
      ? getTeamById(db, gameId, body.teamId)
      : getTeamByName(db, gameId, normName(body.teamName!));

    if (!team || team.passwordHash !== sha256(body.teamPassword)) {
      throw new Error("Invalid team credentials");
    }

    const exists = db.exec("SELECT id FROM registrations WHERE game_id = ? AND rsn = ? LIMIT 1", [
      gameId,
      body.rsn,
    ]);
    if (exists?.[0]?.values?.length) throw new Error("RSN already registered in this game");

    const jti = rid("sess");

    db.run(
      `INSERT INTO registrations
       (id, game_id, team_id, rsn, token_jti, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [rid("reg"), gameId, team.id, body.rsn, jti, nowIso()]
    );

    persist();

    const token = app.jwt.sign({ gameId, teamId: team.id, rsn: body.rsn, jti });

    await discordSay(`✅ **${team.name}** joined by **${body.rsn}**`);

    return { token, team: { id: team.id, name: team.name, color: team.color } };
  });
}
