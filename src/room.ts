export interface Env {
  STORY_ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  ASSETS: Fetcher;
}

type CardType = "place" | "object" | "action" | "ending";

interface Card {
  id: string;
  type: CardType;
  text: string;
}

interface Participant {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  isBot: boolean;
}

type Phase = "lobby" | "blank_card" | "shuffle" | "draw" | "story" | "voting" | "round_ended";

interface LogEntry {
  type: "blank_card_added" | "shuffle" | "draw" | "story" | "vote_result" | "skip";
  authorId?: string;
  authorName?: string;
  cardType?: CardType;
  cardText?: string;
  text?: string;
  o?: number;
  x?: number;
  scored?: boolean;
  ts: number;
}

interface RoundRecord {
  roundNumber: number;
  log: LogEntry[];
  finalScores: { name: string; score: number }[];
}

interface CurrentStory {
  authorId: string;
  authorName: string;
  text: string;
  votes: Record<string, "O" | "X">;
}

interface RoomState {
  ownerId: string | null;
  participants: Participant[];
  turnOrder: string[];
  turnIndex: number;
  phase: Phase;
  roundNumber: number;
  ownedCards: Card[];
  deck: Card[];
  drawnCard: Card | null;
  currentStory: CurrentStory | null;
  log: LogEntry[];
  roundHistory: RoundRecord[];
}

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const OWNER_GRACE_MS = 20_000;

// Placeholder card content — swap in real content whenever the design is finalized.
const PLACE_CARDS = [
  "학교 교실", "어두운 지하실", "놀이공원", "병원 응급실", "우주정거장",
  "무인도", "눈 덮인 산장", "지하철 막차", "오래된 도서관", "사막 한가운데",
  "폐허가 된 성", "바닷속 동굴", "회사 옥상", "시골 할머니 댁", "폐장 직후 놀이터",
  "비 오는 골목길", "결혼식장", "낡은 놀이터", "지하 벙커", "우범지대 뒷골목",
];
const OBJECT_CARDS = [
  "낡은 열쇠", "깨진 거울", "오래된 편지", "정체불명의 상자", "녹슨 반지",
  "손전등", "빨간 우산", "빛바랜 사진 한 장", "회중시계", "낡은 인형",
  "찢어진 지도", "장난감 총", "마법의 지팡이", "휴대폰", "밧줄",
  "이름 모를 약병", "카세트테이프", "목걸이", "가면", "낡은 일기장",
];
const ACTION_CARDS = [
  "갑자기 도망치다", "비밀을 털어놓다", "큰 소리로 웃다", "누군가를 의심하다", "거짓말을 하다",
  "손을 내밀다", "뒤를 돌아보다", "눈물을 흘리다", "문을 두드리다", "노래를 부르다",
  "전화를 걸다", "무언가를 숨기다", "소리를 지르다", "그 자리에서 기절하다", "편지를 태우다",
  "약속을 하다", "몰래 훔쳐보다", "싸움을 시작하다", "춤을 추다", "조용히 기도를 하다",
];
const ENDING_CARDS = [
  "이 모든 이야기는 사실 누군가의 꿈이었다.",
  "갑자기 모든 등장인물이 한자리에 모인다.",
  "예상치 못한 반전으로 진실이 드러난다.",
  "긴 여정 끝에 마침내 집으로 돌아온다.",
  "모든 것이 새로운 시작을 알리며 막을 내린다.",
];

function createBaseDeck(): Card[] {
  const cards: Card[] = [];
  for (const text of PLACE_CARDS) cards.push({ id: crypto.randomUUID(), type: "place", text });
  for (const text of OBJECT_CARDS) cards.push({ id: crypto.randomUUID(), type: "object", text });
  for (const text of ACTION_CARDS) cards.push({ id: crypto.randomUUID(), type: "action", text });
  for (const text of ENDING_CARDS) cards.push({ id: crypto.randomUUID(), type: "ending", text });
  return cards;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function freshState(): RoomState {
  return {
    ownerId: null,
    participants: [],
    turnOrder: [],
    turnIndex: 0,
    phase: "lobby",
    roundNumber: 0,
    ownedCards: createBaseDeck(),
    deck: [],
    drawnCard: null,
    currentStory: null,
    log: [],
    roundHistory: [],
  };
}

export class StoryRoom {
  private ctx: DurableObjectState;
  private env: Env;
  private sockets = new Map<WebSocket, string>();
  private state: RoomState = freshState();
  private ready: Promise<void>;
  private roomId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.ready = ctx.storage.get<RoomState>("state").then((stored) => {
      if (stored) this.state = stored;
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;

    const url = new URL(request.url);
    const roomMatch = url.pathname.match(/^\/api\/room\/([^/]+)\/ws$/);
    if (roomMatch) this.roomId = decodeURIComponent(roomMatch[1]);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const name = (url.searchParams.get("name") || "").trim().slice(0, 24);
    if (!name) return new Response("Missing name", { status: 400 });

    const activeInRound = this.state.phase !== "lobby" && this.state.phase !== "round_ended";
    let participant = this.state.participants.find((p) => p.name === name);

    let joinError: string | null = null;
    if (participant && participant.connected) {
      joinError = "이미 사용 중인 닉네임입니다.";
    } else if (!participant) {
      if (activeInRound) {
        joinError = "이미 게임이 진행 중인 방입니다.";
      } else if (this.state.participants.length >= MAX_PLAYERS) {
        joinError = "방 정원이 가득 찼습니다 (최대 6명).";
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (joinError) {
      server.send(JSON.stringify({ type: "join_rejected", message: joinError }));
      server.close(1008, joinError);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!participant) {
      participant = { id: crypto.randomUUID(), name, score: 0, connected: true, isBot: false };
      this.state.participants.push(participant);
      if (!this.state.ownerId) this.state.ownerId = participant.id;
    } else {
      participant.connected = true;
    }

    const participantId = participant.id;
    this.sockets.set(server, participantId);

    server.addEventListener("message", (event) => {
      void this.handleMessage(server, participantId, event);
    });
    const onClose = () => void this.handleDisconnect(participantId);
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    server.send(JSON.stringify({ type: "welcome", id: participantId }));

    await this.persist();
    this.broadcast();
    await this.notifyLobby();

    return new Response(null, { status: 101, webSocket: client });
  }

  private currentTurnId(): string | null {
    if (!this.state.turnOrder.length) return null;
    return this.state.turnOrder[this.state.turnIndex % this.state.turnOrder.length];
  }

  private nameOf(id: string): string {
    return this.state.participants.find((p) => p.id === id)?.name ?? "???";
  }

  private async handleMessage(socket: WebSocket, participantId: string, event: MessageEvent) {
    let data: any;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }

    const send = (obj: unknown) => socket.send(JSON.stringify(obj));
    const isOwner = this.state.ownerId === participantId;

    switch (data?.type) {
      case "start_round": {
        if (!isOwner) return send({ type: "error", message: "방장만 시작할 수 있습니다." });
        if (this.state.phase !== "lobby" && this.state.phase !== "round_ended") {
          return send({ type: "error", message: "이미 진행 중입니다." });
        }
        const connectedCount = this.state.participants.filter((p) => p.connected).length;
        if (connectedCount < MIN_PLAYERS || connectedCount > MAX_PLAYERS) {
          return send({ type: "error", message: `인원은 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다.` });
        }
        this.startRound();
        break;
      }
      case "submit_blank_card": {
        if (this.state.phase !== "blank_card") return send({ type: "error", message: "지금은 카드 작성 단계가 아닙니다." });
        if (this.currentTurnId() !== participantId) return send({ type: "error", message: "당신의 차례가 아닙니다." });
        const cardType = data.cardType;
        const text = String(data.text || "").trim().slice(0, 60);
        if (!["place", "object", "action"].includes(cardType) || !text) {
          return send({ type: "error", message: "유형과 내용을 입력해 주세요." });
        }
        this.doSubmitBlankCard(participantId, cardType, text);
        break;
      }
      case "shuffle": {
        if (this.state.phase !== "shuffle") return send({ type: "error", message: "지금은 셔플 단계가 아닙니다." });
        if (this.currentTurnId() !== participantId) return send({ type: "error", message: "당신의 차례가 아닙니다." });
        this.doShuffle(participantId);
        break;
      }
      case "draw": {
        if (this.state.phase !== "draw") return send({ type: "error", message: "지금은 드로우 단계가 아닙니다." });
        if (this.currentTurnId() !== participantId) return send({ type: "error", message: "당신의 차례가 아닙니다." });
        if (this.state.deck.length === 0) return send({ type: "error", message: "덱에 카드가 없습니다." });
        this.doDraw(participantId);
        break;
      }
      case "submit_story": {
        if (this.state.phase !== "story") return send({ type: "error", message: "지금은 이야기 작성 단계가 아닙니다." });
        if (this.currentTurnId() !== participantId) return send({ type: "error", message: "당신의 차례가 아닙니다." });
        const text = String(data.text || "").trim().slice(0, 300);
        if (!text) return send({ type: "error", message: "내용을 입력해 주세요." });
        if (!this.state.drawnCard) return send({ type: "error", message: "뽑힌 카드가 없습니다." });
        this.doSubmitStory(participantId, text);
        break;
      }
      case "add_bot": {
        if (!isOwner) return send({ type: "error", message: "방장만 봇을 추가할 수 있습니다." });
        if (this.state.phase !== "lobby" && this.state.phase !== "round_ended") {
          return send({ type: "error", message: "게임 진행 중에는 봇을 추가할 수 없습니다." });
        }
        if (this.state.participants.length >= MAX_PLAYERS) {
          return send({ type: "error", message: "방 정원이 가득 찼습니다 (최대 6명)." });
        }
        const botNumber = this.state.participants.filter((p) => p.isBot).length + 1;
        this.state.participants.push({
          id: crypto.randomUUID(),
          name: `봇${botNumber}`,
          score: 0,
          connected: true,
          isBot: true,
        });
        break;
      }
      case "remove_bot": {
        if (!isOwner) return send({ type: "error", message: "방장만 봇을 제거할 수 있습니다." });
        if (this.state.phase !== "lobby" && this.state.phase !== "round_ended") {
          return send({ type: "error", message: "게임 진행 중에는 봇을 제거할 수 없습니다." });
        }
        const idx = this.state.participants.findIndex((p) => p.id === data.id && p.isBot);
        if (idx === -1) return;
        this.state.participants.splice(idx, 1);
        break;
      }
      case "vote": {
        if (this.state.phase !== "voting" || !this.state.currentStory) {
          return send({ type: "error", message: "지금은 투표 단계가 아닙니다." });
        }
        if (participantId === this.state.currentStory.authorId) {
          return send({ type: "error", message: "본인 이야기에는 투표할 수 없습니다." });
        }
        const value = data.value;
        if (value !== "O" && value !== "X") return;
        const voter = this.state.participants.find((p) => p.id === participantId);
        if (!voter?.connected) return;
        this.state.currentStory.votes[participantId] = value;
        this.tryResolveVoting();
        break;
      }
      case "end_room": {
        if (!isOwner) return send({ type: "error", message: "방장만 방을 종료할 수 있습니다." });
        await this.closeRoom();
        return;
      }
      default:
        return;
    }

    this.runBotsIfNeeded();
    await this.persist();
    this.broadcast();
    await this.notifyLobby();
  }

  private doSubmitBlankCard(participantId: string, cardType: CardType, text: string) {
    const card: Card = { id: crypto.randomUUID(), type: cardType, text };
    this.state.ownedCards.push(card);
    this.state.deck.push(card);
    this.state.log.push({
      type: "blank_card_added",
      authorId: participantId,
      authorName: this.nameOf(participantId),
      ts: Date.now(),
    });
    this.state.phase = "shuffle";
  }

  private doShuffle(participantId: string) {
    this.state.deck = shuffle(this.state.deck);
    this.state.log.push({
      type: "shuffle",
      authorId: participantId,
      authorName: this.nameOf(participantId),
      ts: Date.now(),
    });
    this.state.phase = "draw";
  }

  private doDraw(participantId: string): boolean {
    if (this.state.deck.length === 0) return false;
    const idx = Math.floor(Math.random() * this.state.deck.length);
    const card = this.state.deck.splice(idx, 1)[0];
    this.state.drawnCard = card;
    this.state.log.push({
      type: "draw",
      authorId: participantId,
      authorName: this.nameOf(participantId),
      cardType: card.type,
      cardText: card.text,
      ts: Date.now(),
    });
    this.state.phase = "story";
    return true;
  }

  private doSubmitStory(participantId: string, text: string) {
    this.state.currentStory = {
      authorId: participantId,
      authorName: this.nameOf(participantId),
      text,
      votes: {},
    };
    this.state.log.push({
      type: "story",
      authorId: participantId,
      authorName: this.nameOf(participantId),
      text,
      ts: Date.now(),
    });
    this.state.phase = "voting";
  }

  private runBotsIfNeeded(depth = 0) {
    if (depth > 200) return;
    if (this.tryOneBotAction()) {
      this.runBotsIfNeeded(depth + 1);
    }
  }

  private tryOneBotAction(): boolean {
    const phase = this.state.phase;
    const midTurnPhases: Phase[] = ["blank_card", "shuffle", "draw", "story"];

    if (midTurnPhases.includes(phase)) {
      const turnId = this.currentTurnId();
      const turnP = turnId ? this.state.participants.find((p) => p.id === turnId) : undefined;
      if (!turnP?.isBot) return false;

      if (phase === "blank_card") {
        const pools: Record<"place" | "object" | "action", string[]> = {
          place: PLACE_CARDS,
          object: OBJECT_CARDS,
          action: ACTION_CARDS,
        };
        const types = Object.keys(pools) as (keyof typeof pools)[];
        const type = types[Math.floor(Math.random() * types.length)];
        const pool = pools[type];
        const text = pool[Math.floor(Math.random() * pool.length)];
        this.doSubmitBlankCard(turnP.id, type, text);
        return true;
      }
      if (phase === "shuffle") {
        this.doShuffle(turnP.id);
        return true;
      }
      if (phase === "draw") {
        return this.doDraw(turnP.id);
      }
      if (phase === "story") {
        const card = this.state.drawnCard;
        if (!card) return false;
        const text =
          card.type === "ending"
            ? "(봇) 그렇게 모든 이야기는 막을 내렸다."
            : `(봇) 그렇게 ${card.text}에 얽힌 이야기가 이어졌다.`;
        this.doSubmitStory(turnP.id, text);
        return true;
      }
    } else if (phase === "voting" && this.state.currentStory) {
      const story = this.state.currentStory;
      const pendingBot = this.state.participants.find(
        (p) => p.isBot && p.connected && p.id !== story.authorId && !story.votes[p.id]
      );
      if (pendingBot) {
        story.votes[pendingBot.id] = Math.random() < 0.75 ? "O" : "X";
        this.tryResolveVoting();
        return true;
      }
    }

    return false;
  }

  private startRound() {
    if (this.state.roundNumber > 0 && this.state.phase === "round_ended") {
      this.state.roundHistory.push({
        roundNumber: this.state.roundNumber,
        log: this.state.log,
        finalScores: this.state.participants.map((p) => ({ name: p.name, score: p.score })),
      });
    }
    this.state.participants.forEach((p) => (p.score = 0));
    this.state.turnOrder = this.state.participants.filter((p) => p.connected).map((p) => p.id);
    this.state.turnIndex = 0;
    this.state.deck = shuffle(this.state.ownedCards);
    this.state.drawnCard = null;
    this.state.currentStory = null;
    this.state.log = [];
    this.state.roundNumber += 1;
    this.state.phase = "blank_card";
  }

  private tryResolveVoting() {
    const story = this.state.currentStory;
    if (!story) return;
    const eligible = this.state.participants.filter((p) => p.connected && p.id !== story.authorId);
    const votedCount = eligible.filter((p) => story.votes[p.id]).length;
    if (votedCount < eligible.length) return;

    const o = Object.values(story.votes).filter((v) => v === "O").length;
    const x = Object.values(story.votes).filter((v) => v === "X").length;
    const scored = o >= x;
    if (scored) {
      const author = this.state.participants.find((p) => p.id === story.authorId);
      if (author) author.score += 1;
    }
    this.state.log.push({
      type: "vote_result",
      authorId: story.authorId,
      authorName: story.authorName,
      o,
      x,
      scored,
      ts: Date.now(),
    });

    const wasEnding = this.state.drawnCard?.type === "ending";
    this.state.currentStory = null;
    this.state.drawnCard = null;

    if (wasEnding) {
      this.state.phase = "round_ended";
    } else {
      this.advanceTurn();
      this.state.phase = "blank_card";
    }
  }

  private advanceTurn() {
    const n = this.state.turnOrder.length;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      this.state.turnIndex = (this.state.turnIndex + 1) % n;
      const pid = this.state.turnOrder[this.state.turnIndex];
      const p = this.state.participants.find((pp) => pp.id === pid);
      if (p?.connected) return;
      this.state.log.push({ type: "skip", authorId: pid, authorName: p?.name, ts: Date.now() });
    }
  }

  private async handleDisconnect(participantId: string) {
    for (const [sock, pid] of this.sockets) {
      if (pid === participantId) this.sockets.delete(sock);
    }
    const participant = this.state.participants.find((p) => p.id === participantId);
    if (!participant) return;

    participant.connected = false;

    const midTurnPhases: Phase[] = ["blank_card", "shuffle", "draw", "story"];
    if (midTurnPhases.includes(this.state.phase) && this.currentTurnId() === participantId) {
      this.state.log.push({ type: "skip", authorId: participantId, authorName: participant.name, ts: Date.now() });
      this.state.drawnCard = null;
      this.state.currentStory = null;
      this.advanceTurn();
      this.state.phase = "blank_card";
    } else if (this.state.phase === "voting") {
      this.tryResolveVoting();
    }

    this.runBotsIfNeeded();
    await this.persist();
    this.broadcast();
    await this.notifyLobby();

    if (participantId === this.state.ownerId) {
      // Don't destroy the room on the spot -- a dropped connection (brief network
      // hiccup, tab backgrounding, or a server redeploy) looks identical to a real
      // departure. Give the owner a grace window to reconnect with the same name
      // before actually tearing the room down.
      await this.ctx.storage.setAlarm(Date.now() + OWNER_GRACE_MS);
    }
  }

  async alarm() {
    await this.ready;
    const owner = this.state.participants.find((p) => p.id === this.state.ownerId);
    if (owner && !owner.connected) {
      await this.closeRoom();
    }
  }

  private async closeRoom() {
    const payload = JSON.stringify({ type: "room_closed" });
    for (const socket of this.sockets.keys()) {
      try {
        socket.send(payload);
        socket.close(1000, "room closed");
      } catch {
        // socket already gone
      }
    }
    this.sockets.clear();
    this.state = freshState();
    await this.ctx.storage.deleteAll();
    await this.notifyLobby();
  }

  private async persist() {
    await this.ctx.storage.put("state", this.state);
  }

  private async notifyLobby() {
    if (!this.roomId) return;
    const connectedCount = this.state.participants.filter((p) => p.connected).length;
    try {
      const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName("global"));
      await stub.fetch(`https://lobby.internal/rooms/${encodeURIComponent(this.roomId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participantCount: connectedCount, phase: this.state.phase }),
      });
    } catch {
      // best-effort; the room list is a non-critical convenience feature
    }
  }

  private publicState() {
    const story = this.state.currentStory;
    return {
      type: "state",
      ownerId: this.state.ownerId,
      phase: this.state.phase,
      roundNumber: this.state.roundNumber,
      participants: this.state.participants.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        isBot: p.isBot,
      })),
      currentTurnId: this.currentTurnId(),
      drawnCard: this.state.drawnCard,
      currentStory: story
        ? {
            authorId: story.authorId,
            authorName: story.authorName,
            text: story.text,
            votedIds: Object.keys(story.votes),
          }
        : null,
      log: this.state.log,
      roundHistory: this.state.roundHistory,
      deckSize: this.state.deck.length,
    };
  }

  private broadcast() {
    const payload = JSON.stringify(this.publicState());
    for (const socket of this.sockets.keys()) {
      try {
        socket.send(payload);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}
