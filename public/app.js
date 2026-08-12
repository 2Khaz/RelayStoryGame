const joinScreen = document.getElementById("join-screen");
const gameScreen = document.getElementById("game-screen");
const roomInput = document.getElementById("room-input");
const nameInput = document.getElementById("name-input");
const joinButton = document.getElementById("join-button");
const roomLabel = document.getElementById("room-label");
const turnIndicator = document.getElementById("turn-indicator");
const storyList = document.getElementById("story-list");
const submitForm = document.getElementById("submit-form");
const textInput = document.getElementById("text-input");
const participantList = document.getElementById("participant-list");

let socket = null;
let myParticipantId = null;

function connect(roomId, name) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/api/room/${encodeURIComponent(roomId)}/ws?name=${encodeURIComponent(name)}`);

  socket.addEventListener("open", () => {
    joinScreen.classList.add("hidden");
    gameScreen.classList.remove("hidden");
    roomLabel.textContent = `방: ${roomId}`;
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "welcome") {
      myParticipantId = data.id;
    } else if (data.type === "state") {
      renderState(data);
    } else if (data.type === "error") {
      alert(data.message);
    }
  });

  socket.addEventListener("close", () => {
    turnIndicator.textContent = "연결이 끊겼습니다. 새로고침해 주세요.";
  });
}

function renderState(data) {
  storyList.replaceChildren();
  for (const entry of data.story) {
    const div = document.createElement("div");
    div.className = "story-entry";
    const author = document.createElement("span");
    author.className = "author";
    author.textContent = entry.author + ":";
    const text = document.createElement("span");
    text.textContent = entry.text;
    div.append(author, text);
    storyList.append(div);
  }
  storyList.scrollTop = storyList.scrollHeight;

  participantList.replaceChildren();
  for (const p of data.participants) {
    const chip = document.createElement("span");
    chip.className = "participant-chip" + (p.id === data.currentTurnId ? " active" : "");
    chip.textContent = p.name;
    participantList.append(chip);
  }

  const isMyTurn = myParticipantId !== null && myParticipantId === data.currentTurnId;
  const currentName = data.participants.find((p) => p.id === data.currentTurnId)?.name;
  turnIndicator.textContent = currentName ? `현재 차례: ${currentName}` : "참가자를 기다리는 중...";
  textInput.disabled = !isMyTurn;
  submitForm.querySelector("button").disabled = !isMyTurn;
}

joinButton.addEventListener("click", () => {
  const roomId = roomInput.value.trim();
  const name = nameInput.value.trim() || "익명";
  if (!roomId) {
    alert("방 코드를 입력해 주세요.");
    return;
  }
  connect(roomId, name);
});

submitForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "submit", text }));
  textInput.value = "";
});
