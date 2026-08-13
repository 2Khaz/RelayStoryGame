export { StoryRoom } from "./room";
export { Lobby } from "./lobby";

export interface Env {
  STORY_ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const roomMatch = url.pathname.match(/^\/api\/room\/([a-zA-Z0-9_-]{1,32})\/ws$/);
    if (roomMatch) {
      const id = env.STORY_ROOM.idFromName(roomMatch[1]);
      const stub = env.STORY_ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/api/rooms") {
      const stub = env.LOBBY.get(env.LOBBY.idFromName("global"));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
