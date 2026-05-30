import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { getTeamSize, roleAllegiance, type MissionCard, type Role, type Vote } from '../src/domain/avalon';

interface PlayerSession {
  index: number;
  name: string;
  page: Page;
  role?: Role;
}

interface StartedRoom {
  context: BrowserContext;
  host: Page;
  players: PlayerSession[];
  roomCode: string;
}

test('live UI creates a room, joins five players, starts, proposes, votes, and submits mission cards', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ host, players }) => {
    for (const page of players.map((player) => player.page)) {
      await expect(page.getByText(/Table Quest/i)).toBeVisible();
    }

    await expect(host.locator('.mission-panel-heading .phase-badge')).toHaveCSS('border-top-width', '0px');
    await expect(host.locator('.mission-panel-heading .phase-badge')).toHaveCSS('box-shadow', 'none');
    await expect(host.locator('.mission-section-heading').filter({ hasText: 'First side to three wins' }).locator('span')).toHaveCSS('border-top-width', '0px');
    await expect(host.locator('.team-roster-heading').filter({ hasText: 'Proposed crew' }).locator('span')).toHaveCSS('border-top-width', '0px');
    await expect(host.getByText('Recovery controls')).toBeVisible();
    await expect(host.locator('.mission-admin')).not.toHaveAttribute('open', '');
    await expect(host.getByRole('button', { name: 'Submit Backup Proposal' })).toBeHidden();

    const team = players.slice(0, 2);
    await proposeTeam(players, team);
    await submitVotes(players, () => 'approve');

    await expect(host.getByText('Mission card', { exact: true }).first().or(host.getByText('Mission', { exact: true }).first())).toBeVisible();
    await submitMissionCards(team, () => 'success');

    await expect(host.getByText(/Good won/i)).toBeVisible();
    await expect(host.getByText('Quest 2 of 5')).toBeVisible();
  });
});

test('five-player Good reaches three successful quests, Assassin hits Merlin, and Evil wins', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ host, players }) => {
    await revealRoles(players);
    await playThreeSuccessfulGoodQuests(players);

    const assassin = requirePlayerWithRole(players, 'Assassin');
    const merlin = requirePlayerWithRole(players, 'Merlin');
    await expect(assassin.page.getByRole('heading', { name: /Choose Merlin/i })).toBeVisible();

    await assassinate(assassin, merlin);

    await expect(host.getByRole('heading', { name: /Evil Wins/i })).toBeVisible();
    await expect(host.getByText(/The target was Merlin/i)).toBeVisible();
    await expect(assassin.page.getByRole('dialog').getByRole('heading', { name: /You won this game/i })).toBeVisible();
    await expect(merlin.page.getByRole('dialog').getByRole('heading', { name: /You lost this game/i })).toBeVisible();
    await expect(merlin.page.getByRole('dialog').getByText(/Your role/i)).toBeVisible();

    for (const player of players) {
      await player.page.getByRole('button', { name: /^Play Again$/i }).click();
    }

    await expect(host.getByRole('heading', { name: /Current Room/i })).toBeVisible();
    await expect(host.getByRole('button', { name: /^Start Game$/i })).toBeEnabled();
    await expect(host.getByRole('heading', { name: /Room history/i })).toBeVisible();
    await expect(host.getByText(/Game 1: Evil won/i)).toBeVisible();
    await expect(merlin.page.getByText(/You were Good · Merlin · Defeat/i)).toBeVisible();
  });
});

test('five-player Good reaches three successful quests, Assassin misses Merlin, and Good wins', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ host, players }) => {
    await revealRoles(players);
    await playThreeSuccessfulGoodQuests(players);

    const assassin = requirePlayerWithRole(players, 'Assassin');
    const nonMerlinGood = players.find((player) => player.role && roleAllegiance(player.role) === 'good' && player.role !== 'Merlin');
    expect(nonMerlinGood, 'expected a good non-Merlin target').toBeTruthy();

    await assassinate(assassin, nonMerlinGood!);

    await expect(host.getByRole('heading', { name: /Good Wins/i })).toBeVisible();
    await expect(host.getByText(/The target was not Merlin/i)).toBeVisible();
  });
});

test('five-player Evil wins through three failed quests', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ host, players }) => {
    await revealRoles(players);
    const saboteur = players.find((player) => player.role && roleAllegiance(player.role) === 'evil');
    expect(saboteur, 'expected at least one evil player').toBeTruthy();

    for (let roundIndex = 0; roundIndex < 3; roundIndex += 1) {
      const teamSize = getTeamSize(players.length, roundIndex);
      const team = selectTeamIncluding(players, saboteur!, teamSize);
      await playApprovedMission(players, team, (player) => (player === saboteur ? 'fail' : 'success'));
    }

    await expect(host.getByText(/Evil wins after three failed quests/i)).toBeVisible();
    await expect(host.getByText(/Quest Failed/i).first()).toBeVisible();
  });
});

test('six-player rejected team vote rotates leader, then the next leader recovers with a successful quest', async ({ browser }) => {
  await withStartedRoom(browser, 6, async ({ host, players }) => {
    await revealRoles(players);
    const firstLeader = await findLeader(players);
    const firstLeaderIndex = firstLeader.index;

    await proposeTeam(players, players.slice(0, getTeamSize(players.length, 0)));
    await submitVotes(players, (_player, index) => (index < 3 ? 'reject' : 'approve'));

    await expect(host.getByText(/Last proposal: 3 approve, 3 reject\. Crew rejected\./i)).toBeVisible();
    const nextLeader = await findLeader(players);
    expect(nextLeader.index).toBe((firstLeaderIndex + 1) % players.length);

    const goodPlayers = players.filter((player) => player.role && roleAllegiance(player.role) === 'good');
    const recoveryTeam = goodPlayers.slice(0, getTeamSize(players.length, 0));
    await playApprovedMission(players, recoveryTeam, () => 'success');

    await expect(host.getByText(/Good won/i)).toBeVisible();
    await expect(host.getByText('Quest 2 of 5')).toBeVisible();
  });
});

test('lobby room controls are scoped to host and guests', async ({ browser }) => {
  const room = await createLobbyRoom(browser, 5);
  try {
    const { host, players } = room;
    const guest = players[1].page;
    for (const player of players) {
      const readyButton = player.page.getByRole('button', { name: /^Set Ready$/i });
      if (await readyButton.isVisible()) await readyButton.click();
    }

    await expect(host.getByRole('button', { name: /^Leave Room$/i })).toBeVisible();
    await expect(host.getByRole('button', { name: /^Dissolve Room$/i })).toBeVisible();
    await expect(host.getByRole('button', { name: /^Start Game$/i })).toBeEnabled();

    await expect(guest.getByRole('button', { name: /^Leave Room$/i })).toBeVisible();
    await expect(guest.getByRole('button', { name: /^Dissolve Room$/i })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: /^Start Game$/i })).toHaveCount(0);
    await expect(guest.getByText(/Waiting for the host to start the game/i)).toBeVisible();
  } finally {
    await room.context.close();
  }
});

test('private reveal swipe area shows each side only while held or dragged', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ players }) => {
    const swipeArea = players[0].page.locator('.live-player-phone .phone-private-swipe');
    const roleFace = players[0].page.locator('.live-player-phone .phone-role .role-face');
    const nightInfoFace = players[0].page.locator('.live-player-phone .phone-night-info .night-info-face');
    const rolePanel = players[0].page.locator('.live-player-phone .private-swipe-left');
    const nightInfoPanel = players[0].page.locator('.live-player-phone .private-swipe-right');
    const slider = players[0].page.locator('.live-player-phone .private-swipe-slider');
    const neutralCover = players[0].page.locator('.live-player-phone .private-swipe-neutral');

    await expect(swipeArea).toHaveCount(1);
    await expect(players[0].page.getByRole('button', { name: /Reveal .* hidden role/i })).toBeVisible();
    await expect(players[0].page.getByRole('button', { name: /Reveal .* hidden night information/i })).toBeVisible();
    await expect(roleFace).toHaveCSS('visibility', 'visible');
    await expect(nightInfoFace).toHaveCSS('visibility', 'visible');
    await expect(rolePanel).toHaveCSS('opacity', '1');
    await expect(nightInfoPanel).toHaveCSS('opacity', '1');
    await expect(neutralCover).toHaveCSS('opacity', '1');

    const box = await swipeArea.boundingBox();
    const initialRoleBox = await rolePanel.boundingBox();
    const initialNightInfoBox = await nightInfoPanel.boundingBox();
    const initialSliderBox = await slider.boundingBox();
    expect(box).not.toBeNull();
    expect(initialRoleBox).not.toBeNull();
    expect(initialNightInfoBox).not.toBeNull();
    expect(initialSliderBox).not.toBeNull();
    if (!box || !initialRoleBox || !initialNightInfoBox || !initialSliderBox) return;

    await players[0].page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await players[0].page.mouse.down();
    await players[0].page.mouse.move(box.x + box.width * 0.88, box.y + box.height / 2, { steps: 5 });
    const rightDraggedRoleBox = await rolePanel.boundingBox();
    const rightDraggedSliderBox = await slider.boundingBox();
    expect(rightDraggedRoleBox).not.toBeNull();
    expect(rightDraggedSliderBox).not.toBeNull();
    if (!rightDraggedRoleBox || !rightDraggedSliderBox) return;
    expect(Math.abs(rightDraggedRoleBox.x - initialRoleBox.x)).toBeLessThan(1);
    expect(rightDraggedSliderBox.x).toBeGreaterThan(initialSliderBox.x + 40);
    await expect(neutralCover).toHaveCSS('opacity', '1');
    await players[0].page.mouse.up();
    await expect(slider).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');

    await players[0].page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await players[0].page.mouse.down();
    await players[0].page.mouse.move(box.x + box.width * 0.12, box.y + box.height / 2, { steps: 5 });
    const leftDraggedNightInfoBox = await nightInfoPanel.boundingBox();
    const leftDraggedSliderBox = await slider.boundingBox();
    expect(leftDraggedNightInfoBox).not.toBeNull();
    expect(leftDraggedSliderBox).not.toBeNull();
    if (!leftDraggedNightInfoBox || !leftDraggedSliderBox) return;
    expect(leftDraggedNightInfoBox.x).toBeLessThan(initialNightInfoBox.x - 40);
    expect(leftDraggedSliderBox.x).toBeLessThan(initialSliderBox.x - 40);
    await expect(neutralCover).toHaveCSS('opacity', '1');
    await players[0].page.mouse.up();
    await expect(slider).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  });
});

test('create-room shows default roles and custom role config affects assignment', async ({ browser }) => {
  const room = await createLobbyRoom(browser, 7, async (host) => {
    await expect(host.getByLabel(/Table size/i).getByRole('button', { name: '7' })).toHaveClass(/selected/);
    await expect(host.getByText('Good roles')).toBeVisible();
    await expect(host.locator('.create-role-list').filter({ hasText: 'Good roles' }).getByText('Percival')).toBeVisible();
    await expect(host.locator('.create-role-list').filter({ hasText: 'Evil roles' }).getByText('Morgana')).toBeVisible();
    await expect(host.locator('.create-role-list').filter({ hasText: 'Evil roles' }).getByText('Mordred')).toBeVisible();

    await host.getByRole('button', { name: /^Morgana/i }).click();
    await expect(host.locator('.create-role-list').filter({ hasText: 'Evil roles' }).getByText('Morgana')).toHaveCount(0);
  });

  try {
    const { host, players } = room;
    for (const player of players) {
      const readyButton = player.page.getByRole('button', { name: /^Set Ready$/i });
      if (await readyButton.isVisible()) await readyButton.click();
    }

    await expect(host.getByRole('button', { name: /^Start Game$/i })).toBeEnabled();
    await host.getByRole('button', { name: /^Start Game$/i }).click();
    await revealRoles(players);

    const roles = players.map((player) => player.role);
    expect(roles).toContain('Percival');
    expect(roles).toContain('Mordred');
    expect(roles).not.toContain('Morgana');
  } finally {
    await room.context.close();
  }
});

test('create-room teaches AI fill and a two-human five-seat room progresses with AI actions', async ({ browser }) => {
  const context = await browser.newContext();
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const host = await context.newPage();
  const guest = await context.newPage();
  const players: PlayerSession[] = [
    { index: 0, name: 'E2E Human 1', page: host },
    { index: 1, name: 'E2E Human 2', page: guest },
  ];

  try {
    await host.goto(`/?devSession=${runId}-p1`);
    await host.getByRole('button', { name: /Host the round/i }).click();
    await expect(host.getByLabel(/Human player count/i).getByRole('button', { name: '5' })).toHaveClass(/selected/);
    await expect(host.getByLabel(/Table size/i).getByRole('button', { name: '5' })).toHaveClass(/selected/);
    await host.getByLabel(/Your nickname/i).fill(players[0].name);
    await host.getByLabel(/Human player count/i).getByRole('button', { name: '2' }).click();
    await expect(host.getByText(/2 humans \+ 3 AI/i)).toBeVisible();
    await expect(host.getByText(/AI will fill empty seats and auto-ready\/vote\/play mission cards/i)).toBeVisible();
    await host.getByRole('button', { name: /^Create Room$/i }).click();

    await expect(host.getByRole('heading', { name: /Current Room/i })).toBeVisible();
    await expect(host.locator('.players li').filter({ hasText: /AI Seat 1/i }).getByText(/^AI$/)).toBeVisible();
    const roomCode = (await host.locator('.room-code-copy strong').innerText()).trim();

    await guest.goto(`/?devSession=${runId}-p2&step=join&code=${roomCode}`);
    await guest.getByLabel(/Your nickname/i).fill(players[1].name);
    await guest.getByRole('button', { name: /^Join Room$/i }).click();
    await expect(guest.getByRole('heading', { name: /Current Room/i })).toBeVisible();

    for (const player of players) {
      const readyButton = player.page.getByRole('button', { name: /^Set Ready$/i });
      if (await readyButton.isVisible()) await readyButton.click();
    }

    await expect(host.getByRole('button', { name: /^Start Game$/i })).toBeEnabled();
    await host.getByRole('button', { name: /^Start Game$/i }).click();
    await expect(host.getByText(/Table Quest/i)).toBeVisible();
    await expect(guest.getByText(/Table Quest/i)).toBeVisible();

    await proposeTeam(players, players);
    await submitVotes(players, () => 'approve');
    await expect(host.getByText('Mission card', { exact: true }).first().or(host.getByText('Mission', { exact: true }).first())).toBeVisible();
    await submitMissionCards(players, () => 'success');

    await expect(host.getByText(/Good won/i).or(host.getByText(/Evil won/i))).toBeVisible();
    await expect(host.getByText('Quest 2 of 5')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('mission cards enforce Good cannot fail and Evil can fail in the live UI', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ players }) => {
    await revealRoles(players);
    const goodPlayer = players.find((player) => player.role && roleAllegiance(player.role) === 'good');
    const evilPlayer = players.find((player) => player.role && roleAllegiance(player.role) === 'evil');
    expect(goodPlayer, 'expected a good player').toBeTruthy();
    expect(evilPlayer, 'expected an evil player').toBeTruthy();

    await proposeTeam(players, [goodPlayer!, evilPlayer!]);
    await submitVotes(players, () => 'approve');

    const goodFail = goodPlayer!.page.getByRole('button', { name: /^Fail$/i });
    const evilFail = evilPlayer!.page.getByRole('button', { name: /^Fail$/i });
    await expect(goodFail).toBeDisabled();
    await expect(evilFail).toBeEnabled();

    await goodPlayer!.page.getByRole('button', { name: /^Success$/i }).click();
    await evilFail.click();
    await expect(evilPlayer!.page.getByText(/Quest 2 of 5/i)).toBeVisible();
  });
});

async function withStartedRoom(
  browser: Browser,
  playerCount: number,
  run: (room: StartedRoom) => Promise<void>,
): Promise<void> {
  const room = await createStartedRoom(browser, playerCount);
  try {
    await run(room);
  } finally {
    await room.context.close();
  }
}

async function createStartedRoom(browser: Browser, playerCount: number): Promise<StartedRoom> {
  const room = await createLobbyRoom(browser, playerCount);
  const { host, players } = room;
  for (const player of players) {
    const readyButton = player.page.getByRole('button', { name: /^Set Ready$/i });
    if (await readyButton.isVisible()) await readyButton.click();
  }

  await expect(host.getByRole('button', { name: /^Start Game$/i })).toBeEnabled();
  await host.getByRole('button', { name: /^Start Game$/i }).click();

  for (const player of players) {
    await expect(player.page.getByRole('heading', { name: /Game Progress/i })).toBeVisible();
    await expect(player.page.getByRole('heading', { name: /Your Player Area/i })).toBeVisible();
    await expect(player.page.getByText(/Table Quest/i)).toBeVisible();
  }

  return room;
}

async function createLobbyRoom(browser: Browser, playerCount: number, configureHost?: (host: Page) => Promise<void>): Promise<StartedRoom> {
  const context = await browser.newContext();
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const players: PlayerSession[] = [];

  for (let index = 0; index < playerCount; index += 1) {
    players.push({ index, name: `E2E P${index + 1}`, page: await context.newPage() });
  }

  const host = players[0].page;
  await host.goto(`/?devSession=${runId}-p1`);
  await host.getByRole('button', { name: /Host the round/i }).click();
  await host.getByLabel(/Your nickname/i).fill(players[0].name);
  await host.getByLabel(/Human player count/i).getByRole('button', { name: String(playerCount) }).click();
  await host.getByLabel(/Table size/i).getByRole('button', { name: String(playerCount) }).click();
  await configureHost?.(host);
  await host.getByRole('button', { name: /^Create Room$/i }).click();
  await expect(host.getByRole('heading', { name: /Current Room/i })).toBeVisible();
  const roomCode = (await host.locator('.room-code-copy strong').innerText()).trim();
  expect(roomCode).toMatch(/^\d{5}$/);

  for (let index = 1; index < players.length; index += 1) {
    const player = players[index];
    await player.page.goto(`/?devSession=${runId}-p${index + 1}&step=join&code=${roomCode}`);
    await player.page.getByLabel(/Your nickname/i).fill(player.name);
    await player.page.getByRole('button', { name: /^Join Room$/i }).click();
    await expect(player.page.getByRole('heading', { name: /Current Room/i })).toBeVisible();
  }

  return { context, host, players, roomCode };
}

async function revealRoles(players: PlayerSession[]): Promise<void> {
  for (const player of players) {
    const revealButton = player.page.getByRole('button', { name: /Reveal .* hidden role/i });
    if (await revealButton.isVisible()) await revealButton.click();
    const roleText = (await player.page.locator('.live-player-phone .phone-role .role-face strong').innerText()).trim();
    player.role = asRole(roleText);
  }
}

async function playThreeSuccessfulGoodQuests(players: PlayerSession[]): Promise<void> {
  const goodPlayers = players.filter((player) => player.role && roleAllegiance(player.role) === 'good');
  expect(goodPlayers.length, 'expected enough good players to pass the first three quests').toBeGreaterThanOrEqual(3);

  for (let roundIndex = 0; roundIndex < 3; roundIndex += 1) {
    const team = goodPlayers.slice(0, getTeamSize(players.length, roundIndex));
    await playApprovedMission(players, team, () => 'success');
  }
}

async function playApprovedMission(
  players: PlayerSession[],
  team: PlayerSession[],
  cardFor: (player: PlayerSession) => MissionCard,
): Promise<void> {
  await proposeTeam(players, team);
  await submitVotes(players, () => 'approve');
  await submitMissionCards(team, cardFor);
}

async function proposeTeam(players: PlayerSession[], team: PlayerSession[]): Promise<PlayerSession> {
  const leader = await findLeader(players);
  const action = leader.page.locator('.live-player-phone .phone-action');
  for (const player of team) {
    await action.getByLabel(player.name, { exact: true }).check();
  }
  await action.getByRole('button', { name: /^Propose Team$/i }).click();
  await expect(leader.page.getByText(/Team vote/i)).toBeVisible();
  return leader;
}

async function findLeader(players: PlayerSession[]): Promise<PlayerSession> {
  for (const player of players) {
    const proposeButton = player.page.locator('.live-player-phone .phone-action').getByRole('button', { name: /^Propose Team$/i });
    if (await proposeButton.isVisible()) return player;
  }
  throw new Error('No page has the live leader proposal button.');
}

async function submitVotes(players: PlayerSession[], voteFor: (player: PlayerSession, index: number) => Vote): Promise<void> {
  for (const [index, player] of players.entries()) {
    await expect(player.page.getByText(/Team vote/i)).toBeVisible();
    await player.page.getByRole('button', { name: voteFor(player, index) === 'approve' ? /^Approve$/i : /^Reject$/i }).click();
  }
}

async function submitMissionCards(
  team: PlayerSession[],
  cardFor: (player: PlayerSession, index: number) => MissionCard,
): Promise<void> {
  for (const [index, player] of team.entries()) {
    const card = cardFor(player, index);
    await expect(player.page.locator('.live-player-phone .phone-action').getByText(/Mission card/i)).toBeVisible();
    const button = player.page.getByRole('button', { name: card === 'success' ? /^Success$/i : /^Fail$/i });
    await expect(button).toBeEnabled();
    await button.click();
  }
}

async function assassinate(assassin: PlayerSession, target: PlayerSession): Promise<void> {
  const panel = assassin.page.locator('.assassin-action-panel');
  await expect(panel.getByRole('heading', { name: /Choose Merlin/i })).toBeVisible();
  await panel.getByLabel(target.name, { exact: true }).check();
  await panel.getByRole('button', { name: /Confirm Assassination/i }).click();
}

function selectTeamIncluding(players: PlayerSession[], requiredPlayer: PlayerSession, teamSize: number): PlayerSession[] {
  return [requiredPlayer, ...players.filter((player) => player !== requiredPlayer)].slice(0, teamSize);
}

function requirePlayerWithRole(players: PlayerSession[], role: Role): PlayerSession {
  const player = players.find((candidate) => candidate.role === role);
  if (!player) throw new Error(`Expected a player with role ${role}.`);
  return player;
}

function asRole(value: string): Role {
  const roles: Role[] = ['Merlin', 'Assassin', 'Loyal Servant', 'Minion', 'Percival', 'Morgana', 'Mordred', 'Oberon'];
  const role = roles.find((candidate) => candidate === value);
  if (!role) throw new Error(`Unexpected role text: ${value}`);
  return role;
}
