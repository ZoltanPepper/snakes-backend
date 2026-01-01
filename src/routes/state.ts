// src/routes/state.ts
import type { FastifyInstance } from "fastify";

/* -------------------- helpers -------------------- */

function nowIso() {
  return new Date().toISOString();
}

/* -------------------- db helpers -------------------- */

function getGame(db: any, gameId: string) {
  const r = db.exec(
    `SELECT id, clan_name, board_size, status, board_url, starts_at, ends_at
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
    endsAt: row[6] === null ? null : String(row[6])
  };
}

function getTileInfo(
  db: any,
  gameId: string,
  tileIndex: number,
  boardSize: number
) {
  const r = db.exec(
    "SELECT kind, title, jump_to FROM tile_tasks WHERE game_id = ? AND tile_index = ? LIMIT 1",
    [gameId, tileIndex]
  );
  const row = r?.[0]?.values?.[0];

  // Match roll/proof defaults exactly
  if (!row) {
    if (tileIndex === 0) {
      return { kind: "empty" as const, title: "Start", jumpTo: null };
    }
    if (tileIndex === boardSize) {
      return { kind: "empty" as const, title: "Finish", jumpTo: null };
    }
    return { kind: "task" as const, title: null, jumpTo: null };
  }

  return {
    kind: String(row[0]) as "empty" | "task" | "jump" | "boss",
    title: row[1] === null ? null : String(row[1]),
    jumpTo: row[2] === null ? null : Number(row[2])
  };
}

function getAllMembersByTeam(db: any, gameId: string): Record<string, string[]> {
  const r = db.exec(
    `SELECT team_id, rsn
     FROM registrations
     WHERE game_id = ?
     ORDER BY created_at ASC`,
    [gameId]
  );

  const out: Record<string, string[]> = {};
  const vals = r?.[0]?.values ?? [];

  for (const row of vals) {
    const teamId = String(row[0]);
    const rsn = String(row[1]);
    (out[teamId] ||= []).push(rsn);
  }

  return out;
}

/* -------------------- route -------------------- */

export async function stateRoute(
  app: FastifyInstance,
  opts: { db: any }
) {
  const { db } = opts;

  /**
   * Spectator + client-friendly state
   * - serverTime included for countdown sync
   * - members included per team
   * - tile defaults match roll/proof logic
   */
  app.get("/games/:id/state", async (req) => {
    const gameId = (req.params as any).id;

    const game = getGame(db, gameId);
    if (!game) {
      return {
        serverTime: nowIso(),
        game: null,
        teams: []
      };
    }

    const membersByTeam = getAllMembersByTeam(db, gameId);

    const rows = db.exec(
      `SELECT id, team_index, name, color, position, awaiting_proof, pending_tile
       FROM teams
       WHERE game_id = ?
       ORDER BY team_index ASC`,
      [gameId]
    );

    const teams =
      rows?.[0]?.values?.map((r: any[]) => {
        const id = String(r[0]);
        const index = Number(r[1]);
        const name = String(r[2]);
        const color = String(r[3]);
        const position = Number(r[4]);
        const awaitingProof = Number(r[5]) === 1;
        const pendingTile = r[6] === null ? null : Number(r[6]);

        const posTile = getTileInfo(db, gameId, position, game.boardSize);
        const activeIndex = pendingTile ?? position;
        const activeTile = getTileInfo(db, gameId, activeIndex, game.boardSize);

        return {
          id,
          index,
          name,
          color,
          position,
          awaitingProof,
          pendingTile,
          members: membersByTeam[id] ?? [],

          positionTile: {
            index: position,
            kind: posTile.kind,
            title: posTile.title,
            jumpTo: posTile.jumpTo
          },
          activeTile: {
            index: activeIndex,
            kind: activeTile.kind,
            title: activeTile.title,
            jumpTo: activeTile.jumpTo
          }
        };
      }) ?? [];

    return {
      serverTime: nowIso(),
      game: {
        id: game.id,
        clanName: game.clanName,
        boardSize: game.boardSize,
        status: game.status,
        boardUrl: game.boardUrl,
        startsAt: game.startsAt,
        endsAt: game.endsAt
      },
      teams
    };
  });
}
