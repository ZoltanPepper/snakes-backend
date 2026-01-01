// src/routes/board.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function rid(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function getGame(db: any, gameId: string) {
  const r = db.exec(
    "SELECT id, host_password_hash, board_size, status FROM games WHERE id = ? LIMIT 1",
    [gameId]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;
  return {
    id: String(row[0]),
    hostPasswordHash: String(row[1]),
    boardSize: Number(row[2]),
    status: String(row[3])
  };
}

/**
 * Board contract stored in DB.
 * - indices 0..boardSize inclusive (finish == boardSize)
 * - image can be filename (served from /tiles) or full URL
 * - type: start/task/jump/finish/empty
 * - NOTE: we accept "boss" as a legacy/compat value, but treat it as a TASK.
 * - jumpTo required only for jump
 */
const BoardSchema = z.object({
  schemaVersion: z.number().int().min(1).max(10).default(1),
  id: z.string().min(1).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  boardSize: z.number().int().min(1).max(500),
  tilesBasePath: z.string().min(1).optional(),
  tiles: z.array(
    z.object({
      id: z.number().int().min(0).max(500),
      // allow "boss" for backwards compatibility, but don't treat it as special mechanics
      type: z.enum(["start", "task", "jump", "finish", "empty", "boss"]).optional().default("empty"),
      title: z.string().optional(),
      description: z.string().optional(),
      image: z.string().optional(),
      category: z.string().optional(), // boss / clue / skilling / meme / etc
      requiresProof: z.boolean().optional(),
      jumpTo: z.number().int().min(0).max(500).optional()
    })
  )
});

type TileKind = "empty" | "task" | "jump";

/**
 * Mechanics mapping:
 * - jump => jump
 * - task => task (unless requiresProof===false, then treat as empty for gating)
 * - boss (legacy tile type) => task (same as above)
 * - start/finish/empty => empty
 *
 * Category NEVER changes mechanics. "boss" is a category/tag used widely.
 */
function mapBoardTileToDbKind(t: { type?: string; requiresProof?: boolean }): TileKind {
  const type = (t.type ?? "empty").toLowerCase();

  if (type === "jump") return "jump";

  if (type === "task" || type === "boss") {
    if (t.requiresProof === false) return "empty";
    return "task";
  }

  return "empty";
}

export async function boardRoutes(
  app: FastifyInstance,
  opts: { db: any; persist: () => void }
) {
  const { db, persist } = opts;

  // Public read: plugin + spectators can fetch the board for a game
  app.get("/games/:id/board", async (req) => {
    const gameId = (req.params as any).id;

    const game = getGame(db, gameId);
    if (!game) return { board: null };

    const r = db.exec(
      "SELECT board_json, locked, updated_at FROM game_boards WHERE game_id = ? LIMIT 1",
      [gameId]
    );
    const row = r?.[0]?.values?.[0];

    if (!row) {
      // No stored board yet; return a minimal default matching the game's board_size
      return {
        board: {
          schemaVersion: 1,
          id: gameId,
          title: "Snakes & Ladders",
          description: "",
          boardSize: game.boardSize,
          tilesBasePath: "tiles",
          tiles: [
            { id: 0, type: "start", title: "Start", requiresProof: false },
            { id: game.boardSize, type: "finish", title: "Finish", requiresProof: false }
          ]
        },
        locked: false,
        updatedAt: null
      };
    }

    return {
      board: JSON.parse(String(row[0])),
      locked: Number(row[1]) === 1,
      updatedAt: String(row[2])
    };
  });

  // Admin save: requires host password (simple for local testing)
  app.put("/games/:id/board", async (req, reply) => {
    const gameId = (req.params as any).id;

    const hostPassword = String((req.headers["x-host-password"] ?? "")).trim();
    if (!hostPassword) {
      return reply.code(401).send({ error: "Missing x-host-password header" });
    }

    const game = getGame(db, gameId);
    if (!game) return reply.code(404).send({ error: "Game not found" });

    if (sha256(hostPassword) !== game.hostPasswordHash) {
      return reply.code(403).send({ error: "Invalid host password" });
    }

    // refuse edits if locked
    const lockRow = db.exec(
      "SELECT locked FROM game_boards WHERE game_id = ? LIMIT 1",
      [gameId]
    )?.[0]?.values?.[0];
    if (lockRow && Number(lockRow[0]) === 1) {
      return reply.code(409).send({ error: "Board is locked" });
    }

    const parsed = BoardSchema.parse(req.body);

    // enforce boardSize matches game.boardSize (single source of truth)
    if (parsed.boardSize !== game.boardSize) {
      return reply.code(400).send({
        error: `boardSize must match game.boardSize (${game.boardSize})`
      });
    }

    // validate tile ids range + jumpTo correctness
    for (const t of parsed.tiles) {
      if (t.id < 0 || t.id > game.boardSize) {
        return reply.code(400).send({ error: `Tile id ${t.id} out of range` });
      }
      if ((t.type ?? "empty") === "jump") {
        if (typeof t.jumpTo !== "number") {
          return reply.code(400).send({ error: `jump tile ${t.id} missing jumpTo` });
        }
        if (t.jumpTo < 0 || t.jumpTo > game.boardSize) {
          return reply.code(400).send({ error: `jumpTo ${t.jumpTo} out of range` });
        }
      }
    }

    const updatedAt = nowIso();

    // Upsert game_boards
    db.run(
      `INSERT INTO game_boards (game_id, board_json, locked, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(game_id) DO UPDATE SET board_json = excluded.board_json, updated_at = excluded.updated_at`,
      [gameId, JSON.stringify(parsed), updatedAt]
    );

    // ✅ IMPORTANT: rebuild tile_tasks from board tiles so roll/proof uses editor data
    db.run("DELETE FROM tile_tasks WHERE game_id = ?", [gameId]);

    for (const t of parsed.tiles) {
      const kind = mapBoardTileToDbKind(t);
      const jumpTo = kind === "jump" ? (typeof t.jumpTo === "number" ? t.jumpTo : null) : null;

      db.run(
        `INSERT INTO tile_tasks
         (id, game_id, tile_index, kind, title, description, jump_to)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          rid("tile"),
          gameId,
          t.id,
          kind,
          t.title ?? null,
          t.description ?? null,
          jumpTo
        ]
      );
    }

    persist();
    return { ok: true, updatedAt };
  });

  // Admin lock: prevents further edits WITHOUT nuking the existing board
  app.post("/games/:id/board/lock", async (req, reply) => {
    const gameId = (req.params as any).id;
    const hostPassword = String((req.headers["x-host-password"] ?? "")).trim();
    if (!hostPassword) return reply.code(401).send({ error: "Missing x-host-password header" });

    const game = getGame(db, gameId);
    if (!game) return reply.code(404).send({ error: "Game not found" });
    if (sha256(hostPassword) !== game.hostPasswordHash) {
      return reply.code(403).send({ error: "Invalid host password" });
    }

    const updatedAt = nowIso();

    // If a board exists, just lock it.
    const existing = db.exec(
      "SELECT board_json FROM game_boards WHERE game_id = ? LIMIT 1",
      [gameId]
    )?.[0]?.values?.[0];

    if (existing?.[0]) {
      db.run("UPDATE game_boards SET locked = 1, updated_at = ? WHERE game_id = ?", [updatedAt, gameId]);
      persist();
      return { ok: true, locked: true, updatedAt };
    }

    // Otherwise insert a minimal default and lock it.
    const minimal = {
      schemaVersion: 1,
      id: gameId,
      title: "Snakes & Ladders",
      description: "",
      boardSize: game.boardSize,
      tilesBasePath: "tiles",
      tiles: [
        { id: 0, type: "start", title: "Start", requiresProof: false },
        { id: game.boardSize, type: "finish", title: "Finish", requiresProof: false }
      ]
    };

    db.run(
      `INSERT INTO game_boards (game_id, board_json, locked, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(game_id) DO UPDATE SET locked = 1, updated_at = excluded.updated_at`,
      [gameId, JSON.stringify(minimal), updatedAt]
    );

    persist();
    return { ok: true, locked: true, updatedAt };
  });

  // Admin unlock: allows edits again (your editor has an Unlock button)
  app.post("/games/:id/board/unlock", async (req, reply) => {
    const gameId = (req.params as any).id;
    const hostPassword = String((req.headers["x-host-password"] ?? "")).trim();
    if (!hostPassword) return reply.code(401).send({ error: "Missing x-host-password header" });

    const game = getGame(db, gameId);
    if (!game) return reply.code(404).send({ error: "Game not found" });
    if (sha256(hostPassword) !== game.hostPasswordHash) {
      return reply.code(403).send({ error: "Invalid host password" });
    }

    const updatedAt = nowIso();

    const existing = db.exec(
      "SELECT board_json FROM game_boards WHERE game_id = ? LIMIT 1",
      [gameId]
    )?.[0]?.values?.[0];

    if (existing?.[0]) {
      db.run("UPDATE game_boards SET locked = 0, updated_at = ? WHERE game_id = ?", [updatedAt, gameId]);
      persist();
      return { ok: true, locked: false, updatedAt };
    }

    // If there was no board row yet, create a minimal unlocked one
    const minimal = {
      schemaVersion: 1,
      id: gameId,
      title: "Snakes & Ladders",
      description: "",
      boardSize: game.boardSize,
      tilesBasePath: "tiles",
      tiles: [
        { id: 0, type: "start", title: "Start", requiresProof: false },
        { id: game.boardSize, type: "finish", title: "Finish", requiresProof: false }
      ]
    };

    db.run(
      `INSERT INTO game_boards (game_id, board_json, locked, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(game_id) DO UPDATE SET locked = 0, updated_at = excluded.updated_at`,
      [gameId, JSON.stringify(minimal), updatedAt]
    );

    persist();
    return { ok: true, locked: false, updatedAt };
  });
}
