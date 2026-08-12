export interface Env {
  STORY_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface Participant {
  id: string;
  name: string;
}

interface StoryEntry {
  author: string;
  text: string;
  ts: number;
}

interface RoomState {
  participants: Participant[];
  story: StoryEntry[];
  turnIndex: number;
}

export class StoryRoom {
  private ctx: DurableObjectState;
  private sockets = new Map<WebSocket, string>();
  private state: RoomState = { participants: [], story: [], turnIndex: 0 };
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
    this.ready = ctx.storage.get<RoomState>("state").then((stored) => {
      if (stored) this.state = stored;
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "익명").slice(0, 24);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const participantId = crypto.randomUUID();
    this.state.participants.push({ id: participantId, name });
    this.sockets.set(server, participantId);

    server.addEventListener("message", (event) => {
      void this.handleMessage(server, participantId, event);
    });
    const onClose = () => {
      void this.handleClose(server, participantId);
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    server.send(JSON.stringify({ type: "welcome", id: participantId }));

    await this.persist();
    this.broadcast();

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleMessage(socket: WebSocket, participantId: string, event: MessageEvent) {
    let data: { type?: string; text?: string };
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (data.type !== "submit" || typeof data.text !== "string") return;

    const turnCount = this.state.participants.length;
    if (turnCount === 0) return;
    const currentTurn = this.state.participants[this.state.turnIndex % turnCount];
    if (currentTurn.id !== participantId) {
      socket.send(JSON.stringify({ type: "error", message: "아직 당신의 차례가 아닙니다." }));
      return;
    }

    const text = data.text.trim().slice(0, 280);
    if (!text) return;

    this.state.story.push({ author: currentTurn.name, text, ts: Date.now() });
    this.state.turnIndex = (this.state.turnIndex + 1) % turnCount;

    await this.persist();
    this.broadcast();
  }

  private async handleClose(socket: WebSocket, participantId: string) {
    this.sockets.delete(socket);
    this.state.participants = this.state.participants.filter((p) => p.id !== participantId);
    this.state.turnIndex = this.state.participants.length
      ? this.state.turnIndex % this.state.participants.length
      : 0;
    await this.persist();
    this.broadcast();
  }

  private async persist() {
    await this.ctx.storage.put("state", this.state);
  }

  private broadcast() {
    const turnCount = this.state.participants.length;
    const currentTurnId = turnCount ? this.state.participants[this.state.turnIndex % turnCount].id : null;
    const payload = JSON.stringify({
      type: "state",
      participants: this.state.participants,
      story: this.state.story,
      currentTurnId,
    });
    for (const socket of this.sockets.keys()) {
      try {
        socket.send(payload);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}
