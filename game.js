// ===================== GAME STATE =====================
//
// State is split into two buckets, now backed by real per-device networking
// (net.js):
//
//   sharedState  — everything that is safe to mirror to the other device.
//                  Nothing in here ever reveals a player's secret condition.
//   privateState — this device's own secret data. NEVER sent over the wire.
//
// A "pending*" field on sharedState represents "someone did something and
// we're waiting on the other player's private data to resolve it" (e.g. an
// owner must check a pending character ask against their own condition).
// Every mutation to sharedState happens inside applyEvent() (see the
// NETWORK REDUCER section below) — UI handlers call dispatch(), never
// mutate sharedState directly. dispatch() applies the event locally AND
// broadcasts it, so the device that owns an action (the guesser for their
// own moves, the condition owner for judging answers) is authoritative for
// it, and the other device only ever applies it upon arrival over the wire.

const TURN_SECONDS = 60;

let sharedState = {
  players: [],              // [{ name }]
  round: 1,
  currentPlayerIdx: 0,      // whose turn it is (the GUESSER this round)
  playerData: [],           // per-player runtime data: { yesList, noList, hintsLeft, questionsLeft, log }
  conditionsLocked: [],     // [bool, bool] — true once a player has submitted their condition (text itself is private)
  phase: 'setup',           // 'setup' | 'condition-entry' | 'playing' | 'round-over'

  // Pending cross-player facts. Only one of these is active at a time.
  pendingCharacterAsk: null,   // { character, byIdx }
  pendingYesNoQuestion: null,  // { text, byIdx }
  pendingHintRequest: null,    // { byIdx }
  pendingGuessText: null,      // { text, byIdx }

  // Wall-clock deadline (ms since epoch) rather than a tick counter, so both
  // devices' timers agree regardless of small clock drift or a missed tick.
  turnDeadline: null,
};

let privateState = {
  myIdx: 0,          // which player THIS device belongs to — set for real once Net connects (see NETWORK LOBBY)
  myCondition: '',   // this device's own secret condition text — never networked
  activeFilters: {}, // local UI-only search filters, never networked
};

let timerInterval = null; // local runtime handle, not meaningful to share

function ownerIdx() {
  // the player whose CONDITION is being guessed against = the other player in 2-player mode
  return (sharedState.currentPlayerIdx + 1) % sharedState.players.length;
}

function amGuesser() {
  return privateState.myIdx === sharedState.currentPlayerIdx;
}

function amOwner() {
  return privateState.myIdx === ownerIdx();
}

// ===================== SETUP SCREEN =====================

function beginConditionSequence() {
  sharedState.conditionsLocked = sharedState.players.map(() => false);
  sharedState.phase = 'condition-entry';
  privateState.myCondition = '';
}

function renderConditionEntryScreen() {
  const myIdx = privateState.myIdx;
  const myName = sharedState.players[myIdx].name;
  const iAmLocked = sharedState.conditionsLocked[myIdx];
  const otherIdx = (myIdx + 1) % sharedState.players.length;
  const otherLocked = sharedState.conditionsLocked[otherIdx];

  document.getElementById('condition-entry-label').textContent = `${myName}'s secret condition`;
  document.getElementById('condition-entry-form').style.display = iAmLocked ? 'none' : 'block';
  document.getElementById('condition-entry-waiting').style.display = iAmLocked ? 'block' : 'none';

  if (iAmLocked) {
    document.getElementById('condition-entry-waiting-text').textContent = otherLocked
      ? 'Both conditions are locked in — starting the game…'
      : `Your condition is locked in. Waiting on ${sharedState.players[otherIdx].name}…`;
  } else {
    document.getElementById('condition-entry-input').value = privateState.myCondition;
  }

  if (sharedState.conditionsLocked.every(Boolean)) {
    launchGame();
  }
}

document.getElementById('btn-submit-condition').addEventListener('click', () => {
  const val = document.getElementById('condition-entry-input').value.trim();
  if (!val) {
    showToast('Write a condition before continuing.');
    return;
  }
  privateState.myCondition = val;
  dispatch('CONDITION_LOCKED', { byIdx: privateState.myIdx });
});

function launchGame() {
  sharedState.playerData = sharedState.players.map(() => ({
    yesList: [],
    noList: [],
    hintsLeft: 2,
    questionsLeft: 2,
    log: [],
  }));
  sharedState.currentPlayerIdx = 0;
  sharedState.round = 1;
  sharedState.phase = 'playing';
  startRound();
  document.getElementById('screen-setup').classList.remove('active');
  document.getElementById('screen-game').classList.add('active');
}

// Used when a game ends (correct guess) to start a brand new game with fresh conditions.
function returnToConditionSetup() {
  document.getElementById('screen-game').classList.remove('active');
  document.getElementById('screen-setup').classList.add('active');
  beginConditionSequence();
  renderConditionEntryScreen();
}

// ===================== NETWORK LOBBY =====================
//
// Host/Join tabs + manual code exchange (net.js) followed by a one-field
// name exchange over the data channel. Once both names are known, this
// hands off to the exact same beginConditionSequence()/renderConditionEntryScreen()
// flow that already existed for local/dev play — the only thing the lobby
// changes is HOW privateState.myIdx and sharedState.players get set.
//
// Index assignment (host=0, join=1) is a placeholder for now; nothing
// downstream depends on host specifically being "Player 1" in a meaningful
// way, and this can change once turn-order/role negotiation is designed.

let lobbyMyName = null;
let lobbyOtherName = null;
let lobbyNamingStarted = false;

function setLobbyStatus(text) {
  document.getElementById('lobby-status').textContent = text || '';
}

document.getElementById('btn-tab-host').addEventListener('click', () => {
  document.getElementById('btn-tab-host').classList.add('active');
  document.getElementById('btn-tab-join').classList.remove('active');
  document.getElementById('lobby-panel-host').style.display = 'block';
  document.getElementById('lobby-panel-join').style.display = 'none';
});

document.getElementById('btn-tab-join').addEventListener('click', () => {
  document.getElementById('btn-tab-join').classList.add('active');
  document.getElementById('btn-tab-host').classList.remove('active');
  document.getElementById('lobby-panel-join').style.display = 'block';
  document.getElementById('lobby-panel-host').style.display = 'none';
});

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(
    () => setLobbyStatus('Copied to clipboard.'),
    () => setLobbyStatus('Could not copy automatically — select the text and copy manually.')
  );
}

document.getElementById('btn-copy-offer').addEventListener('click', () => {
  copyToClipboard(document.getElementById('offer-code').value);
});
document.getElementById('btn-copy-answer').addEventListener('click', () => {
  copyToClipboard(document.getElementById('answer-code').value);
});

document.getElementById('btn-host-create').addEventListener('click', async () => {
  setLobbyStatus('Generating game code…');
  try {
    const code = await Net.connect.host();
    document.getElementById('offer-code').value = code;
    document.getElementById('host-offer-step').style.display = 'block';
    document.getElementById('host-answer-step').style.display = 'block';
    setLobbyStatus('Send the code above to the other player, then paste their reply below.');
  } catch (err) {
    console.error(err);
    setLobbyStatus('Something went wrong generating the game code. Try again.');
  }
});

document.getElementById('btn-host-accept-answer').addEventListener('click', async () => {
  const code = document.getElementById('answer-code-input').value.trim();
  if (!code) { setLobbyStatus('Paste their code first.'); return; }
  setLobbyStatus('Connecting…');
  try {
    await Net.connect.acceptAnswer(code);
  } catch (err) {
    console.error(err);
    setLobbyStatus('That code didn\'t work — double check it and try again.');
  }
});

document.getElementById('btn-join-connect').addEventListener('click', async () => {
  const code = document.getElementById('offer-code-input').value.trim();
  if (!code) { setLobbyStatus('Paste the host\'s code first.'); return; }
  setLobbyStatus('Connecting…');
  try {
    const answer = await Net.connect.join(code);
    document.getElementById('answer-code').value = answer;
    document.getElementById('join-answer-step').style.display = 'block';
    setLobbyStatus('Send the code above back to the host to finish connecting.');
  } catch (err) {
    console.error(err);
    setLobbyStatus('That code didn\'t work — double check it and try again.');
  }
});

Net.on('connected', ({ role }) => {
  privateState.myIdx = role === 'host' ? 0 : 1;
  document.getElementById('conn-lost-banner').style.display = 'none';
  document.getElementById('lobby-connect-step').style.display = 'none';
  document.getElementById('lobby-name-step').style.display = 'block';
  setLobbyStatus('');
});

Net.on('disconnected', ({ reason }) => {
  const banner = document.getElementById('conn-lost-banner');
  banner.textContent = `Connection lost (${reason}). The other player will need to reconnect.`;
  banner.style.display = 'block';
});

Net.on('message', (msg) => {
  if (msg.type === 'hello') {
    lobbyOtherName = msg.data.name;
    tryFinishLobbyNaming();
  } else if (msg.type === 'event') {
    applyEvent(msg.data.type, msg.data.data);
  }
});

document.getElementById('btn-submit-name').addEventListener('click', () => {
  const val = document.getElementById('your-name-input').value.trim();
  if (!val) { setLobbyStatus('Enter a name first.'); return; }
  lobbyMyName = val;
  Net.send('hello', { name: val });
  document.getElementById('lobby-name-form').style.display = 'none';
  document.getElementById('lobby-name-waiting').style.display = 'block';
  document.getElementById('lobby-name-waiting-text').textContent = 'Waiting for the other player\'s name…';
  tryFinishLobbyNaming();
});

function tryFinishLobbyNaming() {
  if (lobbyNamingStarted) return;
  if (!lobbyMyName || !lobbyOtherName) return;
  lobbyNamingStarted = true;

  const otherIdx = 1 - privateState.myIdx;
  const names = [];
  names[privateState.myIdx] = { name: lobbyMyName };
  names[otherIdx] = { name: lobbyOtherName };
  sharedState.players = names;

  document.getElementById('screen-lobby').classList.remove('active');
  document.getElementById('screen-setup').classList.add('active');
  beginConditionSequence();
  renderConditionEntryScreen();
}

// ===================== NETWORK REDUCER =====================
//
// One authoritative sender per event type — no host authority model. The
// device that owns an action (the guesser for their own moves, the
// condition owner for judging answers) applies it locally AND broadcasts
// it. The other device only ever applies events that arrive over the
// network via applyEvent() — it never independently re-derives the same
// state change. That's what keeps the two devices' copies of sharedState
// from diverging or double-applying the same fact.
//
// dispatch() is the only thing UI handlers should call to change shared
// state from here on — never mutate sharedState.pending*/playerData/etc.
// directly from a button handler.

function dispatch(type, data) {
  applyEvent(type, data);           // this device is authoritative — apply now...
  Net.send('event', { type, data }); // ...and tell the other device to match.
}

function applyEvent(type, data) {
  switch (type) {
    case 'CONDITION_LOCKED':
      sharedState.conditionsLocked[data.byIdx] = true;
      renderConditionEntryScreen(); // already contains the "launch once both locked" check
      break;

    case 'ASK_CHARACTER':
      sharedState.pendingCharacterAsk = { character: data.character, byIdx: data.byIdx };
      renderAll();
      break;

    case 'CANCEL_CHARACTER_ASK':
      sharedState.pendingCharacterAsk = null;
      renderAll();
      break;

    case 'ANSWER_CHARACTER': {
      const pending = sharedState.pendingCharacterAsk;
      if (!pending) break;
      const character = pending.character;
      const guesserData = sharedState.playerData[pending.byIdx];
      if (data.fits) {
        if (guesserData.yesList.length >= 5) {
          if (amOwner()) showToast('Yes list is full (5 max) — noted, but not added to the board.');
        } else {
          guesserData.yesList.push(character);
        }
        addLog(guesserData, `Asked for <strong>${escapeHtml(character.name)}</strong> → <span class="log-yes">YES</span>`);
      } else {
        guesserData.noList.push(character);
        addLog(guesserData, `Asked for <strong>${escapeHtml(character.name)}</strong> → <span class="log-no">NO</span>`);
      }
      sharedState.pendingCharacterAsk = null;
      if (amGuesser()) showToast(`Turn used. Passing to ${sharedState.players[ownerIdx()].name}.`);
      startNewTurnLocal();
      break;
    }

    case 'REQUEST_HINT':
      sharedState.pendingHintRequest = { byIdx: data.byIdx };
      renderAll();
      break;

    case 'CANCEL_HINT':
      sharedState.pendingHintRequest = null;
      renderAll();
      break;

    case 'GIVE_HINT': {
      const pending = sharedState.pendingHintRequest;
      if (!pending) break;
      const hdata = sharedState.playerData[pending.byIdx];
      hdata.hintsLeft--;
      addLog(hdata, `<span class="badge badge-hint">Hint</span> ${escapeHtml(data.text)}`);
      sharedState.pendingHintRequest = null;
      renderAll();
      if (amGuesser()) showToast('Hint given. You can still ask a character or yes/no question this turn.');
      break;
    }

    case 'ASK_YESNO':
      sharedState.pendingYesNoQuestion = { text: data.text, byIdx: data.byIdx };
      renderAll();
      break;

    case 'ANSWER_YESNO': {
      const pending = sharedState.pendingYesNoQuestion;
      if (!pending) break;
      const ydata = sharedState.playerData[pending.byIdx];
      ydata.questionsLeft--;
      addLog(ydata, `<span class="badge badge-question">Asked</span> "${escapeHtml(pending.text)}" → ${data.answer ? '<span class="log-yes">YES</span>' : '<span class="log-no">NO</span>'}`);
      sharedState.pendingYesNoQuestion = null;
      if (amGuesser()) showToast(`Turn used. Passing to ${sharedState.players[ownerIdx()].name}.`);
      startNewTurnLocal();
      break;
    }

    case 'SUBMIT_GUESS': {
      sharedState.pendingGuessText = { text: data.text, byIdx: data.byIdx };
      const gdata = sharedState.playerData[data.byIdx];
      addLog(gdata, `<span style="color:var(--red-dark); font-weight:700;">Guessed:</span> "${escapeHtml(data.text)}"`);
      renderAll();
      break;
    }

    case 'GUESS_CORRECT': {
      const pending = sharedState.pendingGuessText;
      clearInterval(timerInterval);
      sharedState.phase = 'round-over';
      sharedState.pendingGuessText = null;
      document.getElementById('modal-reveal-guess').classList.remove('active');
      document.getElementById('round-over-title').textContent = pending ? `${sharedState.players[pending.byIdx].name} wins!` : 'Round over';
      document.getElementById('round-over-text').textContent = pending
        ? `Correct guess: "${pending.text}" — the condition was "${data.revealedCondition}". Starting a new game with fresh conditions.`
        : '';
      document.getElementById('modal-round-over').classList.add('active');
      renderAll();
      break;
    }

    case 'GUESS_INCORRECT':
      sharedState.pendingGuessText = null;
      document.getElementById('modal-reveal-guess').classList.remove('active');
      if (amGuesser()) showToast(`Wrong guess. Passing to ${sharedState.players[ownerIdx()].name}.`);
      startNewTurnLocal();
      break;

    case 'TURN_TIMEOUT':
      if (amGuesser()) showToast(`Time's up! Turn passes to ${sharedState.players[ownerIdx()].name}.`);
      startNewTurnLocal();
      break;

    default:
      console.warn(`applyEvent: unknown event type "${type}"`);
  }
}

// ===================== ROUND / TURN MANAGEMENT =====================

function startRound() {
  sharedState.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  renderAll();
  startTimer();
  showToast(`${sharedState.players[sharedState.currentPlayerIdx].name}'s turn — guessing against ${sharedState.players[ownerIdx()].name}'s condition.`);
}

function startTimer() {
  clearInterval(timerInterval);
  // Tick faster than 1s so the display stays smooth without drifting off
  // the shared deadline — the deadline itself, not this interval, is the
  // source of truth for when a turn actually expires.
  timerInterval = setInterval(() => {
    updateTimerDisplay();
    const remaining = Math.ceil((sharedState.turnDeadline - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(timerInterval);
      // Only the guesser's device is authoritative for their own timeout —
      // both devices' clocks will hit zero at roughly the same moment, so
      // without this gate both would race to advance the turn themselves.
      if (amGuesser()) {
        dispatch('TURN_TIMEOUT', {});
      }
    }
  }, 250);
}

function updateTimerDisplay() {
  const remaining = Math.max(0, Math.ceil((sharedState.turnDeadline - Date.now()) / 1000));
  const el = document.getElementById('timer-text');
  const wrap = document.getElementById('timer-display');
  const needle = document.getElementById('logpose-needle');
  el.textContent = remaining;
  const elapsed = TURN_SECONDS - remaining;
  const degrees = (elapsed / TURN_SECONDS) * 300; // needle sweeps as time runs out, like drifting off-course
  needle.style.transform = `translate(-50%, -100%) rotate(${degrees}deg)`;
  if (remaining <= 15) {
    wrap.classList.add('urgent');
  } else {
    wrap.classList.remove('urgent');
  }
}

// Deterministic reset shared by every "turn ended" event (answered, timed
// out, wrong guess). Only ever called from inside applyEvent(), after both
// devices already agree the triggering event happened — so it's safe to run
// symmetrically on both sides without any further network coordination.
function startNewTurnLocal() {
  clearInterval(timerInterval);
  sharedState.currentPlayerIdx = (sharedState.currentPlayerIdx + 1) % sharedState.players.length;
  startRound();
}

// ===================== SEARCH / FILTER =====================

// Always this device's own runtime data — NOT whoever currently has the
// turn. Your yes list, log, and hint/question counts should stay visible
// and stable on your own screen regardless of whose turn it is; only the
// ability to ACT (via amGuesser()) should change with turns.
function getMyData() {
  return sharedState.playerData[privateState.myIdx];
}

function renderFilterGrid() {
  const grid = document.getElementById('filter-grid');
  grid.innerHTML = '';
  const fields = [
    { key: 'crew', label: 'Crew' },
    { key: 'affiliation', label: 'Affiliation' },
    { key: 'arc', label: 'Debut arc' },
    { key: 'island', label: 'Debut island' },
    { key: 'hasDevilFruit', label: 'Devil fruit' },
    { key: 'race', label: 'Race' },
    { key: 'bounty', label: 'Bounty' },
  ];
  const devilFruitLabels = { true: 'Has a devil fruit', false: 'No devil fruit' };
  fields.forEach(f => {
    const wrap = document.createElement('div');
    const options = FILTER_OPTIONS[f.key].map(v => {
      const label = f.key === 'hasDevilFruit' ? devilFruitLabels[v] : v;
      return `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`;
    }).join('');
    wrap.innerHTML = `
      <label>${f.label}</label>
      <select data-filter-key="${f.key}">
        <option value="">Any</option>
        ${options}
      </select>
    `;
    grid.appendChild(wrap);
  });
  grid.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', () => {
      const key = sel.getAttribute('data-filter-key');
      if (sel.value) {
        privateState.activeFilters[key] = sel.value;
      } else {
        delete privateState.activeFilters[key];
      }
      renderResultsList();
    });
  });
}

document.getElementById('btn-toggle-filters').addEventListener('click', (e) => {
  const grid = document.getElementById('filter-grid');
  const isHidden = grid.style.display === 'none';
  grid.style.display = isHidden ? 'grid' : 'none';
  e.target.textContent = isHidden ? 'Hide filters ▾' : 'Show filters ▾';
});

document.getElementById('search-input').addEventListener('input', renderResultsList);

function getInitials(name) {
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function renderResultsList() {
  const list = document.getElementById('results-list');
  const note = document.getElementById('browse-mode-note');
  if (!amGuesser()) {
    note.textContent = `Browsing only — it's ${sharedState.players[sharedState.currentPlayerIdx].name}'s turn to ask.`;
    note.style.display = 'block';
  } else {
    note.style.display = 'none';
  }

  const query = document.getElementById('search-input').value.trim().toLowerCase();
  const data = getMyData();
  const yesListFull = data.yesList.length >= 5;

  let filtered = CHARACTERS.filter(c => {
    if (query && !c.name.toLowerCase().includes(query)) return false;
    for (const [key, val] of Object.entries(privateState.activeFilters)) {
      if (key === 'hasDevilFruit') {
        if (String(c.hasDevilFruit) !== val) return false;
      } else if (c[key] !== val) {
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-note">No characters match. Try different filters.</div>';
    return;
  }

  if (yesListFull && amGuesser()) {
    const notice = document.createElement('div');
    notice.className = 'empty-note';
    notice.textContent = 'Your yes list is full (5/5) — character asks are locked. You can still use yes/no questions.';
    list.innerHTML = '';
    list.appendChild(notice);
    return;
  }

  list.innerHTML = '';
  filtered.slice(0, 50).forEach(c => {
    const isYes = data.yesList.some(y => y.id === c.id);
    const isNo = data.noList.some(n => n.id === c.id);
    const alreadyAsked = isYes || isNo;
    const clickable = !alreadyAsked && !yesListFull && canTakeNewAsk();

    // Dim a row when it's un-clickable for a reason the guesser caused
    // themselves (already asked, or their yes list is full). The owner
    // browsing on their turn-off screen just sees a normal, read-only list.
    const row = document.createElement('div');
    row.className = 'char-row' + (alreadyAsked || (amGuesser() && !clickable) ? ' disabled' : '');
    const fruitLine = c.devilFruitName && c.devilFruitName !== '—' ? ` · ${escapeHtml(c.devilFruitName)}` : '';
    row.innerHTML = `
      <div class="char-portrait">${getInitials(c.name)}</div>
      <div class="char-row-info">
        <div class="char-row-name">${escapeHtml(c.name)}</div>
        <div class="char-row-meta">${escapeHtml(c.crew)} · ${escapeHtml(c.arc)}${fruitLine}</div>
      </div>
      ${isYes ? '<span class="char-row-status status-yes">Yes</span>' : ''}
      ${isNo ? '<span class="char-row-status status-no">No</span>' : ''}
    `;
    if (clickable) {
      row.addEventListener('click', () => askAboutCharacter(c));
    }
    list.appendChild(row);
  });
}

// ===================== CORE GAME ACTIONS =====================

function canTakeNewAsk() {
  return amGuesser() && !hasAnyPending();
}

function hasAnyPending() {
  return !!(sharedState.pendingCharacterAsk || sharedState.pendingYesNoQuestion ||
            sharedState.pendingHintRequest || sharedState.pendingGuessText);
}

function askAboutCharacter(character) {
  if (hasAnyPending() || !amGuesser()) return;
  dispatch('ASK_CHARACTER', { character, byIdx: privateState.myIdx });
}

document.getElementById('btn-char-yes').addEventListener('click', () => {
  if (!amOwner() || !sharedState.pendingCharacterAsk) return;
  dispatch('ANSWER_CHARACTER', { fits: true });
});
document.getElementById('btn-char-no').addEventListener('click', () => {
  if (!amOwner() || !sharedState.pendingCharacterAsk) return;
  dispatch('ANSWER_CHARACTER', { fits: false });
});
// A single Cancel button lives on the GUESSER's own waiting-banner (not
// inside the owner's modals — a button that only the guesser can use has
// no business living on the owner's screen). It cancels whichever of the
// two cancelable pending facts is currently active.
document.getElementById('btn-cancel-pending').addEventListener('click', () => {
  if (!amGuesser()) return;
  if (sharedState.pendingCharacterAsk) {
    dispatch('CANCEL_CHARACTER_ASK', {});
  } else if (sharedState.pendingHintRequest) {
    dispatch('CANCEL_HINT', {});
  }
});

document.getElementById('btn-use-hint').addEventListener('click', () => {
  if (!amGuesser() || hasAnyPending()) return;
  const data = getMyData();
  if (data.hintsLeft <= 0) {
    showToast('No hints left this game.');
    return;
  }
  dispatch('REQUEST_HINT', { byIdx: privateState.myIdx });
});

document.getElementById('btn-submit-hint').addEventListener('click', () => {
  const text = document.getElementById('hint-input').value.trim();
  if (!text) { showToast('Type a hint first.'); return; }
  if (!amOwner() || !sharedState.pendingHintRequest) return;
  dispatch('GIVE_HINT', { text });
});

document.getElementById('btn-ask-yesno').addEventListener('click', () => {
  if (!amGuesser() || hasAnyPending()) return;
  const data = getMyData();
  if (data.questionsLeft <= 0) {
    showToast('No yes/no questions left this game.');
    return;
  }
  document.getElementById('yesno-input').value = '';
  document.getElementById('modal-yesno').classList.add('active');
});

document.getElementById('btn-cancel-yesno').addEventListener('click', () => {
  document.getElementById('modal-yesno').classList.remove('active');
});

document.getElementById('btn-submit-yesno').addEventListener('click', () => {
  const text = document.getElementById('yesno-input').value.trim();
  if (!text) { showToast('Type a question first.'); return; }
  if (!amGuesser()) return;
  document.getElementById('modal-yesno').classList.remove('active');
  dispatch('ASK_YESNO', { text, byIdx: privateState.myIdx });
});

document.getElementById('btn-answer-yes').addEventListener('click', () => {
  if (!amOwner() || !sharedState.pendingYesNoQuestion) return;
  dispatch('ANSWER_YESNO', { answer: true });
});
document.getElementById('btn-answer-no').addEventListener('click', () => {
  if (!amOwner() || !sharedState.pendingYesNoQuestion) return;
  dispatch('ANSWER_YESNO', { answer: false });
});

// ===================== GUESS FLOW =====================

document.getElementById('btn-open-guess').addEventListener('click', () => {
  if (!amGuesser() || hasAnyPending()) return;
  document.getElementById('guess-input').value = '';
  document.getElementById('modal-guess').classList.add('active');
});

document.getElementById('btn-cancel-guess').addEventListener('click', () => {
  document.getElementById('modal-guess').classList.remove('active');
});

document.getElementById('btn-submit-guess').addEventListener('click', () => {
  const text = document.getElementById('guess-input').value.trim();
  if (!text) { showToast('Type your guess first.'); return; }
  if (!amGuesser()) return;
  document.getElementById('modal-guess').classList.remove('active');
  dispatch('SUBMIT_GUESS', { text, byIdx: privateState.myIdx });
});

document.getElementById('btn-guess-correct').addEventListener('click', () => {
  if (!amOwner() || !sharedState.pendingGuessText) return;
  dispatch('GUESS_CORRECT', { revealedCondition: privateState.myCondition });
});

document.getElementById('btn-guess-incorrect').addEventListener('click', () => {
  if (!amOwner()) return;
  dispatch('GUESS_INCORRECT', {});
});

document.getElementById('btn-next-round').addEventListener('click', () => {
  document.getElementById('modal-round-over').classList.remove('active');
  returnToConditionSetup();
});

// ===================== RENDER =====================

function addLog(data, html) {
  data.log.push(html);
}

function renderResourcePanel(elId, playerIdx) {
  const data = sharedState.playerData[playerIdx];
  const el = document.getElementById(elId);
  el.innerHTML = `
    <div class="label">${escapeHtml(sharedState.players[playerIdx].name)}</div>
    <div class="resource-row">
      <span class="rlabel">Hints</span>
      <div class="resource-pips">${pipRow(data.hintsLeft, 2)}</div>
    </div>
    <div class="resource-row">
      <span class="rlabel">Questions</span>
      <div class="resource-pips">${pipRow(data.questionsLeft, 2)}</div>
    </div>
  `;
}

function pipRow(left, total) {
  let html = '';
  for (let i = 0; i < total; i++) {
    html += `<div class="pip ${i < left ? '' : 'used'}"></div>`;
  }
  return html;
}

function renderWantedBoard() {
  const board = document.getElementById('wanted-board');
  const data = getMyData();
  board.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const c = data.yesList[i];
    if (c) {
      const poster = document.createElement('div');
      poster.className = 'wanted-poster';
      poster.innerHTML = `
        <div class="wp-header">Confirmed</div>
        <div class="wp-portrait">${getInitials(c.name)}</div>
        <div class="wp-name">${escapeHtml(c.name)}</div>
      `;
      board.appendChild(poster);
    } else {
      const slot = document.createElement('div');
      slot.className = 'wanted-slot';
      board.appendChild(slot);
    }
  }
}

function renderHistoryLog() {
  const data = getMyData();
  const el = document.getElementById('history-log');
  if (data.log.length === 0) {
    el.innerHTML = '<div class="empty-note">No asks yet this round.</div>';
    return;
  }
  el.innerHTML = data.log.map(entry => `<div class="log-entry">${entry}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}

function renderTopbar() {
  document.getElementById('current-turn-name').textContent = sharedState.players[sharedState.currentPlayerIdx].name;
  renderResourcePanel('panel-resources-left', 0);
  renderResourcePanel('panel-resources-right', 1);
  updateTimerDisplay();
}

function renderMyConditionPanel() {
  document.getElementById('my-condition-name').textContent = sharedState.players[privateState.myIdx].name;
  document.getElementById('my-condition-text').textContent = privateState.myCondition;
  document.getElementById('my-role-badge').textContent = amGuesser() ? 'You are guessing this round' : "You're being guessed against";
}

// Shows/hides the answer modals and the "waiting on the other player" banner
// based purely on privateState.myIdx and the current pending* fact — this is
// the piece that replaces the old pass-device flow, now driven by state that
// arrives over the network via applyEvent() rather than a single shared
// runtime.
function renderPendingModals() {
  const waitingBanner = document.getElementById('waiting-banner');
  const cancelBtn = document.getElementById('btn-cancel-pending');
  let waitingText = null;
  let cancelLabel = null;

  document.getElementById('modal-answer-character').classList.remove('active');
  document.getElementById('modal-hint').classList.remove('active');
  document.getElementById('modal-reveal-guess').classList.remove('active');
  document.getElementById('modal-answer-yesno').classList.remove('active');

  // Safety net: modal-yesno and modal-guess are opened manually by the
  // guesser (not driven by a pending* fact), so if this device somehow
  // isn't the guesser anymore when this runs, make sure they're not left
  // open — e.g. after a reconnect mid-turn.
  if (!amGuesser()) {
    document.getElementById('modal-yesno').classList.remove('active');
    document.getElementById('modal-guess').classList.remove('active');
  }

  if (sharedState.pendingCharacterAsk) {
    const { character } = sharedState.pendingCharacterAsk;
    if (amOwner()) {
      document.getElementById('character-ask-owner-name').textContent = sharedState.players[privateState.myIdx].name;
      document.getElementById('character-ask-owner-condition').textContent = privateState.myCondition;
      document.getElementById('character-ask-display').textContent = character.name;
      document.getElementById('modal-answer-character').classList.add('active');
    } else {
      waitingText = `Waiting for ${sharedState.players[ownerIdx()].name} to answer about ${character.name}…`;
      cancelLabel = 'Cancel this ask';
    }
  } else if (sharedState.pendingYesNoQuestion) {
    const { text } = sharedState.pendingYesNoQuestion;
    if (amOwner()) {
      document.getElementById('yesno-owner-condition').textContent = privateState.myCondition;
      document.getElementById('yesno-question-display').textContent = text;
      document.getElementById('modal-answer-yesno').classList.add('active');
    } else {
      waitingText = `Waiting for ${sharedState.players[ownerIdx()].name} to answer your question…`;
    }
  }

  if (sharedState.pendingHintRequest) {
    if (amOwner()) {
      document.getElementById('hint-owner-condition').textContent = privateState.myCondition;
      document.getElementById('hint-input').value = '';
      document.getElementById('modal-hint').classList.add('active');
    } else {
      waitingText = `Waiting for ${sharedState.players[ownerIdx()].name} to write a hint…`;
      cancelLabel = 'Cancel hint request';
    }
  }

  if (sharedState.pendingGuessText) {
    const { text } = sharedState.pendingGuessText;
    if (amOwner()) {
      document.getElementById('guess-text-display').textContent = `"${text}"`;
      document.getElementById('actual-condition-display').textContent = privateState.myCondition;
      document.getElementById('modal-reveal-guess').classList.add('active');
    } else {
      waitingText = `Waiting for ${sharedState.players[ownerIdx()].name} to judge the guess…`;
    }
  }

  if (cancelLabel) {
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.display = 'block';
  } else {
    cancelBtn.style.display = 'none';
  }

  if (waitingText) {
    waitingBanner.textContent = waitingText;
    waitingBanner.style.display = 'block';
  } else {
    waitingBanner.style.display = 'none';
  }
}

function renderTurnGatingHints() {
  const iCanAct = amGuesser() && !hasAnyPending();
  document.getElementById('btn-use-hint').disabled = !iCanAct;
  document.getElementById('btn-ask-yesno').disabled = !iCanAct;
  document.getElementById('btn-open-guess').disabled = !iCanAct;
}

function renderAll() {
  renderTopbar();
  renderMyConditionPanel();
  renderWantedBoard();
  renderHistoryLog();
  renderResultsList();
  renderPendingModals();
  renderTurnGatingHints();
  document.getElementById('hints-left').textContent = getMyData().hintsLeft;
}

// ===================== UTIL =====================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let toastTimeout;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove('show'), 2600);
}

// ===================== INIT =====================

renderFilterGrid();
document.getElementById('timer-text').textContent = TURN_SECONDS;
