export interface Env {
  LOBBY: DurableObjectNamespace;
}

interface RoomSummary {
  roomId: string;
  participantCount: number;
  phase: string;
  updatedAt: number;
}

export class Lobby {
  private ctx: DurableObjectState;
  private rooms = new Map<string, RoomSummary>();
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
    this.ready = ctx.storage.get<Record<string, RoomSummary>>("rooms").then((stored) => {
      if (stored) this.rooms = new Map(Object.entries(stored));
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/rooms") {
      const list = [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      return Response.json(list);
    }

    if (request.method === "PUT" && url.pathname.startsWith("/rooms/")) {
      const roomId = decodeURIComponent(url.pathname.slice("/rooms/".length));
      const body = await request.json<{ participantCount: number; phase: string }>();
      if (body.participantCount <= 0) {
        this.rooms.delete(roomId);
      } else {
        this.rooms.set(roomId, {
          roomId,
          participantCount: body.participantCount,
          phase: body.phase,
          updatedAt: Date.now(),
        });
      }
      await this.persist();
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }

  private async persist() {
    await this.ctx.storage.put("rooms", Object.fromEntries(this.rooms));
  }
}
