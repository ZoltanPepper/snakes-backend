// src/types/fastify-jwt.d.ts
import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: {
      gameId: string;
      teamId: string;
      rsn: string;
      jti: string;
    };
  }
}
