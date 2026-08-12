const screens = {
  join: document.getElementById("join-screen"),
  lobby: document.getElementById("lobby-screen"),
  game: document.getElementById("game-screen"),
  end: document.getElementById("end-screen"),
};

const roomInput = document.getElementById("room-input");
const nameInput = document.getElementById("name-input");
const joinButton = document.getElementById("join-button");
const joinError = document.getElementById("join-error");

const lobbyRoomLabel = document.getElementById("lobby-room-label");
const lobbyParticipantList = document.getElementById("lobby-participant-list");
const startButton = document.getElementById("start-button");
const lobbyHint = document.getElementById("lobby-hint");

const roundLabel = document.getElementById("round-label");
const turnIndicator = document.getElementById("turn-indicator");
const storyLog = document.getElementById("story-log");
const scoreboard = document.getElementById("scoreboard");
const actionPanel = document.getElementById("action-panel");

const finalScoreboard = document.getElementById("final-scoreboard");
const endStoryLog = document.getElementById("end-story-log");
const replayButton = document.getElementById("replay-button");
const endRoomButton = document.getElementById("end-room-button");
const leaveRoomButton = document.getElementById("leave-room-button");
const roundHistoryList = document.getElementById("round-history-list");
const roundHistoryDetail = document.getElementById("round-history-detail");

const CARD_TYPE_LABELS = { place: "장소", object: "물건", action: "행동", ending: "엔딩" };

let socket = null;
let myParticipantId = null;
let currentRoomId = "";

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle("hidden", key !== name);
  }
}

function connect(roomId, name) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(
    `${protocol}//${location.host}/api/room/${encodeURIComponent(roomId)}/ws?name=${encodeURIComponent(name)}`
  );
  currentRoomId = roomId;
  joinButton.disabled = true;

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "welcome") {
      myParticipantId = data.id;
    } else if (data.type === "state") {
      render(data);
    } else if (data.type === "join_rejected") {
      joinError.textContent = data.message;
      joinButton.disabled = false;
    } else if (data.type === "error") {
      alert(data.message);
    } else if (data.type === "room_closed") {
      alert("방장이 방을 나가 방이 종료되었습니다.");
      resetToJoinScreen();
    }
  });

  socket.addEventListener("close", () => {
    if (screens.join.classList.contains("hidden")) {
      // unexpected close while in-game
      resetToJoinScreen();
    }
  });
}

function resetToJoinScreen() {
  myParticipantId = null;
  socket = null;
  joinButton.disabled = false;
  showScreen("join");
}

function render(state) {
  joinError.textContent = "";

  if (state.phase === "lobby") {
    renderLobby(state);
    showScreen("lobby");
  } else if (state.phase === "round_ended") {
    renderEnd(state);
    showScreen("end");
  } else {
    renderGame(state);
    showScreen("game");
  }
}

function renderLobby(state) {
  lobbyRoomLabel.textContent = currentRoomId;
  lobbyParticipantList.replaceChildren();
  for (const p of state.participants) {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.name + (p.id === state.ownerId ? " (방장)" : "") + (!p.connected ? " - 자리비움" : "");
    li.append(nameSpan);
    lobbyParticipantList.append(li);
  }

  const connectedCount = state.participants.filter((p) => p.connected).length;
  const isOwner = state.ownerId === myParticipantId;
  const canStart = isOwner && connectedCount >= 3 && connectedCount <= 6;

  startButton.classList.toggle("hidden", !isOwner);
  startButton.disabled = !canStart;
  if (isOwner) {
    lobbyHint.textContent = canStart
      ? "게임을 시작할 수 있습니다."
      : `인원이 ${connectedCount}명입니다. 3~6명이 모여야 시작할 수 있습니다.`;
  } else {
    lobbyHint.textContent = `현재 ${connectedCount}명 참가 중. 방장이 시작하기를 기다리는 중입니다.`;
  }
}

function renderLogEntries(container, log) {
  container.replaceChildren();
  for (const entry of log) {
    const div = document.createElement("div");
    if (entry.type === "blank_card_added") {
      div.className = "log-entry system";
      div.textContent = `${entry.authorName}님이 빈 카드를 작성해 덱에 추가했습니다.`;
    } else if (entry.type === "shuffle") {
      div.className = "log-entry system";
      div.textContent = `${entry.authorName}님이 덱을 섞었습니다.`;
    } else if (entry.type === "draw") {
      const isEnding = entry.cardType === "ending";
      div.className = "log-entry card" + (isEnding ? " ending" : "");
      const prefix = document.createElement("span");
      prefix.textContent = `${entry.authorName}님이 카드를 뽑았습니다 → `;
      const cardText = document.createElement("span");
      cardText.className = "card-text";
      cardText.textContent = `[${CARD_TYPE_LABELS[entry.cardType]}] ${entry.cardText}`;
      div.append(prefix, cardText);
    } else if (entry.type === "story") {
      div.className = "log-entry";
      const author = document.createElement("span");
      author.className = "author";
      author.textContent = entry.authorName + ":";
      const text = document.createElement("span");
      text.textContent = entry.text;
      div.append(author, text);
    } else if (entry.type === "vote_result") {
      div.className = "log-entry vote-result";
      div.textContent = `투표 결과 — O:${entry.o} X:${entry.x} → ${entry.scored ? entry.authorName + "님 1점 획득" : "점수 없음"}`;
    } else if (entry.type === "skip") {
      div.className = "log-entry system";
      div.textContent = `${entry.authorName}님은 자리비움 상태라 턴을 건너뜁니다.`;
    }
    container.append(div);
  }
  container.scrollTop = container.scrollHeight;
}

function renderScoreboard(container, state) {
  container.replaceChildren();
  for (const p of state.participants) {
    const row = document.createElement("div");
    row.className =
      "score-row" +
      (p.id === state.currentTurnId ? " current-turn" : "") +
      (!p.connected ? " away" : "");
    const name = document.createElement("span");
    name.textContent = p.name + (p.id === state.ownerId ? " 👑" : "");
    const score = document.createElement("span");
    score.textContent = `${p.score}점`;
    row.append(name, score);
    container.append(row);
  }
}

function renderGame(state) {
  roundLabel.textContent = `${state.roundNumber}판`;
  const turnName = state.participants.find((p) => p.id === state.currentTurnId)?.name;
  const isMyTurn = state.currentTurnId === myParticipantId;

  renderLogEntries(storyLog, state.log);
  renderScoreboard(scoreboard, state);

  actionPanel.replaceChildren();

  if (state.phase === "blank_card") {
    turnIndicator.textContent = `현재 턴: ${turnName}`;
    if (isMyTurn) {
      actionPanel.append(buildBlankCardForm());
    } else {
      actionPanel.append(waitingText(`${turnName}님이 빈 카드를 작성 중입니다...`));
    }
  } else if (state.phase === "shuffle") {
    turnIndicator.textContent = `현재 턴: ${turnName}`;
    if (isMyTurn) {
      const btn = document.createElement("button");
      btn.textContent = "덱 섞기";
      btn.addEventListener("click", () => send({ type: "shuffle" }));
      actionPanel.append(btn);
    } else {
      actionPanel.append(waitingText(`${turnName}님이 덱을 섞을 차례입니다...`));
    }
  } else if (state.phase === "draw") {
    turnIndicator.textContent = `현재 턴: ${turnName}`;
    if (isMyTurn) {
      const btn = document.createElement("button");
      btn.textContent = `카드 뽑기 (덱 ${state.deckSize}장)`;
      btn.addEventListener("click", () => send({ type: "draw" }));
      actionPanel.append(btn);
    } else {
      actionPanel.append(waitingText(`${turnName}님이 카드를 뽑을 차례입니다...`));
    }
  } else if (state.phase === "story") {
    turnIndicator.textContent = `현재 턴: ${turnName}`;
    actionPanel.append(buildCardReveal(state.drawnCard));
    if (isMyTurn) {
      actionPanel.append(buildStoryForm(state.drawnCard));
    } else {
      actionPanel.append(waitingText(`${turnName}님이 이야기를 작성 중입니다...`));
    }
  } else if (state.phase === "voting") {
    turnIndicator.textContent = "투표 진행 중";
    if (state.drawnCard) actionPanel.append(buildCardReveal(state.drawnCard));
    actionPanel.append(buildVotingPanel(state));
  }
}

function waitingText(text) {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = text;
  return p;
}

function buildCardReveal(card) {
  const div = document.createElement("div");
  div.className = "card-reveal" + (card.type === "ending" ? " ending" : "");
  div.textContent = card.type === "ending" ? `엔딩 카드! ${card.text}` : `[${CARD_TYPE_LABELS[card.type]}] ${card.text}`;
  return div;
}

function buildBlankCardForm() {
  const form = document.createElement("form");
  const row = document.createElement("div");
  row.className = "form-row";

  const select = document.createElement("select");
  for (const [value, label] of Object.entries({ place: "장소", object: "물건", action: "행동" })) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.append(opt);
  }

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.placeholder = "카드 내용을 입력하세요";
  textInput.maxLength = 60;
  textInput.required = true;

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.textContent = "덱에 추가";

  row.append(select, textInput, submitBtn);
  form.append(row);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    if (!text) return;
    send({ type: "submit_blank_card", cardType: select.value, text });
  });

  return form;
}

function buildStoryForm(drawnCard) {
  const form = document.createElement("form");
  const textarea = document.createElement("textarea");
  textarea.maxLength = 300;
  textarea.placeholder =
    drawnCard.type === "ending"
      ? "이야기를 마무리하는 엔딩을 작성해 주세요..."
      : `"${drawnCard.text}"를 반드시 포함해 이야기를 이어써 주세요...`;

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.textContent = "제출";

  form.append(textarea, submitBtn);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    send({ type: "submit_story", text });
  });
  return form;
}

function buildVotingPanel(state) {
  const wrapper = document.createElement("div");
  const story = state.currentStory;
  if (!story) return wrapper;

  const storyDiv = document.createElement("div");
  storyDiv.className = "log-entry";
  const author = document.createElement("span");
  author.className = "author";
  author.textContent = story.authorName + ":";
  const text = document.createElement("span");
  text.textContent = story.text;
  storyDiv.append(author, text);
  wrapper.append(storyDiv);

  const eligibleCount = state.participants.filter((p) => p.connected && p.id !== story.authorId).length;
  const votedCount = story.votedIds.length;

  if (myParticipantId === story.authorId) {
    wrapper.append(waitingText(`다른 플레이어들의 투표를 기다리는 중 (${votedCount}/${eligibleCount})`));
  } else if (story.votedIds.includes(myParticipantId)) {
    wrapper.append(waitingText(`투표 완료. 결과를 기다리는 중 (${votedCount}/${eligibleCount})`));
  } else {
    const btnRow = document.createElement("div");
    btnRow.className = "vote-buttons";
    const oBtn = document.createElement("button");
    oBtn.textContent = "O";
    oBtn.addEventListener("click", () => send({ type: "vote", value: "O" }));
    const xBtn = document.createElement("button");
    xBtn.className = "vote-x";
    xBtn.textContent = "X";
    xBtn.addEventListener("click", () => send({ type: "vote", value: "X" }));
    btnRow.append(oBtn, xBtn);
    wrapper.append(btnRow);
  }

  return wrapper;
}

function renderEnd(state) {
  const isOwner = state.ownerId === myParticipantId;

  finalScoreboard.replaceChildren();
  const sorted = [...state.participants].sort((a, b) => b.score - a.score);
  for (const p of sorted) {
    const li = document.createElement("li");
    li.textContent = `${p.name} — ${p.score}점`;
    finalScoreboard.append(li);
  }

  renderLogEntries(endStoryLog, state.log);

  replayButton.classList.toggle("hidden", !isOwner);
  endRoomButton.classList.toggle("hidden", !isOwner);

  roundHistoryList.replaceChildren();
  for (const round of state.roundHistory) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = `${round.roundNumber}판`;
    btn.addEventListener("click", () => {
      roundHistoryDetail.replaceChildren();
      const title = document.createElement("h4");
      title.textContent = `${round.roundNumber}판 결과: ` + round.finalScores.map((s) => `${s.name} ${s.score}점`).join(", ");
      const logContainer = document.createElement("div");
      logContainer.className = "log-box";
      renderLogEntries(logContainer, round.log);
      roundHistoryDetail.append(title, logContainer);
    });
    li.append(btn);
    roundHistoryList.append(li);
  }
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

joinButton.addEventListener("click", () => {
  const roomId = roomInput.value.trim();
  const name = nameInput.value.trim();
  if (!roomId || !name) {
    joinError.textContent = "방 코드와 닉네임을 모두 입력해 주세요.";
    return;
  }
  joinError.textContent = "";
  connect(roomId, name);
});

startButton.addEventListener("click", () => send({ type: "start_round" }));
replayButton.addEventListener("click", () => send({ type: "start_round" }));
endRoomButton.addEventListener("click", () => {
  if (confirm("방을 종료하면 모든 기록이 사라집니다. 계속할까요?")) {
    send({ type: "end_room" });
  }
});
leaveRoomButton.addEventListener("click", () => {
  if (socket) socket.close();
  resetToJoinScreen();
});
