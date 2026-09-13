/* ============================================================
   200LVL FOOTBALL LEAGUE — app logic
   League data lives in Firebase Firestore (one shared document),
   so everyone who opens the site sees the same live table,
   fixtures, cards and finances — not a per-browser copy.
   ============================================================ */

const ADMIN_SESSION_KEY = "lvl200_admin_session";
const FIRESTORE_COLLECTION = "league";
const FIRESTORE_DOC = "state";

const POSITIONS = {
  GK: { label: "Goalkeeper", max: 1 },
  DEF: { label: "Defender", max: 3 },
  MID: { label: "Midfielder", max: 3 },
  FWD: { label: "Forward", max: 3 },
};

const TEAM_COUNT = 8;
const SQUAD_MAX = 10;
const REG_FEE = 3000;
const YELLOW_FEE = 500;
const RED_FEE = 1000;

/* ---------------------- default state ---------------------- */

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultTeamNames() {
  return [
    "Thunder FC", "Ironclad United", "Falcon Rovers", "Crimson Wolves",
    "Blue Panthers", "Golden Eagles", "Storm City", "Black Rhinos",
  ];
}

function createDefaultState() {
  return {
    leagueName: "200LVL Football League",
    account: { bankName: "", accountName: "", accountNumber: "" },
    potw: { name: "", team: "", note: "", week: "" },
    adminPassword: "admin123",
    teams: defaultTeamNames().map((name) => ({ id: uid("team"), name, players: [] })),
    fixtures: [],
    fixturesGenerated: false,
    cards: [],
    expenses: [],
    removedPlayers: [],
  };
}

let state = createDefaultState();
let cloudReady = false;

function isAdmin() {
  return sessionStorage.getItem(ADMIN_SESSION_KEY) === "true";
}

/* ---------------------- cloud sync (Firestore) ---------------------- */

function leagueDocRef() {
  return db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);
}

function setSyncStatus(text, isError = false) {
  const badge = document.getElementById("syncStatus");
  if (!badge) return;
  badge.textContent = text;
  badge.classList.toggle("sync-error", isError);
}

function initCloudSync() {
  setSyncStatus("Connecting…");
  const docRef = leagueDocRef();

  docRef
    .get()
    .then((snap) => {
      if (!snap.exists) {
        // First time this league has ever loaded — seed the cloud with the defaults.
        return docRef.set(state);
      }
    })
    .catch((err) => console.error("Initial Firestore read failed:", err));

  docRef.onSnapshot(
    (snap) => {
      if (snap.exists) {
        const data = snap.data();
        if (!data.removedPlayers) data.removedPlayers = [];
        state = data;
        cloudReady = true;
        setSyncStatus("Live");
        renderAll();
      }
    },
    (err) => {
      console.error("Firestore sync error:", err);
      setSyncStatus("Offline — check connection", true);
    }
  );
}

function save() {
  setSyncStatus("Saving…");
  leagueDocRef()
    .set(state)
    .then(() => setSyncStatus("Live"))
    .catch((err) => {
      console.error("Firestore save failed:", err);
      setSyncStatus("Couldn't save — check connection", true);
    });
}

/* ---------------------- helpers ---------------------- */

function findTeam(teamId) {
  return state.teams.find((t) => t.id === teamId);
}

function findPlayer(playerId) {
  for (const team of state.teams) {
    const p = team.players.find((pl) => pl.id === playerId);
    if (p) return { player: p, team };
  }
  return null;
}

function money(n) {
  return "₦" + Number(n || 0).toLocaleString("en-NG");
}

function positionCounts(team) {
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  team.players.forEach((p) => counts[p.position]++);
  return counts;
}

function eligibleTeamsForPosition(position) {
  return state.teams.filter((t) => {
    if (t.players.length >= SQUAD_MAX) return false;
    const counts = positionCounts(t);
    const cap = POSITIONS[position].max;
    if (cap !== null && counts[position] >= cap) return false;
    return true;
  });
}

/* ---------------------- registration ---------------------- */

function registerPlayer(name, position) {
  name = name.trim();
  if (!name) return { success: false, message: "Enter the player's name." };
  if (!POSITIONS[position]) return { success: false, message: "Choose a valid position." };

  const eligible = eligibleTeamsForPosition(position);
  if (eligible.length === 0) {
    return {
      success: false,
      message: `No team has a free ${POSITIONS[position].label.toLowerCase()} slot right now (max ${
        POSITIONS[position].max ?? "—"
      } per team, ${SQUAD_MAX} players per squad). Try another position or wait for a slot to open.`,
    };
  }

  const team = eligible[Math.floor(Math.random() * eligible.length)];
  const player = {
    id: uid("player"),
    name,
    position,
    paid: true,
    joined: new Date().toISOString(),
  };
  team.players.push(player);
  save();
  return { success: true, team, player };
}

/* ---------------------- manual team/player editing (admin) ---------------------- */

function movePlayer(playerId, targetTeamId, force = false) {
  const found = findPlayer(playerId);
  if (!found) return { success: false, message: "Player not found." };
  const targetTeam = findTeam(targetTeamId);
  if (!targetTeam) return { success: false, message: "Team not found." };
  if (found.team.id === targetTeamId) return { success: false, message: "Player is already on that team." };

  if (!force) {
    if (targetTeam.players.length >= SQUAD_MAX) {
      return { success: false, message: `${targetTeam.name} already has ${SQUAD_MAX} players.`, needsForce: true };
    }
    const counts = positionCounts(targetTeam);
    const cap = POSITIONS[found.player.position].max;
    if (cap !== null && counts[found.player.position] >= cap) {
      return {
        success: false,
        message: `${targetTeam.name} already has the max ${POSITIONS[found.player.position].label.toLowerCase()}s (${cap}).`,
        needsForce: true,
      };
    }
  }

  found.team.players = found.team.players.filter((p) => p.id !== playerId);
  targetTeam.players.push(found.player);
  save();
  return { success: true };
}

function updatePlayer(playerId, { name, position }, force = false) {
  const found = findPlayer(playerId);
  if (!found) return { success: false, message: "Player not found." };

  if (position && position !== found.player.position && !force) {
    const counts = positionCounts(found.team);
    const cap = POSITIONS[position].max;
    if (cap !== null && counts[position] >= cap) {
      return {
        success: false,
        message: `${found.team.name} already has the max ${POSITIONS[position].label.toLowerCase()}s (${cap}).`,
        needsForce: true,
      };
    }
  }

  if (name && name.trim()) found.player.name = name.trim();
  if (position) found.player.position = position;
  save();
  return { success: true };
}

function removePlayer(playerId, reason = "") {
  const found = findPlayer(playerId);
  if (!found) return { success: false, message: "Player not found." };

  const playerCards = state.cards.filter((c) => c.playerId === playerId);
  const paidFines = playerCards.filter((c) => c.paid).reduce((s, c) => s + c.fee, 0);
  const unpaidFines = playerCards.filter((c) => !c.paid).reduce((s, c) => s + c.fee, 0);

  state.removedPlayers.push({
    id: uid("removed"),
    playerId,
    name: found.player.name,
    team: found.team.name,
    position: found.player.position,
    cardsCount: playerCards.length,
    paidFines,
    unpaidFines,
    reason: reason.trim(),
    date: new Date().toISOString(),
  });

  found.team.players = found.team.players.filter((p) => p.id !== playerId);
  save();
  return { success: true };
}

function addPlayerToTeam(teamId, name, position, force = false) {
  name = (name || "").trim();
  if (!name) return { success: false, message: "Enter the player's name." };
  if (!POSITIONS[position]) return { success: false, message: "Choose a valid position." };
  const team = findTeam(teamId);
  if (!team) return { success: false, message: "Team not found." };

  if (!force) {
    if (team.players.length >= SQUAD_MAX) {
      return { success: false, message: `${team.name} already has ${SQUAD_MAX} players.`, needsForce: true };
    }
    const counts = positionCounts(team);
    const cap = POSITIONS[position].max;
    if (cap !== null && counts[position] >= cap) {
      return {
        success: false,
        message: `${team.name} already has the max ${POSITIONS[position].label.toLowerCase()}s (${cap}).`,
        needsForce: true,
      };
    }
  }

  const player = { id: uid("player"), name, position, paid: true, joined: new Date().toISOString() };
  team.players.push(player);
  save();
  return { success: true, player };
}

function renameTeam(teamId, newName) {
  const team = findTeam(teamId);
  if (!team || !newName.trim()) return { success: false };
  team.name = newName.trim();
  save();
  return { success: true };
}

/* ---------------------- fixtures ---------------------- */

function generateFixtures() {
  const ids = state.teams.map((t) => t.id);
  const n = ids.length;
  const fixed = ids[0];
  let rotating = ids.slice(1);
  const firstLeg = [];

  for (let r = 0; r < n - 1; r++) {
    const roundTeams = [fixed, ...rotating];
    const matches = [];
    for (let i = 0; i < n / 2; i++) {
      const t1 = roundTeams[i];
      const t2 = roundTeams[n - 1 - i];
      if (r % 2 === 0) matches.push({ home: t1, away: t2 });
      else matches.push({ home: t2, away: t1 });
    }
    firstLeg.push(matches);
    rotating.unshift(rotating.pop());
  }

  const secondLeg = firstLeg.map((round) => round.map((m) => ({ home: m.away, away: m.home })));
  const allRounds = [...firstLeg, ...secondLeg];

  const fixtures = [];
  allRounds.forEach((round, roundIdx) => {
    round.forEach((m) => {
      fixtures.push({
        id: uid("fx"),
        round: roundIdx + 1,
        home: m.home,
        away: m.away,
        played: false,
        homeScore: null,
        awayScore: null,
        events: [], // {side:'home'|'away', scorerId, assisterId|null}
      });
    });
  });

  state.fixtures = fixtures;
  state.fixturesGenerated = true;
  save();
}

function computeStandings() {
  const table = {};
  state.teams.forEach((t) => {
    table[t.id] = { team: t, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, PTS: 0 };
  });

  state.fixtures.filter((f) => f.played).forEach((f) => {
    const h = table[f.home];
    const a = table[f.away];
    if (!h || !a) return;
    h.P++; a.P++;
    h.GF += f.homeScore; h.GA += f.awayScore;
    a.GF += f.awayScore; a.GA += f.homeScore;
    if (f.homeScore > f.awayScore) { h.W++; h.PTS += 3; a.L++; }
    else if (f.homeScore < f.awayScore) { a.W++; a.PTS += 3; h.L++; }
    else { h.D++; a.D++; h.PTS += 1; a.PTS += 1; }
  });

  Object.values(table).forEach((r) => (r.GD = r.GF - r.GA));

  return Object.values(table).sort(
    (x, y) => y.PTS - x.PTS || y.GD - x.GD || y.GF - x.GF || x.team.name.localeCompare(y.team.name)
  );
}

function computeScorersAndAssists() {
  const goals = {};
  const assists = {};

  state.fixtures.filter((f) => f.played).forEach((f) => {
    f.events.forEach((ev) => {
      if (ev.scorerId) {
        goals[ev.scorerId] = (goals[ev.scorerId] || 0) + 1;
      }
      if (ev.assisterId) {
        assists[ev.assisterId] = (assists[ev.assisterId] || 0) + 1;
      }
    });
  });

  function toRows(map) {
    return Object.entries(map)
      .map(([playerId, count]) => {
        const found = findPlayer(playerId);
        if (!found) return null;
        return { playerId, count, name: found.player.name, team: found.team.name };
      })
      .filter(Boolean)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  return { scorers: toRows(goals), assisters: toRows(assists) };
}

/* ---------------------- finance ---------------------- */

function totalPlayers() {
  return state.teams.reduce((sum, t) => sum + t.players.length, 0);
}

function financeSummary() {
  const registration = totalPlayers() * REG_FEE;
  const disciplinePaid = state.cards.filter((c) => c.paid).reduce((s, c) => s + c.fee, 0);
  const disciplineUnpaid = state.cards.filter((c) => !c.paid).reduce((s, c) => s + c.fee, 0);
  const income = registration + disciplinePaid;
  const expenses = state.expenses.reduce((s, e) => s + Number(e.amount), 0);
  const balance = income - expenses;
  return { registration, disciplinePaid, disciplineUnpaid, income, expenses, balance };
}

/* ============================================================
   RENDERING
   ============================================================ */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function renderAll() {
  renderTopBar();
  renderHome();
  renderTable();
  renderFixtures();
  renderStats();
  renderDiscipline();
  renderTeams();
  renderFinance();
  renderAdmin();
  document.body.classList.toggle("is-admin", isAdmin());
}

/* ---- Top bar ---- */
function renderTopBar() {
  document.getElementById("leagueNameDisplay").textContent = state.leagueName;

  const acc = state.account;
  const accValue = document.getElementById("accountValue");
  if (acc.accountNumber) {
    accValue.innerHTML = `<strong>${acc.accountNumber}</strong> · ${acc.bankName || "Bank"} · ${
      acc.accountName || "Account name"
    }`;
  } else {
    accValue.textContent = "Not set yet — add it in Admin";
  }

  const potwValue = document.getElementById("potwValue");
  if (state.potw.name) {
    potwValue.innerHTML = `<strong>${state.potw.name}</strong> (${state.potw.team || "—"})${
      state.potw.week ? " · " + state.potw.week : ""
    }`;
  } else {
    potwValue.textContent = "Not selected yet";
  }
}

/* ---- Home ---- */
function renderHome() {
  const standings = computeStandings();
  const top5 = standings.slice(0, 5);
  const tbody = document.getElementById("homeMiniTable");
  tbody.innerHTML = "";
  top5.forEach((row, i) => {
    tbody.appendChild(
      el("tr", {}, [
        el("td", {}, String(i + 1)),
        el("td", { class: "team-cell" }, row.team.name),
        el("td", {}, String(row.P)),
        el("td", {}, String(row.PTS)),
      ])
    );
  });

  document.getElementById("statPlayers").textContent = totalPlayers();
  document.getElementById("statTeams").textContent = state.teams.length;
  const played = state.fixtures.filter((f) => f.played).length;
  document.getElementById("statPlayed").textContent = `${played}/${state.fixtures.length || 0}`;
  document.getElementById("statBalance").textContent = money(financeSummary().balance);

  if (state.potw.name) {
    document.getElementById("potwSpotlight").innerHTML = `
      <div class="potw-badge">${initials(state.potw.name)}</div>
      <div>
        <p class="potw-name">${state.potw.name}</p>
        <p class="potw-meta">${state.potw.team || "—"}${state.potw.week ? " · " + state.potw.week : ""}</p>
        <p class="potw-note">${state.potw.note || ""}</p>
      </div>`;
  } else {
    document.getElementById("potwSpotlight").innerHTML = `<p class="muted">No player of the week yet. The admin can set one from the Admin tab.</p>`;
  }
}

function initials(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

/* ---- League table ---- */
function renderTable() {
  const tbody = document.getElementById("tableBody");
  tbody.innerHTML = "";
  const standings = computeStandings();
  standings.forEach((row, i) => {
    tbody.appendChild(
      el("tr", {}, [
        el("td", {}, String(i + 1)),
        el("td", { class: "team-cell" }, row.team.name),
        el("td", {}, String(row.P)),
        el("td", {}, String(row.W)),
        el("td", {}, String(row.D)),
        el("td", {}, String(row.L)),
        el("td", {}, String(row.GF)),
        el("td", {}, String(row.GA)),
        el("td", {}, String(row.GD)),
        el("td", { class: "pts-cell" }, String(row.PTS)),
      ])
    );
  });
}

/* ---- Fixtures & results ---- */
function renderFixtures() {
  const container = document.getElementById("fixturesList");
  container.innerHTML = "";

  const genBtnWrap = document.getElementById("generateFixturesWrap");
  genBtnWrap.classList.toggle("hidden", !isAdmin());
  document.getElementById("generateFixturesBtn").textContent = state.fixturesGenerated
    ? "Regenerate fixtures (clears all results)"
    : "Generate fixtures (each team plays every other team twice)";

  if (!state.fixturesGenerated) {
    container.appendChild(el("p", { class: "muted" }, "No fixtures yet. An admin needs to generate them."));
    return;
  }

  const rounds = {};
  state.fixtures.forEach((f) => {
    rounds[f.round] = rounds[f.round] || [];
    rounds[f.round].push(f);
  });

  Object.keys(rounds)
    .sort((a, b) => a - b)
    .forEach((roundNo) => {
      const roundBox = el("div", { class: "round-box" });
      roundBox.appendChild(el("h3", { class: "round-title" }, `Matchday ${roundNo}`));
      const matchesWrap = el("div", { class: "match-grid" });

      rounds[roundNo].forEach((f) => matchesWrap.appendChild(renderMatchCard(f)));
      roundBox.appendChild(matchesWrap);
      container.appendChild(roundBox);
    });
}

function renderMatchCard(f) {
  const home = findTeam(f.home);
  const away = findTeam(f.away);
  const card = el("div", { class: "match-card" + (f.played ? " played" : "") });

  const scoreLine = el("div", { class: "score-line" }, [
    el("span", { class: "match-team home" }, home.name),
    el(
      "span",
      { class: "match-score" },
      f.played ? `${f.homeScore} – ${f.awayScore}` : "vs"
    ),
    el("span", { class: "match-team away" }, away.name),
  ]);
  card.appendChild(scoreLine);

  if (f.played && f.events.length) {
    const evList = el("ul", { class: "event-list" });
    f.events.forEach((ev) => {
      const scorer = findPlayer(ev.scorerId);
      const assister = ev.assisterId ? findPlayer(ev.assisterId) : null;
      const side = ev.side === "home" ? home.name : away.name;
      evList.appendChild(
        el(
          "li",
          {},
          `⚽ ${scorer ? scorer.player.name : "Unknown"} (${side})${
            assister ? ` — assist: ${assister.player.name}` : ""
          }`
        )
      );
    });
    card.appendChild(evList);
  }

  if (isAdmin()) {
    const btn = el("button", { class: "btn small ghost" }, f.played ? "Edit result" : "Enter result");
    btn.addEventListener("click", () => openResultModal(f.id));
    card.appendChild(btn);
  }

  return card;
}

/* ---- Scorers / assists ---- */
function renderStats() {
  const { scorers, assisters } = computeScorersAndAssists();
  fillStatTable("scorersBody", scorers);
  fillStatTable("assistersBody", assisters);
}

function fillStatTable(bodyId, rows) {
  const tbody = document.getElementById(bodyId);
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.appendChild(el("tr", {}, el("td", { colspan: "4", class: "muted" }, "No data yet.")));
    return;
  }
  rows.slice(0, 20).forEach((r, i) => {
    tbody.appendChild(
      el("tr", {}, [
        el("td", {}, String(i + 1)),
        el("td", {}, r.name),
        el("td", {}, r.team),
        el("td", { class: "pts-cell" }, String(r.count)),
      ])
    );
  });
}

/* ---- Discipline ---- */
function renderDiscipline() {
  const tbody = document.getElementById("cardsBody");
  tbody.innerHTML = "";
  const sorted = [...state.cards].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!sorted.length) {
    tbody.appendChild(el("tr", {}, el("td", { colspan: "6", class: "muted" }, "No cards recorded yet.")));
  }
  sorted.forEach((c) => {
    const row = el("tr", {}, [
      el("td", {}, c.playerName),
      el("td", {}, c.teamName),
      el("td", {}, el("span", { class: `tag ${c.type}` }, c.type === "yellow" ? "Yellow" : "Red")),
      el("td", {}, money(c.fee)),
      el("td", {}, el("span", { class: "tag " + (c.paid ? "paid" : "unpaid") }, c.paid ? "Paid" : "Not paid")),
      el("td", {}, new Date(c.date).toLocaleDateString()),
    ]);
    if (isAdmin()) {
      const toggleBtn = el("button", { class: "btn tiny" }, c.paid ? "Mark unpaid" : "Mark paid");
      toggleBtn.addEventListener("click", () => {
        c.paid = !c.paid;
        save();
        renderAll();
      });
      const cell = el("td", {}, toggleBtn);
      row.appendChild(cell);
    } else {
      row.appendChild(el("td", {}, ""));
    }
    tbody.appendChild(row);
  });

  // header adjust for admin action column
  const headRow = document.getElementById("cardsHeadRow");
  const hasActionCol = headRow.children.length === 7;
  if (isAdmin() && !hasActionCol) headRow.appendChild(el("th", {}, "Action"));
  if (!isAdmin() && hasActionCol) headRow.removeChild(headRow.lastChild);

  document.getElementById("disciplineAdminBox").classList.toggle("hidden", !isAdmin());
  populateCardPlayerSelect();
  renderRemovedPlayers();
}

function renderRemovedPlayers() {
  const tbody = document.getElementById("removedBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const sorted = [...state.removedPlayers].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!sorted.length) {
    tbody.appendChild(el("tr", {}, el("td", { colspan: "7", class: "muted" }, "No players removed yet.")));
    return;
  }
  sorted.forEach((r) => {
    tbody.appendChild(
      el("tr", {}, [
        el("td", {}, r.name),
        el("td", {}, r.team),
        el("td", {}, r.position),
        el("td", {}, money(r.paidFines)),
        el(
          "td",
          {},
          r.unpaidFines > 0 ? el("span", { class: "tag unpaid" }, money(r.unpaidFines) + " owed") : el("span", { class: "tag paid" }, "Cleared")
        ),
        el("td", {}, r.reason || "—"),
        el("td", {}, new Date(r.date).toLocaleDateString()),
      ])
    );
  });
}

function populateCardPlayerSelect() {
  const sel = document.getElementById("cardPlayerSelect");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Select player…</option>';
  state.teams.forEach((t) => {
    if (!t.players.length) return;
    const group = el("optgroup", { label: t.name });
    t.players.forEach((p) => group.appendChild(el("option", { value: p.id }, `${p.name} (${p.position})`)));
    sel.appendChild(group);
  });
  sel.value = current;
}

/* ---- Teams ---- */
function renderTeams() {
  const grid = document.getElementById("teamsGrid");
  grid.innerHTML = "";
  const admin = isAdmin();

  state.teams.forEach((t) => {
    const counts = positionCounts(t);
    const card = el("div", { class: "team-card" });

    const heading = el("div", { class: "team-card-head" });
    if (admin) {
      const nameInput = el("input", { type: "text", class: "team-name-input", value: t.name });
      nameInput.addEventListener("change", () => {
        renameTeam(t.id, nameInput.value);
        renderAll();
      });
      heading.appendChild(nameInput);
    } else {
      heading.appendChild(el("h3", {}, t.name));
    }
    card.appendChild(heading);

    card.appendChild(
      el(
        "p",
        { class: "muted small" },
        `${t.players.length}/${SQUAD_MAX} players · GK ${counts.GK}/1 · DEF ${counts.DEF}/3 · MID ${counts.MID}/3 · FWD ${counts.FWD}/3`
      )
    );

    const list = el("ul", { class: "squad-list" });
    if (!t.players.length) {
      list.appendChild(el("li", { class: "muted" }, "No players yet."));
    } else {
      t.players
        .slice()
        .sort((a, b) => (a.position === b.position ? a.name.localeCompare(b.name) : a.position.localeCompare(b.position)))
        .forEach((p) => {
          if (!admin) {
            list.appendChild(
              el("li", {}, [
                el("span", {}, p.name),
                el("span", { class: "pos-badge " + p.position }, p.position),
              ])
            );
            return;
          }

          // ---- admin editable row ----
          const row = el("li", { class: "squad-row-admin" });

          const nameInput = el("input", { type: "text", class: "squad-name-input", value: p.name });
          nameInput.addEventListener("change", () => {
            const result = updatePlayer(p.id, { name: nameInput.value }, true);
            if (!result.success) alert(result.message);
            renderAll();
          });

          const posSelect = el(
            "select",
            { class: "squad-pos-select" },
            Object.keys(POSITIONS).map((pos) => el("option", { value: pos }, pos))
          );
          posSelect.value = p.position;
          posSelect.addEventListener("change", () => {
            let result = updatePlayer(p.id, { position: posSelect.value });
            if (!result.success && result.needsForce) {
              const force = confirm(result.message + "\n\nPut them there anyway?");
              if (force) result = updatePlayer(p.id, { position: posSelect.value }, true);
              else posSelect.value = p.position;
            } else if (!result.success) {
              alert(result.message);
              posSelect.value = p.position;
            }
            renderAll();
          });

          const teamSelect = el(
            "select",
            { class: "squad-team-select" },
            state.teams.map((team) => el("option", { value: team.id }, team.name))
          );
          teamSelect.value = t.id;
          teamSelect.addEventListener("change", () => {
            let result = movePlayer(p.id, teamSelect.value);
            if (!result.success && result.needsForce) {
              const force = confirm(result.message + "\n\nMove them anyway?");
              if (force) result = movePlayer(p.id, teamSelect.value, true);
              else teamSelect.value = t.id;
            } else if (!result.success) {
              alert(result.message);
              teamSelect.value = t.id;
            }
            renderAll();
          });

          const removeBtn = el("button", { class: "btn tiny ghost", type: "button" }, "✕");
          removeBtn.addEventListener("click", () => {
            const playerCards = state.cards.filter((c) => c.playerId === p.id);
            const unpaid = playerCards.filter((c) => !c.paid).reduce((s, c) => s + c.fee, 0);
            const warn = unpaid > 0 ? `\n\nNote: they still owe ${money(unpaid)} in unpaid fines.` : "";
            if (!confirm(`Remove ${p.name} from the league?${warn}`)) return;
            const reason = prompt("Reason for removal (optional — this is kept in the removal record):", "") || "";
            removePlayer(p.id, reason);
            renderAll();
          });

          row.append(nameInput, posSelect, teamSelect, removeBtn);
          list.appendChild(row);
        });
    }
    card.appendChild(list);

    if (admin) {
      const addForm = el("form", { class: "add-to-team-form" });
      const addName = el("input", { type: "text", placeholder: "Player name", required: "required" });
      const addPos = el(
        "select",
        {},
        Object.keys(POSITIONS).map((pos) => el("option", { value: pos }, pos))
      );
      const addBtn = el("button", { class: "btn tiny primary", type: "submit" }, "+ Add here");
      addForm.append(addName, addPos, addBtn);
      addForm.addEventListener("submit", (e) => {
        e.preventDefault();
        let result = addPlayerToTeam(t.id, addName.value, addPos.value);
        if (!result.success && result.needsForce) {
          const force = confirm(result.message + "\n\nAdd them anyway?");
          if (force) result = addPlayerToTeam(t.id, addName.value, addPos.value, true);
        } else if (!result.success) {
          alert(result.message);
        }
        if (result.success) renderAll();
      });
      card.appendChild(addForm);
    }

    grid.appendChild(card);
  });

  document.getElementById("teamsAdminBox").classList.toggle("hidden", !admin);
}

/* ---- Finance ---- */
function renderFinance() {
  const f = financeSummary();
  document.getElementById("finRegistration").textContent = money(f.registration);
  document.getElementById("finDiscipline").textContent = money(f.disciplinePaid);
  document.getElementById("finDisciplinePending").textContent = money(f.disciplineUnpaid);
  document.getElementById("finIncome").textContent = money(f.income);
  document.getElementById("finExpenses").textContent = money(f.expenses);
  document.getElementById("finBalance").textContent = money(f.balance);

  const tbody = document.getElementById("expensesBody");
  tbody.innerHTML = "";
  if (!state.expenses.length) {
    tbody.appendChild(el("tr", {}, el("td", { colspan: "3", class: "muted" }, "No expenses logged yet.")));
  }
  [...state.expenses].reverse().forEach((e) => {
    tbody.appendChild(
      el("tr", {}, [
        el("td", {}, e.desc),
        el("td", {}, money(e.amount)),
        el("td", {}, new Date(e.date).toLocaleDateString()),
      ])
    );
  });

  document.getElementById("financeAdminBox").classList.toggle("hidden", !isAdmin());

  const acc = state.account;
  document.getElementById("accBankName").value = acc.bankName || "";
  document.getElementById("accName").value = acc.accountName || "";
  document.getElementById("accNumber").value = acc.accountNumber || "";
}

/* ---- Admin ---- */
function renderAdmin() {
  document.getElementById("adminLoginBox").classList.toggle("hidden", isAdmin());
  document.getElementById("adminDashboard").classList.toggle("hidden", !isAdmin());
  if (!isAdmin()) return;

  document.getElementById("potwNameInput").value = state.potw.name || "";
  document.getElementById("potwTeamInput").value = state.potw.team || "";
  document.getElementById("potwWeekInput").value = state.potw.week || "";
  document.getElementById("potwNoteInput").value = state.potw.note || "";
  document.getElementById("leagueNameInput").value = state.leagueName || "";
}

/* ============================================================
   EVENTS / WIRING
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  wireTabs();
  wireHome();
  wireTeamsForms();
  wireDisciplineForms();
  wireFinanceForms();
  wireAdminForms();
  wireResultModal();
  renderAll(); // paint the default/empty state immediately so the page isn't blank
  initCloudSync(); // then connect to Firestore and take over rendering with live data
});

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function wireHome() {
  // nothing interactive besides nav links to registration
  const goToTeams = document.getElementById("goToRegisterBtn");
  if (goToTeams) {
    goToTeams.addEventListener("click", () => {
      document.querySelector('.tab-btn[data-tab="teams"]').click();
    });
  }
}

function wireTeamsForms() {
  const form = document.getElementById("registerPlayerForm");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("newPlayerName").value;
    const position = document.getElementById("newPlayerPosition").value;
    const msgBox = document.getElementById("registerMsg");
    const result = registerPlayer(name, position);
    if (result.success) {
      msgBox.textContent = `${result.player.name} paid ₦${REG_FEE.toLocaleString()} and has been placed on ${
        result.team.name
      } as ${POSITIONS[position].label}.`;
      msgBox.className = "form-msg success";
      form.reset();
      renderAll();
    } else {
      msgBox.textContent = result.message;
      msgBox.className = "form-msg error";
    }
  });
}

function wireDisciplineForms() {
  const form = document.getElementById("addCardForm");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const playerId = document.getElementById("cardPlayerSelect").value;
    const type = document.getElementById("cardTypeSelect").value;
    const paidNow = document.getElementById("cardPaidCheckbox").checked;
    const msgBox = document.getElementById("cardMsg");
    if (!playerId) {
      msgBox.textContent = "Select a player first.";
      msgBox.className = "form-msg error";
      return;
    }
    const found = findPlayer(playerId);
    const fee = type === "yellow" ? YELLOW_FEE : RED_FEE;
    state.cards.push({
      id: uid("card"),
      playerId,
      playerName: found.player.name,
      teamName: found.team.name,
      type,
      fee,
      paid: paidNow,
      date: new Date().toISOString(),
    });
    save();
    msgBox.textContent = `${type === "yellow" ? "Yellow" : "Red"} card recorded for ${found.player.name} (${money(
      fee
    )}).`;
    msgBox.className = "form-msg success";
    form.reset();
    renderAll();
  });
}

function wireFinanceForms() {
  const accForm = document.getElementById("accountForm");
  if (accForm) {
    accForm.addEventListener("submit", (e) => {
      e.preventDefault();
      state.account.bankName = document.getElementById("accBankName").value.trim();
      state.account.accountName = document.getElementById("accName").value.trim();
      state.account.accountNumber = document.getElementById("accNumber").value.trim();
      save();
      renderAll();
      const msg = document.getElementById("accountMsg");
      msg.textContent = "Account details updated.";
      msg.className = "form-msg success";
    });
  }

  const expForm = document.getElementById("addExpenseForm");
  if (expForm) {
    expForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const desc = document.getElementById("expenseDesc").value.trim();
      const amount = Number(document.getElementById("expenseAmount").value);
      if (!desc || !amount) return;
      state.expenses.push({ id: uid("exp"), desc, amount, date: new Date().toISOString() });
      save();
      expForm.reset();
      renderAll();
    });
  }
}

function wireAdminForms() {
  const loginForm = document.getElementById("adminLoginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const pw = document.getElementById("adminPasswordInput").value;
      const msg = document.getElementById("loginMsg");
      if (pw === state.adminPassword) {
        sessionStorage.setItem(ADMIN_SESSION_KEY, "true");
        loginForm.reset();
        renderAll();
      } else {
        msg.textContent = "Wrong password. Try again.";
        msg.className = "form-msg error";
      }
    });
  }

  const logoutBtn = document.getElementById("adminLogoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      renderAll();
    });
  }

  const genBtn = document.getElementById("generateFixturesBtn");
  if (genBtn) {
    genBtn.addEventListener("click", () => {
      if (state.fixturesGenerated) {
        const ok = confirm("This clears every recorded score and event. Continue?");
        if (!ok) return;
      }
      generateFixtures();
      renderAll();
    });
  }

  const potwForm = document.getElementById("potwForm");
  if (potwForm) {
    potwForm.addEventListener("submit", (e) => {
      e.preventDefault();
      state.potw = {
        name: document.getElementById("potwNameInput").value.trim(),
        team: document.getElementById("potwTeamInput").value.trim(),
        week: document.getElementById("potwWeekInput").value.trim(),
        note: document.getElementById("potwNoteInput").value.trim(),
      };
      save();
      renderAll();
    });
  }

  const leagueNameForm = document.getElementById("leagueNameForm");
  if (leagueNameForm) {
    leagueNameForm.addEventListener("submit", (e) => {
      e.preventDefault();
      state.leagueName = document.getElementById("leagueNameInput").value.trim() || state.leagueName;
      save();
      renderAll();
    });
  }

  const pwForm = document.getElementById("changePasswordForm");
  if (pwForm) {
    pwForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const current = document.getElementById("currentPasswordInput").value;
      const next = document.getElementById("newPasswordInput").value;
      const msg = document.getElementById("passwordMsg");
      if (current !== state.adminPassword) {
        msg.textContent = "Current password is wrong.";
        msg.className = "form-msg error";
        return;
      }
      if (next.length < 4) {
        msg.textContent = "New password should be at least 4 characters.";
        msg.className = "form-msg error";
        return;
      }
      state.adminPassword = next;
      save();
      pwForm.reset();
      msg.textContent = "Password updated.";
      msg.className = "form-msg success";
    });
  }

  const resetForm = document.getElementById("resetLeagueBtn");
  if (resetForm) {
    resetForm.addEventListener("click", () => {
      const ok = confirm("This wipes ALL league data (teams, players, fixtures, cards, finance). Continue?");
      if (!ok) return;
      const keptName = state.leagueName;
      const keptPassword = state.adminPassword;
      state = createDefaultState();
      state.leagueName = keptName;
      state.adminPassword = keptPassword;
      save();
      renderAll();
    });
  }
}

/* ---- Result modal ---- */
let activeFixtureId = null;

function wireResultModal() {
  document.getElementById("closeModalBtn").addEventListener("click", closeResultModal);
  document.getElementById("resultModal").addEventListener("click", (e) => {
    if (e.target.id === "resultModal") closeResultModal();
  });
  document.getElementById("addEventRowBtn").addEventListener("click", () => addEventRow());
  document.getElementById("resultForm").addEventListener("submit", saveResult);
}

function openResultModal(fixtureId) {
  activeFixtureId = fixtureId;
  const f = state.fixtures.find((x) => x.id === fixtureId);
  const home = findTeam(f.home);
  const away = findTeam(f.away);

  document.getElementById("modalTitle").textContent = `${home.name} vs ${away.name}`;
  document.getElementById("homeScoreInput").value = f.homeScore ?? "";
  document.getElementById("awayScoreInput").value = f.awayScore ?? "";
  document.getElementById("modalHomeLabel").textContent = home.name;
  document.getElementById("modalAwayLabel").textContent = away.name;

  const eventsWrap = document.getElementById("eventRows");
  eventsWrap.innerHTML = "";
  if (f.events.length) {
    f.events.forEach((ev) => addEventRow(ev));
  }

  document.getElementById("resultModal").classList.remove("hidden");
}

function closeResultModal() {
  document.getElementById("resultModal").classList.add("hidden");
  activeFixtureId = null;
}

function addEventRow(existing = null) {
  const f = state.fixtures.find((x) => x.id === activeFixtureId);
  const home = findTeam(f.home);
  const away = findTeam(f.away);

  const row = el("div", { class: "event-row" });

  const sideSelect = el("select", { class: "ev-side" }, [
    el("option", { value: "home" }, home.name),
    el("option", { value: "away" }, away.name),
  ]);
  sideSelect.value = existing?.side || "home";

  const scorerSelect = el("select", { class: "ev-scorer" });
  const assisterSelect = el("select", { class: "ev-assister" });

  function fillPlayerSelects() {
    const team = sideSelect.value === "home" ? home : away;
    scorerSelect.innerHTML = '<option value="">Scorer…</option>';
    assisterSelect.innerHTML = '<option value="">No assist</option>';
    team.players.forEach((p) => {
      scorerSelect.appendChild(el("option", { value: p.id }, p.name));
      assisterSelect.appendChild(el("option", { value: p.id }, p.name));
    });
    if (existing) {
      scorerSelect.value = existing.scorerId || "";
      assisterSelect.value = existing.assisterId || "";
    }
  }
  fillPlayerSelects();
  sideSelect.addEventListener("change", fillPlayerSelects);

  const removeBtn = el("button", { type: "button", class: "btn tiny ghost" }, "✕");
  removeBtn.addEventListener("click", () => row.remove());

  row.append(
    el("span", { class: "ev-label" }, "⚽"),
    sideSelect,
    scorerSelect,
    el("span", { class: "ev-label" }, "assist:"),
    assisterSelect,
    removeBtn
  );

  document.getElementById("eventRows").appendChild(row);
}

function saveResult(e) {
  e.preventDefault();
  const f = state.fixtures.find((x) => x.id === activeFixtureId);
  const homeScore = Number(document.getElementById("homeScoreInput").value);
  const awayScore = Number(document.getElementById("awayScoreInput").value);

  if (Number.isNaN(homeScore) || Number.isNaN(awayScore) || homeScore < 0 || awayScore < 0) {
    alert("Enter a valid score for both teams.");
    return;
  }

  const events = [];
  document.querySelectorAll("#eventRows .event-row").forEach((row) => {
    const side = row.querySelector(".ev-side").value;
    const scorerId = row.querySelector(".ev-scorer").value;
    const assisterId = row.querySelector(".ev-assister").value;
    if (scorerId) events.push({ side, scorerId, assisterId: assisterId || null });
  });

  const totalGoals = homeScore + awayScore;
  if (events.length !== totalGoals) {
    const proceed = confirm(
      `You entered a score of ${homeScore}-${awayScore} (${totalGoals} goals) but logged ${events.length} goal event(s). Save anyway?`
    );
    if (!proceed) return;
  }

  f.homeScore = homeScore;
  f.awayScore = awayScore;
  f.events = events;
  f.played = true;
  save();
  closeResultModal();
  renderAll();
}
