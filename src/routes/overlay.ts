// src/routes/overlay.ts
import type { FastifyInstance } from "fastify";

/* -------------------- helpers -------------------- */

function nowIso() {
  return new Date().toISOString();
}

function parseIso(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function phaseFrom(game: any, nowMs: number): "prestart" | "running" | "ended" {
  if (!game) return "ended";
  if (String(game.status).toLowerCase() === "finished") return "ended";

  const startMs = parseIso(game.startsAt);
  const endMs = parseIso(game.endsAt);

  if (startMs !== null && nowMs < startMs) return "prestart";
  if (endMs !== null && nowMs >= endMs) return "ended";
  return "running";
}

/* -------------------- db helpers -------------------- */

function getGame(db: any, gameId: string) {
  const r = db.exec(
    `SELECT id, clan_name, board_size, status, board_url, starts_at, ends_at, turn_team_index
     FROM games
     WHERE id = ?
     LIMIT 1`,
    [gameId]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;

  return {
    id: String(row[0]),
    clanName: String(row[1]),
    boardSize: Number(row[2]),
    status: String(row[3]),
    boardUrl: row[4] === null ? null : String(row[4]),
    startsAt: row[5] === null ? null : String(row[5]),
    endsAt: row[6] === null ? null : String(row[6]),
    turnTeamIndex: Number(row[7] ?? 0),
  };
}

function getOverlayRevision(db: any, gameId: string) {
  const ev = db.exec(`SELECT COALESCE(MAX(seq), 0) FROM events WHERE game_id = ?`, [gameId]);
  const maxSeq = Number(ev?.[0]?.values?.[0]?.[0] ?? 0);

  const br = db.exec(`SELECT updated_at FROM game_boards WHERE game_id = ? LIMIT 1`, [gameId]);
  const updatedAt = br?.[0]?.values?.[0]?.[0] ?? null;

  return { maxSeq, updatedAt: updatedAt === null ? null : String(updatedAt) };
}

function getTeamByRsn(db: any, gameId: string, rsn: string) {
  const reg = db.exec(
    `SELECT team_id
     FROM registrations
     WHERE game_id = ? AND LOWER(rsn) = LOWER(?)
     LIMIT 1`,
    [gameId, rsn]
  );
  const teamId = reg?.[0]?.values?.[0]?.[0];
  if (!teamId) return null;

  const t = db.exec(
    `SELECT id, team_index, name, color, position, awaiting_proof, pending_tile
     FROM teams
     WHERE game_id = ? AND id = ?
     LIMIT 1`,
    [gameId, String(teamId)]
  );
  const row = t?.[0]?.values?.[0];
  if (!row) return null;

  return {
    id: String(row[0]),
    index: Number(row[1]),
    name: String(row[2]),
    color: String(row[3]),
    position: Number(row[4]),
    awaitingProof: Number(row[5]) === 1,
    pendingTile: row[6] === null ? null : Number(row[6]),
  };
}

function getTileFull(db: any, gameId: string, tileIndex: number, boardSize: number) {
  const r = db.exec(
    `SELECT kind, title, description, jump_to
     FROM tile_tasks
     WHERE game_id = ? AND tile_index = ?
     LIMIT 1`,
    [gameId, tileIndex]
  );
  const row = r?.[0]?.values?.[0];

  if (!row) {
    if (tileIndex === 0) {
      return { kind: "empty" as const, title: "Start", description: null, jumpTo: null };
    }
    if (tileIndex === boardSize) {
      return { kind: "empty" as const, title: "Finish", description: null, jumpTo: null };
    }
    return { kind: "task" as const, title: null, description: null, jumpTo: null };
  }

  return {
    kind: String(row[0]) as "empty" | "task" | "jump" | "boss",
    title: row[1] === null ? null : String(row[1]),
    description: row[2] === null ? null : String(row[2]),
    jumpTo: row[3] === null ? null : Number(row[3]),
  };
}

/**
 * If you store imageUrl/imageCacheKey in your board JSON, we can read it here.
 * Expected (loose) shape:
 * { tiles: [{ tileIndex, imageUrl?, imageCacheKey? }, ...] }
 */
function getBoardTileImages(db: any, gameId: string): Map<number, { imageUrl?: string; imageCacheKey?: string }> {
  const out = new Map<number, { imageUrl?: string; imageCacheKey?: string }>();

  const r = db.exec(`SELECT board_json FROM game_boards WHERE game_id = ? LIMIT 1`, [gameId]);
  const row = r?.[0]?.values?.[0];
  const json = row?.[0];
  if (!json) return out;

  try {
    const parsed = JSON.parse(String(json));
    const tiles = Array.isArray(parsed?.tiles) ? parsed.tiles : [];
    for (const t of tiles) {
      const idx = Number(t?.tileIndex);
      if (!Number.isFinite(idx)) continue;

      const imageUrl = typeof t?.imageUrl === "string" ? t.imageUrl : undefined;
      const imageCacheKey = typeof t?.imageCacheKey === "string" ? t.imageCacheKey : undefined;

      if (imageUrl || imageCacheKey) {
        out.set(idx, { imageUrl, imageCacheKey });
      }
    }
  } catch {
    // ignore
  }

  return out;
}

/* -------------------- route -------------------- */

export default async function overlayRoute(app: FastifyInstance, opts: { db: any }) {
  const { db } = opts;

  app.get("/games/:id/overlay", async (req, reply) => {
    const gameId = (req.params as any).id as string;
    const rsn = String((req.query as any)?.rsn ?? "").trim();

    const game = getGame(db, gameId);
    if (!game) {
      reply.header("ETag", `"missing"`);
      return {
        revision: 0,
        serverTime: nowIso(),
        startTime: null,
        endTime: null,
        phase: "ended",
        team: null,
        tile: { tileIndex: 0, kind: "empty", title: "Start", description: "", imageUrl: "", imageCacheKey: "" },
        flags: { awaitingProof: false, canRoll: false },
      };
    }

    const rev = getOverlayRevision(db, gameId);
    const etag = `"${rev.maxSeq}:${rev.updatedAt ?? ""}"`;

    // 304 support
    const inm = String((req.headers as any)["if-none-match"] ?? "");
    if (inm && inm === etag) {
      reply.code(304);
      return;
    }
    reply.header("ETag", etag);

    const nowMs = Date.now();
    const phase = phaseFrom(game, nowMs);

    const images = getBoardTileImages(db, gameId);

    const team = rsn ? getTeamByRsn(db, gameId, rsn) : null;

    // If not in a team, show tile 0 info
    const activeIndex = team ? (team.pendingTile ?? team.position) : 0;
    const t = getTileFull(db, gameId, activeIndex, game.boardSize);

    const img = images.get(activeIndex) ?? {};
    const awaitingProof = team ? team.awaitingProof : false;

    const hasJwt = true; // we don't know here; plugin still enforces JWT for roll/proof calls
    const canRoll =
      !!team &&
      hasJwt &&
      !awaitingProof &&
      phase === "running" &&
      String(game.status).toLowerCase() === "active" &&
      team.index === game.turnTeamIndex;

    return {
      revision: rev.maxSeq,
      serverTime: nowIso(),
      startTime: game.startsAt,
      endTime: game.endsAt,
      phase,
      team: team
        ? { name: team.name, position: team.position }
        : null,
      tile: {
        tileIndex: activeIndex,
        kind: t.kind,
        title: t.title ?? "",
        description: t.description ?? "",
        imageUrl: img.imageUrl ?? "",
        imageCacheKey: img.imageCacheKey ?? "",
      },
      flags: {
        awaitingProof,
        canRoll,
      },
    };
  });
}
