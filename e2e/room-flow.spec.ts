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
      await expect(page.locator('.room-header .room-quest')).toHaveCount(5);
      await expect(page.locator('.room-action-card')).toBeVisible();
    }

    await expect(host.locator('.room-table-card .role-lineup')).toBeVisible();
    await expect(host.getByRole('dialog', { name: 'More' })).toHaveCount(0);
    await expect(host.getByRole('button', { name: 'Submit Backup Proposal' })).toHaveCount(0);
    await host.locator('.room-header').getByRole('button', { name: 'More' }).click();
    await expect(host.getByRole('dialog', { name: 'More' }).getByText('Recovery controls')).toBeVisible();
    await host.keyboard.press('Escape');
    await expect(host.getByRole('dialog', { name: 'More' })).toHaveCount(0);
    await expect(players[1].page.getByRole('button', { name: 'Submit Backup Proposal' })).toHaveCount(0);

    const team = players.slice(0, 2);
    await proposeTeam(players, team);
    await submitVotes(players, () => 'approve');

    const offTeam = players[2].page.locator('.room-action-card');
    await expect(offTeam.getByRole('heading', { name: 'Waiting for the team to play their cards' })).toBeVisible();
    await submitMissionCards(team, () => 'success');

    await expect(host.locator('.room-header .room-quest').first()).toHaveClass(/success/);
    await expect(host.locator('.room-header .room-score')).toContainText('Good 1');
    await expect(host.locator('.quest-record li').first()).toContainText('Success');
    await expectCurrentQuest(host, 2);
  });
});

test('on a phone, the step a player acts on sits in the first screen and the top bar stays pinned', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ players }) => {
    for (const player of players) await player.page.setViewportSize({ width: 390, height: 844 });
    const leader = await findLeader(players);
    await expectInFirstScreen(leader.page.locator('.room-action-card').getByRole('button', { name: /^Propose Team$/i }));

    await proposeTeam(players, players.slice(0, 2));
    for (const player of players) {
      await expectInFirstScreen(player.page.locator('.room-action-card').getByRole('button', { name: /^Approve$/i }));
    }

    const page = players[0].page;
    await page.mouse.wheel(0, 1200);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    const compactBar = page.locator('.room-compact-bar.shown');
    await expect(compactBar).toBeVisible();
    await expect.poll(async () => (await compactBar.boundingBox())?.y).toBeLessThanOrEqual(1);
    await expect(compactBar.locator('.room-compact-summary')).toHaveAttribute('aria-label', /^Score: Good 0, Evil 0, Quest 1 · proposal 1\/5\. Back to top$/);
    await compactBar.locator('.room-compact-summary').click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator('.room-compact-bar.shown')).toHaveCount(0);
  });
});

test('the host confirms seats only after every seat is taken', async ({ browser }) => {
  const context = await browser.newContext();
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const pages = await Promise.all(Array.from({ length: 5 }, () => context.newPage()));
    const host = pages[0];
    await host.goto(`/?devSession=${runId}-p1`);
    await host.getByRole('button', { name: /Host the round/i }).click();
    await host.getByLabel(/Your nickname/i).fill('E2E P1');
    await host.getByRole('button', { name: /^Create Room$/i }).click();
    const roomCode = (await host.locator('.room-code-copy strong').innerText()).trim();

    for (let index = 1; index < 4; index += 1) await joinRoomPage(pages[index], runId, index, roomCode);
    await expect(host.locator('.room-action-card').getByRole('heading', { name: 'Invite players to the table' })).toBeVisible();
    await expect(host.getByRole('button', { name: /^Confirm seats and ready$/i })).toHaveCount(0);
    await expect(host.locator('.room-action-card')).toContainText('1 more to join.');

    await joinRoomPage(pages[4], runId, 4, roomCode);
    const card = host.locator('.room-action-card');
    await expect(card.getByRole('heading', { name: 'Check the seats, then get ready' })).toBeVisible();
    await expect(card.locator('.round-table-seat:not(.empty)')).toHaveCount(5);
    await expect(card.getByRole('button', { name: /^Confirm seats and ready$/i })).toBeVisible();
    await expect(host.locator('.room-table-card')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the quest track marks the official fail threshold for each quest', async ({ browser }) => {
  await withStartedRoom(browser, 7, async ({ host, players }) => {
    const fourthQuest = host.locator('.room-header .room-quest').nth(3);
    await expect(fourthQuest.locator('em')).toHaveText('Needs 2 Fail cards');
    await expect(fourthQuest).toHaveAttribute('aria-label', /2 Fail cards to fail/);
    await expect(host.locator('.room-header .room-quest').first().locator('em')).toHaveText('In progress');
    await expect(host.locator('.room-leader-row')).toContainText('Proposal 1 of 5');
    const leader = await findLeader(players);
    await expect(leader.page.locator('.room-action-card .room-action-rule')).toContainText('1 Fail card to fail');
  });
});

test('five-player Good reaches three successful quests, Assassin hits Merlin, and Evil wins', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ host, players }) => {
    await revealRoles(players);
    await playThreeSuccessfulGoodQuests(players);

    const assassin = requirePlayerWithRole(players, 'Assassin');
    const merlin = requirePlayerWithRole(players, 'Merlin');
    await expect(assassin.page.getByRole('heading', { name: /You are the Assassin: find Merlin/i })).toBeVisible();
    await expect(merlin.page.getByRole('heading', { name: /The Assassin is choosing Merlin/i })).toBeVisible();

    await assassinate(assassin, merlin);

    await expect(assassin.page.locator('.game-result-overlay')).toContainText('You won this game');
    await expect(assassin.page.locator('.game-result-overlay')).toHaveCount(0, { timeout: 5000 });
    await expect(assassin.page.locator('.room-action-card h2')).toHaveText('Evil wins · You won');
    await expect(merlin.page.locator('.room-action-card h2')).toHaveText('Evil wins · You lost');
    await expect(host.locator('.room-action-card')).toContainText(`The Assassin ${assassin.name} chose ${merlin.name}.`);
    await expect(host.locator('.room-table-card .round-table-seat .seat-role')).toHaveCount(players.length);
    const merlinSeat = host.locator('.room-table-card .round-table-seat').filter({ hasText: merlin.name });
    await expect(merlinSeat.locator('.seat-role')).toHaveText('Merlin');
    await expect(merlinSeat.locator('.seat-tag')).toBeVisible();
    await expect(host.locator('.room-table-card .seat-tag')).toHaveCount(1);

    for (const player of players.slice(0, -1)) {
      await player.page.locator('.room-action-card').getByRole('button', { name: /^Play Again$/i }).click();
    }

    await expect(host.getByRole('heading', { name: /Room history/i })).toBeVisible();
    await expect(host.getByText(/Game 1: Evil won/i)).toBeVisible();
    const assassinationHistoryReason = host.locator('.game-history-end-reason.prominent').filter({ hasText: /Assassin found Merlin/i });
    await expect(assassinationHistoryReason).toBeVisible();
    const assassinationReasonFontSize = await assassinationHistoryReason.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    expect(assassinationReasonFontSize).toBeGreaterThan(17);
    await expect(merlin.page.getByText(/You were Good · Merlin · Defeat/i)).toBeVisible();

    await players.at(-1)!.page.locator('.room-action-card').getByRole('button', { name: /^Play Again$/i }).click();
    for (const player of players) {
      await expect(player.page.getByRole('heading', { name: /Game Progress/i })).toBeAttached();
    }
    await expect(host.getByRole('heading', { name: /Room history/i })).toHaveCount(0);
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

    await expect(host.locator('.room-action-card h2')).toContainText('Good wins');
    await expect(host.locator('.room-action-card')).toContainText(`The Assassin ${assassin.name} chose ${nonMerlinGood!.name}.`);
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

    await expect(host.locator('.room-action-card h2')).toHaveText(/^Evil wins · You (won|lost)$/);
    await expect(host.locator('.room-header .room-quest.fail')).toHaveCount(3);
    await expect(host.getByText(/Game 1: Evil won/i)).toBeVisible();

    // The result stays readable after someone leaves the finished table.
    const leaver = players[4];
    leaver.page.on('dialog', (dialog) => dialog.accept());
    await leaver.page.locator('.room-header').getByRole('button', { name: 'More' }).click();
    await leaver.page.getByRole('button', { name: /^Leave Room$/i }).click();
    await expect(host.locator('.room-table-departed')).toContainText(leaver.name);
    await expect(host.locator('.room-table-card .round-table-seat .seat-role')).toHaveCount(4);
    await expect(host.locator('.room-action-card h2')).toHaveText(/^Evil wins · You (won|lost)$/);
    await expect(host.locator('.room-header .room-quest')).toHaveCount(5);
    await expect(host.locator('.room-action-card')).toContainText('Someone has left');
    await expect(host.getByText(/Three failed quests/i).first()).toBeVisible();
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

    await expect(host.locator('.room-header .room-quest').first()).toHaveClass(/success/);
    await expectCurrentQuest(host, 2);
  });
});

test('five rejected proposals in one quest hand Evil the game, with a warning before the last vote', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ host, players }) => {
    for (let proposal = 1; proposal <= 4; proposal += 1) {
      await expect(host.locator('.room-leader-row')).toContainText(`Proposal ${proposal} of 5`);
      await expect(host.locator('.room-action-card .final-proposal-warning')).toHaveCount(0);
      await proposeTeam(players, players.slice(0, 2));
      await submitVotes(players, () => 'reject');
    }

    await expect(host.locator('.room-leader-row')).toContainText('Proposal 5 of 5');
    await expect(host.locator('.room-vote-track.final')).toBeVisible();
    await expect(host.locator('.room-action-card .final-proposal-warning')).toContainText(/if this crew is rejected, Evil wins/i);
    await proposeTeam(players, players.slice(0, 2));
    for (const player of players) {
      await expect(player.page.locator('.room-action-card .final-proposal-warning')).toBeVisible();
    }
    await submitVotes(players, () => 'reject');

    await expect(host.locator('.room-action-card h2')).toHaveText(/^Evil wins · You (won|lost)$/);
    await expect(host.locator('.room-action-card')).toContainText(/five crew proposals in a row were rejected/i);
    await expect(host.getByText(/Game 1: Evil won/i)).toBeVisible();
    await expect(host.getByText(/Five proposals rejected/i).first()).toBeVisible();
  });
});

test('lobby room controls are scoped to host and guests', async ({ browser }) => {
  const room = await createLobbyRoom(browser, 5);
  try {
    const { host, players } = room;
    const guest = players[1].page;
    await players[1].page.getByRole('button', { name: /^(Set Ready|Confirm seats and ready)$/i }).click();

    await expect(host.getByRole('button', { name: /^Leave Room$/i })).toBeHidden();
    await host.locator('.room-header').getByRole('button', { name: 'More' }).click();
    await expect(host.getByRole('button', { name: /^Leave Room$/i })).toBeVisible();
    await expect(host.getByRole('button', { name: /^Dissolve Room$/i })).toBeVisible();
    await expect(host.getByRole('button', { name: /^Start Game$/i })).toHaveCount(0);
    const hostDangerActionHeight = await host.locator('.compact-danger-zone').evaluate((node) => node.getBoundingClientRect().height);
    expect(hostDangerActionHeight).toBeLessThan(90);
    await expect(host.getByRole('button', { name: 'Close' })).toBeFocused();
    for (let step = 0; step < 3; step += 1) {
      await host.keyboard.press('Shift+Tab');
      expect(await host.evaluate(() => Boolean(document.activeElement?.closest('.room-sheet')))).toBe(true);
    }
    await host.keyboard.press('Escape');
    await expect(host.locator('.room-header').getByRole('button', { name: 'More' })).toBeFocused();
    await host.locator('.room-header').getByRole('button', { name: 'More' }).click();
    await host.getByRole('button', { name: 'Close' }).click();
    await expect(host.getByRole('dialog', { name: 'More' })).toHaveCount(0);
    await host.locator('.room-header').getByRole('button', { name: 'More' }).click();
    await host.locator('.room-sheet-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(host.getByRole('button', { name: /^Leave Room$/i })).toBeHidden();

    await guest.locator('.room-header').getByRole('button', { name: 'More' }).click();
    await expect(guest.getByRole('button', { name: /^Leave Room$/i })).toBeVisible();
    await expect(guest.getByRole('button', { name: /^Dissolve Room$/i })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: /^Start Game$/i })).toHaveCount(0);
    await expect(guest.getByText(/The game starts automatically when everyone is ready/i)).toBeVisible();
  } finally {
    await room.context.close();
  }
});

test('the host swaps seats by tapping two seats or dragging one onto another, and both animate', async ({ browser }) => {
  const room = await createLobbyRoom(browser, 5);
  try {
    const { host } = room;
    const table = host.locator('.room-action-card .round-table');
    const seatButton = (name: string) => table.getByRole('button', { name: new RegExp(`: ${name} `) });
    const seatNumber = async (name: string) => (await seatButton(name).getAttribute('aria-label'))?.match(/Seat (\d+)/)?.[1];
    const swappingSeats = () => host.evaluate(() => document.querySelectorAll('.round-table-seat.swapping').length);

    await expect(host.locator('.round-table-caption')).toHaveText('Tap two players, or drag one onto another, to swap seats.');
    await seatButton('E2E P2').click();
    await seatButton('E2E P4').click();
    expect(await swappingSeats()).toBe(2);
    await expect.poll(() => seatNumber('E2E P2')).toBe('4');
    await expect.poll(() => seatNumber('E2E P4')).toBe('2');
    await expect.poll(swappingSeats).toBe(0);

    const from = await seatButton('E2E P3').locator('.seat-avatar').boundingBox();
    const to = await seatButton('E2E P5').locator('.seat-avatar').boundingBox();
    await host.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await host.mouse.down();
    await host.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
    await expect(table.locator('.round-table-seat.drop-target')).toHaveCount(1);
    await host.mouse.up();
    expect(await swappingSeats()).toBe(2);
    await expect.poll(() => seatNumber('E2E P3')).toBe('5');
    await expect.poll(() => seatNumber('E2E P5')).toBe('3');

    // A drag that ends away from any seat puts the player back.
    await expect.poll(swappingSeats).toBe(0);
    const stray = await seatButton('E2E P2').locator('.seat-avatar').boundingBox();
    await host.mouse.move(stray!.x + stray!.width / 2, stray!.y + stray!.height / 2);
    await host.mouse.down();
    await host.mouse.move(stray!.x + stray!.width / 2, stray!.y - 140, { steps: 8 });
    await host.mouse.up();
    await expect.poll(() => seatNumber('E2E P2')).toBe('4');
    await expect(table.locator('.round-table-seat.selected')).toHaveCount(0);

    // Swapping the host's own seat: the host visibly moves over first, then the
    // table turns so the host is back at the bottom of their own view.
    const hostSeat = table.locator('.round-table-seat.me');
    const start = await hostSeat.boundingBox();
    await seatButton('E2E P1').click();
    await seatButton('E2E P3').click();
    expect(await swappingSeats()).toBe(2);
    await host.waitForTimeout(350);
    const midway = await hostSeat.boundingBox();
    expect(Math.hypot(midway!.x - start!.x, midway!.y - start!.y)).toBeGreaterThan(40);
    await expect.poll(swappingSeats).toBe(0);
    await expect.poll(async () => Math.abs((await hostSeat.boundingBox())!.y - start!.y)).toBeLessThan(2);
    await expect.poll(() => seatNumber('E2E P1')).toBe('5');
    await expect.poll(() => seatNumber('E2E P3')).toBe('1');
  } finally {
    await room.context.close();
  }
});

test('private reveal swipe area shows each side only while held or dragged', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ players }) => {
    const swipeArea = players[0].page.locator('.identity-card .phone-private-swipe');
    const roleFace = players[0].page.locator('.identity-card .phone-role .role-face');
    const nightInfoFace = players[0].page.locator('.identity-card .phone-night-info .night-info-face');
    const rolePanel = players[0].page.locator('.identity-card .private-swipe-left');
    const nightInfoPanel = players[0].page.locator('.identity-card .private-swipe-right');
    const slider = players[0].page.locator('.identity-card .private-swipe-slider');
    const neutralCover = players[0].page.locator('.identity-card .private-swipe-neutral');

    await expect(swipeArea).toHaveCount(1);
    await expect(players[0].page.getByRole('button', { name: /Reveal .* hidden role/i })).toBeVisible();
    await expect(players[0].page.getByRole('button', { name: /Reveal .* hidden night information/i })).toBeVisible();
    await expect(roleFace).toHaveCSS('visibility', 'visible');
    await expect(nightInfoFace).toHaveCSS('visibility', 'visible');
    await expect(rolePanel).toHaveCSS('opacity', '1');
    await expect(nightInfoPanel).toHaveCSS('opacity', '1');
    await expect(neutralCover).toHaveCSS('opacity', '1');

    await swipeArea.scrollIntoViewIfNeeded();
    const box = await swipeArea.boundingBox();
    const initialRoleBox = await rolePanel.boundingBox();
    const initialNightInfoBox = await nightInfoPanel.boundingBox();
    const initialSliderBox = await slider.boundingBox();
    expect(box).not.toBeNull();
    expect(initialRoleBox).not.toBeNull();
    expect(initialNightInfoBox).not.toBeNull();
    expect(initialSliderBox).not.toBeNull();
    if (!box || !initialRoleBox || !initialNightInfoBox || !initialSliderBox) return;

    const dragY = box.y + Math.min(16, box.height / 4);
    await players[0].page.mouse.move(box.x + box.width / 2, dragY);
    await players[0].page.mouse.down();
    await players[0].page.mouse.move(box.x + box.width * 0.88, dragY, { steps: 5 });
    await expect(slider).not.toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
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

    await players[0].page.mouse.move(box.x + box.width / 2, dragY);
    await players[0].page.mouse.down();
    await players[0].page.mouse.move(box.x + box.width * 0.12, dragY, { steps: 5 });
    await expect(slider).not.toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
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
    await expect(host.getByLabel(/Player count/i).getByRole('button', { name: '7' })).toHaveClass(/selected/);
    await expect(host.getByText('Good roles')).toBeVisible();
    await expect(host.locator('.create-role-list').filter({ hasText: 'Good roles' }).getByText('Percival')).toBeVisible();
    await expect(host.locator('.create-role-list').filter({ hasText: 'Evil roles' }).getByText('Morgana')).toBeVisible();
    await expect(host.locator('.create-role-list').filter({ hasText: 'Evil roles' }).getByText('Mordred')).toBeVisible();

    await expect(host.getByRole('button', { name: /^Morgana/i })).toBeHidden();
    await host.locator('.create-advanced > summary').click();
    await host.getByRole('button', { name: /^Morgana/i }).click();
    await expect(host.locator('.create-role-list').filter({ hasText: 'Evil roles' }).getByText('Morgana')).toHaveCount(0);
  });

  try {
    const { host, players } = room;
    for (const player of players) {
      const readyButton = player.page.getByRole('button', { name: /^(Set Ready|Confirm seats and ready)$/i });
      if (await readyButton.isVisible()) await readyButton.click();
    }

    await expect(host.getByRole('button', { name: /^Start Game$/i })).toHaveCount(0);
    await expect(host.getByRole('heading', { name: /Game Progress/i })).toBeVisible();
    await revealRoles(players);

    const roles = players.map((player) => player.role);
    expect(roles).toContain('Percival');
    expect(roles).toContain('Mordred');
    expect(roles).not.toContain('Morgana');
  } finally {
    await room.context.close();
  }
});

test('AI room created from advanced settings plays normally for guests joining by plain link and by code', async ({ browser }) => {
  const context = await browser.newContext();
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const host = await context.newPage();
  const linkGuest = await context.newPage();
  const codeGuest = await context.newPage();
  const players: PlayerSession[] = [
    { index: 0, name: 'E2E Human 1', page: host },
    { index: 1, name: 'E2E Human 2', page: linkGuest },
    { index: 2, name: 'E2E Human 3', page: codeGuest },
  ];

  try {
    await host.goto(`/?devSession=${runId}-p1`);
    await host.getByRole('button', { name: /Host the round/i }).click();
    await host.getByLabel(/Your nickname/i).fill(players[0].name);
    await host.locator('.create-advanced > summary').click();
    await host.getByLabel(/Fill empty seats with AI/i).check();
    await host.getByLabel(/Human player count/i).getByRole('button', { name: '3', exact: true }).click();
    await expect(host.getByText(/3 humans \+ 2 AI/i)).toBeVisible();
    await host.getByRole('button', { name: /^Create Room$/i }).click();

    await expect(host.locator('.room-action-card')).toBeVisible();
    await expect(host.locator('.round-table-seat').filter({ hasText: /AI Seat 1/i }).getByText(/^AI$/)).toBeVisible();
    const roomCode = (await host.locator('.room-code-copy strong').innerText()).trim();
    const joinLink = await host.getByLabel(/Join link/i).innerText();
    await expect(host.locator('.qr-code svg')).toBeVisible();
    await expect(host.locator('.qr-code img')).toHaveCount(0);
    expect(new URL(joinLink).pathname).toBe('/');
    expect(new URL(joinLink).search).toBe(`?step=join&code=${roomCode}`);

    // The shared link carries no devSession, so this tab gets its own default identity.
    await linkGuest.goto(joinLink);
    await expect(linkGuest.getByLabel(/5-digit room code/i)).toHaveValue(roomCode);
    await linkGuest.getByLabel(/Your nickname/i).fill(players[1].name);
    await linkGuest.getByRole('button', { name: /^Join Room$/i }).click();
    await expect(linkGuest.locator('.room-action-card')).toBeVisible();

    await codeGuest.goto(`/?devSession=${runId}-p3`);
    await codeGuest.getByRole('button', { name: /Join a room/i }).click();
    await codeGuest.getByLabel(/5-digit room code/i).fill(roomCode);
    await codeGuest.getByLabel(/Your nickname/i).fill(players[2].name);
    await codeGuest.getByRole('button', { name: /^Join Room$/i }).click();
    await expect(codeGuest.locator('.room-action-card')).toBeVisible();

    for (const guest of [linkGuest, codeGuest]) {
      await expect(guest.locator('.round-table-seat.ai')).toHaveCount(2);
      await expect(guest.locator('.ai-room-note')).toContainText(/3 humans \+ 2 AI/i);
      await expect(guest.locator('.ai-room-note')).not.toContainText(/keep it open/i);
    }

    for (const player of players) {
      await player.page.getByRole('button', { name: /^(Set Ready|Confirm seats and ready)$/i }).click();
    }

    for (const player of players) {
      await expect(player.page.locator('.room-header .room-quest-track')).toBeVisible();
    }

    await proposeTeam(players, players.slice(1, 3));
    await expect(host.locator('.room-action-card')).toContainText('Waiting for:');
    await submitVotes(players, () => 'approve');
    await submitMissionCards(players.slice(1, 3), () => 'success');

    for (const player of players) {
      await expectCurrentQuest(player.page, 2);
    }
    await expect(linkGuest.locator('.quest-record li')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('host releases a seat so a player can reclaim it from a new browser mid-game', async ({ browser }) => {
  await withStartedRoom(browser, 5, async ({ context, host, players, roomCode }) => {
    await revealRoles(players);
    const lost = players[2];
    const newBrowser = await context.newPage();
    const newSession = `reclaim-${Date.now().toString(36)}`;

    await newBrowser.goto(`/?devSession=${newSession}&step=join&code=${roomCode}`);
    await newBrowser.getByLabel(/Your nickname/i).fill(lost.name);
    await newBrowser.getByRole('button', { name: /^Join Room$/i }).click();
    await expect(newBrowser.getByText(/ask the host to release your seat/i)).toBeVisible();

    await host.locator('.room-header').getByRole('button', { name: 'More' }).click();
    const row = host.locator('.host-player-action-row').filter({ hasText: lost.name });
    await expect(row.getByRole('button', { name: /^Remove$/i })).toHaveCount(0);
    host.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: /^Release Seat$/i }).click();
    await expect(row.getByText(/Waiting to rejoin/i)).toBeVisible();
    await expect(host.getByText(new RegExp(`join room ${roomCode} again with the same nickname`, 'i'))).toBeVisible();

    await newBrowser.getByRole('button', { name: /^Join Room$/i }).click();
    await expect(newBrowser.getByRole('heading', { name: /My identity/i })).toBeVisible();
    const revealButton = newBrowser.getByRole('button', { name: /Reveal .* hidden role/i });
    if (await revealButton.isVisible()) await revealButton.click();
    const reclaimedRole = (await newBrowser.locator('.identity-card .phone-role .role-face strong').innerText()).trim();
    expect(reclaimedRole).toBe(lost.role);
    await expect(row.getByRole('button', { name: /^Release Seat$/i })).toBeVisible();
  });
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
    await expectCurrentQuest(evilPlayer!.page, 2);
  });
});

test('seven-player Lady of the Lake examines a player privately after the second quest', async ({ browser }) => {
  const room = await createStartedRoom(browser, 7, async (host) => {
    await host.locator('.create-advanced > summary').click();
    await host.getByLabel(/Use the Lady of the Lake/i).check();
  });
  const { host, players } = room;
  try {
    await revealRoles(players);
    await expect(host.locator('.lady-status')).toContainText('E2E P7');

    await playApprovedMission(players, players.slice(0, 2), () => 'success');
    await expectCurrentQuest(host, 2);
    await playApprovedMission(players, players.slice(0, 3), () => 'success');

    const holder = players[6];
    const target = players[2];
    const holderAction = holder.page.locator('.room-action-card');
    await expect(holderAction.getByText('Lady of the Lake', { exact: true })).toBeVisible();
    await expect(holderAction.getByRole('button', { name: holder.name, exact: true })).toHaveCount(0);
    await expect(players[1].page.locator('.room-action-card')).toContainText('E2E P7 is using the Lady of the Lake');
    await expect(players[0].page.locator('.room-action-card').getByRole('button')).toHaveCount(0);

    await holderAction.getByRole('button', { name: target.name, exact: true }).click();

    await expect(host.locator('.lady-status')).toContainText('E2E P7 → E2E P3');
    await expect(host.locator('.lady-status .team-roster-heading strong')).toHaveText(target.name);
    const allegiance = roleAllegiance(target.role!) === 'good' ? 'Good' : 'Evil';
    await expect(holder.page.locator('.lady-checks')).toContainText(`Lady of the Lake: ${target.name} · ${allegiance}`);
    await expect(players[1].page.locator('.lady-checks')).toHaveCount(0);
    await expect(findLeader(players)).resolves.toBeDefined();
  } finally {
    await room.context.close();
  }
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

async function createStartedRoom(browser: Browser, playerCount: number, configureHost?: (host: Page) => Promise<void>): Promise<StartedRoom> {
  const room = await createLobbyRoom(browser, playerCount, configureHost);
  const { host, players } = room;
  for (const player of players) {
    const readyButton = player.page.getByRole('button', { name: /^(Set Ready|Confirm seats and ready)$/i });
    if (await readyButton.isVisible()) await readyButton.click();
  }

  await expect(host.getByRole('button', { name: /^Start Game$/i })).toHaveCount(0);

  for (const player of players) {
    await expect(player.page.getByRole('heading', { name: /Game Progress/i })).toBeAttached();
    await expect(player.page.getByRole('heading', { name: /My identity/i })).toBeVisible();
    await expect(player.page.locator('.room-header .room-quest-track')).toBeVisible();
    await expect(player.page.locator('.game-start-backdrop')).toHaveCount(0);
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
  await host.getByLabel(/Player count/i).getByRole('button', { name: String(playerCount), exact: true }).click();
  await configureHost?.(host);
  await host.getByRole('button', { name: /^Create Room$/i }).click();
  await expect(host.locator('.room-action-card')).toBeVisible();
  const roomCode = (await host.locator('.room-code-copy strong').innerText()).trim();
  expect(roomCode).toMatch(/^\d{5}$/);

  for (let index = 1; index < players.length; index += 1) {
    await joinRoomPage(players[index].page, runId, index, roomCode);
  }

  return { context, host, players, roomCode };
}

async function joinRoomPage(page: Page, runId: string, index: number, roomCode: string): Promise<void> {
  await page.goto(`/?devSession=${runId}-p${index + 1}&step=join&code=${roomCode}`);
  await page.getByLabel(/5-digit room code/i).fill(roomCode);
  await page.getByLabel(/Your nickname/i).fill(`E2E P${index + 1}`);
  await page.getByRole('button', { name: /^Join Room$/i }).click();
  await expect(page.locator('.room-action-card')).toBeVisible();
}

async function expectCurrentQuest(page: Page, quest: number): Promise<void> {
  await expect(page.locator('.room-header .room-quest').nth(quest - 1)).toHaveClass(/current/);
}

async function expectInFirstScreen(locator: ReturnType<Page['locator']>): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, 'expected the control to have a layout box').not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
}

async function revealRoles(players: PlayerSession[]): Promise<void> {
  for (const player of players) {
    const revealButton = player.page.getByRole('button', { name: /Reveal .* hidden role/i });
    if (await revealButton.isVisible()) await revealButton.click();
    const roleText = (await player.page.locator('.identity-card .phone-role .role-face strong').innerText()).trim();
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
  const action = leader.page.locator('.room-action-card');
  for (const player of team) {
    await action.getByLabel(player.name, { exact: true }).check();
  }
  await action.getByRole('button', { name: /^Propose Team$/i }).click();
  await expect(action.getByRole('heading', { name: 'Vote on this team' })).toBeVisible();
  return leader;
}

async function findLeader(players: PlayerSession[]): Promise<PlayerSession> {
  for (const player of players) {
    const proposeButton = player.page.locator('.room-action-card').getByRole('button', { name: /^Propose Team$/i });
    if (await proposeButton.isVisible()) return player;
  }
  throw new Error('No page has the live leader proposal button.');
}

async function submitVotes(players: PlayerSession[], voteFor: (player: PlayerSession, index: number) => Vote): Promise<void> {
  for (const [index, player] of players.entries()) {
    const action = player.page.locator('.room-action-card');
    await expect(action.getByRole('heading', { name: 'Vote on this team' })).toBeVisible();
    await action.getByRole('button', { name: voteFor(player, index) === 'approve' ? /^Approve$/i : /^Reject$/i }).click();
  }
}

async function submitMissionCards(
  team: PlayerSession[],
  cardFor: (player: PlayerSession, index: number) => MissionCard,
): Promise<void> {
  for (const [index, player] of team.entries()) {
    const card = cardFor(player, index);
    const action = player.page.locator('.room-action-card');
    await expect(action.getByRole('heading', { name: 'You are on the team: play a mission card' })).toBeVisible();
    const button = action.getByRole('button', { name: card === 'success' ? /^Success$/i : /^Fail$/i });
    await expect(button).toBeEnabled();
    await button.click();
  }
}

async function assassinate(assassin: PlayerSession, target: PlayerSession): Promise<void> {
  const panel = assassin.page.locator('.room-action-card');
  await expect(panel.getByRole('heading', { name: /You are the Assassin: find Merlin/i })).toBeVisible();
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
