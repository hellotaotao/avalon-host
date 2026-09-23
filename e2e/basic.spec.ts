import { test, expect } from '@playwright/test';

test('home page shows Veiled Roundtable entry actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Join a room/i })).toBeVisible();
  await expect(page.getByLabel(/5-digit room code/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Join Room$/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Host the round/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Join by rune/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Built for friends at the same table/i })).toBeVisible();
  await expect(page.getByText(/scan to join, and roles, votes, and scoring are handled for you/i)).toBeVisible();
  await expect(page.getByAltText(/Phones around a candlelit Avalon round table/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Try demo/i })).toHaveCount(0);
  await expect(page.getByText(/AI fill-ins|AI player/i)).toHaveCount(0);
  await expect(page.getByText(/Neon/i)).toHaveCount(0);
  await expect(page.locator('.runtime-footer').getByRole('button', { name: /Multi-phone simulator \(experimental\)/i })).toBeVisible();
});

test('home page copy is consistent in Chinese', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('avalon-host-language', 'zh'));
  await page.goto('/');
  await expect(page.getByText('朋友线下聚会，扫码开局，自动处理身份、投票和计分。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '为围坐一桌的朋友设计' })).toBeVisible();
  await expect(page.getByRole('button', { name: '多手机模拟器（实验）' })).toBeVisible();
  await expect(page.getByText(/AI 补位|Neon/)).toHaveCount(0);

  await page.locator('.home-join-form').getByLabel('5 位房号').fill('99999');
  await page.locator('.home-join-form').getByLabel('你的昵称').fill('路人');
  await page.locator('.home-join-form').getByRole('button', { name: '加入房间' }).click();
  await expect(page.getByText('找不到这个房间。')).toBeVisible();

  await page.locator('.create-room-action').click();
  await expect(page.getByRole('heading', { name: '创建房间' })).toBeVisible();
  await expect(page.getByLabel('玩家人数', { exact: true })).toBeVisible();
  await page.locator('.create-advanced > summary').click();
  await expect(page.getByText('AI 补位（实验）')).toBeVisible();
  await expect(page.getByLabel('用 AI 补齐空位')).not.toBeChecked();

  await page.getByLabel('你的昵称').fill('中文房主');
  await page.getByRole('button', { name: '创建房间', exact: true }).last().click();
  const joinLink = await page.getByLabel('加入链接').inputValue();
  expect(new URL(joinLink).pathname).toBe('/zh/');
  expect(new URL(joinLink).search).toMatch(/^\?step=join&code=\d{5}$/);
});

test('Chinese invitation links open in Chinese with Chinese page meta', async ({ page }) => {
  await page.goto('/zh/?step=join&code=12345');
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible();
  await expect(page.getByLabel('5 位房号')).toHaveValue('12345');
  await expect(page).toHaveTitle('迷雾圆桌 · 线下阿瓦隆助手');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page).toHaveTitle('Veiled Roundtable');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('home join layout stays compact on phone and full width on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const code = page.getByLabel(/5-digit room code/i);
  const nickname = page.getByLabel(/Your nickname/i);
  const joinButton = page.getByRole('button', { name: /^Join Room$/i });

  const phoneMetrics = await page.evaluate(() => {
    const codeInput = document.querySelector<HTMLInputElement>('.join-code-field input');
    const nicknameInput = document.querySelector<HTMLInputElement>('.join-name-field input');
    const join = document.querySelector<HTMLButtonElement>('.home-join-form button');
    if (!codeInput || !nicknameInput || !join) throw new Error('Missing home join controls');
    const codeRect = codeInput.getBoundingClientRect();
    const nicknameRect = nicknameInput.getBoundingClientRect();
    const joinRect = join.getBoundingClientRect();
    const codeStyle = getComputedStyle(codeInput);
    return {
      codeTop: Math.round(codeRect.top),
      nicknameTop: Math.round(nicknameRect.top),
      joinTop: Math.round(joinRect.top),
      codeRight: Math.round(codeRect.right),
      joinLeft: Math.round(joinRect.left),
      codeHeight: Math.round(codeRect.height),
      codeFont: codeStyle.fontFamily,
    };
  });

  await expect(code).toBeVisible();
  await expect(nickname).toBeVisible();
  await expect(joinButton).toBeVisible();
  expect(Math.abs(phoneMetrics.codeTop - phoneMetrics.joinTop)).toBeLessThanOrEqual(2);
  expect(phoneMetrics.nicknameTop).toBeGreaterThan(phoneMetrics.codeTop + 48);
  expect(phoneMetrics.joinLeft).toBeGreaterThan(phoneMetrics.codeRight);
  expect(phoneMetrics.codeHeight).toBeGreaterThanOrEqual(56);
  expect(phoneMetrics.codeFont).toContain('Georgia');

  await page.setViewportSize({ width: 1280, height: 720 });

  const desktopMetrics = await page.evaluate(() => {
    const form = document.querySelector<HTMLElement>('.home-join-form');
    const actions = document.querySelector<HTMLElement>('.secondary-entry-actions');
    if (!form || !actions) throw new Error('Missing home entry layout');
    const formRect = form.getBoundingClientRect();
    const actionRect = actions.getBoundingClientRect();
    return {
      leftGap: Math.abs(Math.round(actionRect.left - formRect.left)),
      widthRatio: actionRect.width / formRect.width,
    };
  });

  expect(desktopMetrics.leftGap).toBeLessThanOrEqual(2);
  expect(desktopMetrics.widthRatio).toBeGreaterThan(0.98);
});

test('default create form only asks for nickname and player count, and every count is all-human', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:5173')) externalRequests.push(request.url());
  });
  await page.goto('/?devSession=all-human-create');
  await page.getByRole('button', { name: /Host the round/i }).click();

  await expect(page.getByLabel(/Player count/i)).toBeVisible();
  await expect(page.getByLabel(/Human player count/i)).toHaveCount(0);
  await expect(page.locator('.create-advanced')).not.toHaveAttribute('open', '');
  await expect(page.getByText(/\d+ humans? \+ \d+ AI/i)).toHaveCount(0);

  for (const count of ['5', '6', '7', '8', '9', '10']) {
    await page.getByLabel(/Player count/i).getByRole('button', { name: count, exact: true }).click();
    await expect(page.getByText(/\d+ humans? \+ \d+ AI/i)).toHaveCount(0);
  }

  await page.getByLabel(/Your nickname/i).fill('Plain Host');
  await page.getByRole('button', { name: /^Create Room$/i }).click();
  await expect(page.getByRole('heading', { name: /Current Room/i })).toBeVisible();
  await expect(page.locator('.players li')).toHaveCount(1);
  await expect(page.locator('.players .ai-player-badge')).toHaveCount(0);
  await expect(page.locator('.ai-room-note')).toHaveCount(0);
  // The QR code is drawn in the page, so no third party sees the join link.
  await expect(page.locator('.qr-code svg')).toBeVisible();
  await expect(page.locator('.qr-code img')).toHaveCount(0);
  expect(externalRequests).toEqual([]);
  await expect(page.getByText(/9 more ready players needed/i)).toBeVisible();
});

test('turning AI fill back off creates an all-human room', async ({ page }) => {
  await page.goto('/?devSession=ai-toggle-off');
  await page.getByRole('button', { name: /Host the round/i }).click();
  await page.getByLabel(/Your nickname/i).fill('Changed Mind');
  await page.getByLabel(/Player count/i).getByRole('button', { name: '7', exact: true }).click();

  await page.locator('.create-advanced > summary').click();
  await page.getByLabel(/Fill empty seats with AI/i).check();
  await page.getByLabel(/Human player count/i).getByRole('button', { name: '2', exact: true }).click();
  await expect(page.getByText(/2 humans \+ 5 AI/i)).toBeVisible();

  await page.getByLabel(/Fill empty seats with AI/i).uncheck();
  await expect(page.getByLabel(/Human player count/i)).toHaveCount(0);
  await expect(page.getByText(/\d+ humans? \+ \d+ AI/i)).toHaveCount(0);
  await page.getByRole('button', { name: /^Create Room$/i }).click();

  await expect(page.getByRole('heading', { name: /Current Room/i })).toBeVisible();
  await expect(page.locator('.players li')).toHaveCount(1);
  await expect(page.locator('.players .ai-player-badge')).toHaveCount(0);
  await expect(page.getByText(/6 more ready players needed/i)).toBeVisible();
});

test('create room allows one human with AI fill seats from advanced settings', async ({ page }) => {
  await page.goto('/?devSession=one-human-create');
  await page.getByRole('button', { name: /Host the round/i }).click();

  await page.getByLabel(/Your nickname/i).fill('Solo Host');
  await page.locator('.create-advanced > summary').click();
  await page.getByLabel(/Fill empty seats with AI/i).check();
  await page.getByLabel(/Human player count/i).getByRole('button', { name: '1', exact: true }).click();
  await expect(page.getByText(/1 human \+ 4 AI/i)).toBeVisible();
  await page.locator('.create-advanced > summary').click();
  await expect(page.getByText(/1 human \+ 4 AI/i)).toBeVisible();
  await page.getByRole('button', { name: /^Create Room$/i }).click();

  await expect(page.getByRole('heading', { name: /Current Room/i })).toBeVisible();
  await expect(page.locator('.players li').filter({ hasText: /AI Seat 4/i }).getByText(/^AI$/)).toBeVisible();
  await expect(page.locator('.ai-room-note')).toContainText(/AI fill-ins \(experimental\) · 1 human \+ 4 AI/i);
  await expect(page.locator('.ai-room-note')).toContainText(/keep it open during the game/i);
  await expect(page.getByRole('button', { name: /^Start Game$/i })).toHaveCount(0);
  await page.getByRole('button', { name: /^Set Ready$/i }).click();
  await expect(page.getByRole('status').getByText(/Everyone is ready/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Game Progress/i })).toBeVisible();
});

test('create room defers the nickname error until submit and still blocks empty names', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Host the round/i }).click();

  const nickname = page.getByLabel(/Your nickname/i);
  const createButton = page.getByRole('button', { name: /^Create Room$/i });
  await expect(page.getByText(/Enter a nickname before creating the room/i)).toHaveCount(0);
  await expect(nickname).toHaveAttribute('aria-invalid', 'false');

  await createButton.click();
  await expect(page.getByText(/Enter a nickname before creating the room/i)).toBeVisible();
  await expect(nickname).toHaveAttribute('aria-invalid', 'true');
  await expect(nickname).toBeFocused();

  await nickname.fill('Morgan');
  await expect(page.getByText(/Enter a nickname before creating the room/i)).toHaveCount(0);
  await expect(nickname).toHaveAttribute('aria-invalid', 'false');
});

test('demo setup uses table size and manual seats instead of separate modes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Multi-phone simulator/i }).click();

  await expect(page.getByRole('heading', { name: /Demo roundtable/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Manual phones/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^AI Table$/i })).toHaveCount(0);
  await expect(page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' })).toBeVisible();
  await expect(page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' })).toHaveClass(/selected/);

  await page.getByLabel(/Table size/i).getByRole('button', { name: '5' }).click();
  await expect(page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' })).toHaveClass(/selected/);
  await expect(page.getByText(/Watch 5 AI players/i)).toBeVisible();
  await page.getByLabel(/Table size/i).getByRole('button', { name: '7' }).click();
  await expect(page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' })).toHaveClass(/selected/);
  await expect(page.getByText(/Watch 7 AI players/i)).toBeVisible();

  const roleToggles = page.locator('.optional-roles .role-toggle');
  await expect(roleToggles).toHaveCount(4);
  const roleToggleRows = await roleToggles.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(roleToggleRows).size).toBe(1);

  await page.getByRole('button', { name: /Start demo/i }).click();
  const setupSummary = page.getByLabel(/Demo table setup/i);
  await expect(setupSummary.getByText('Demo roundtable', { exact: true })).toBeVisible();
  await expect(setupSummary.getByText(/Watch 7 AI players/i)).toBeVisible();
  await expect(page.getByText(/AI Orchestrator/i)).toBeVisible();
  await expect(page.getByText(/Q4: 4 \/ 2 fails/i)).toBeVisible();
  await expect(page.getByRole('switch', { name: /Auto-advance AI actions/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Run next AI action/i })).toHaveCount(0);
  await expect(page.getByText(/When enabled, pure AI demo pauses/i)).toHaveCount(0);
  const pauseAfterQuestSwitch = page.getByRole('switch', { name: /Pause after AI quests/i });
  await expect(pauseAfterQuestSwitch).toBeVisible();
  await expect(pauseAfterQuestSwitch).not.toBeChecked();
  await expect(page.getByText(/AI pauses after each quest result/i)).toBeVisible();
  await pauseAfterQuestSwitch.click();
  await expect(pauseAfterQuestSwitch).toBeChecked();

  const progress = page.locator('.demo-progress-sticky');
  await expect(progress).toHaveCSS('position', 'sticky');
  await expect(progress).toHaveCSS('z-index', '10');

  const firstQuest = progress.locator('.quest-track span').first();
  await firstQuest.evaluate((node) => node.classList.add('fail'));
  const failMarkerContent = await firstQuest.evaluate((node) => getComputedStyle(node, '::after').content);
  expect(failMarkerContent).toBe('none');
});

test('demo follows the same five-rejection rule as live rooms', async ({ page }) => {
  await page.goto('/?step=demo');
  await page.getByLabel(/Table size/i).getByRole('button', { name: '5', exact: true }).click();
  await page.getByLabel(/Manual seats/i).getByRole('button', { name: '5', exact: true }).click();
  await page.getByRole('button', { name: /Start demo/i }).click();

  const phones = page.locator('.demo-phone-grid .player-phone');
  for (let proposal = 1; proposal <= 5; proposal += 1) {
    await expect(page.getByText(`Proposal this quest ${proposal}/5`)).toBeVisible();
    await expect(page.locator('.demo-board .final-proposal-warning')).toHaveCount(proposal === 5 ? 1 : 0);
    const leaderAction = page.locator('.demo-phone-grid .player-phone.leader-phone .phone-action');
    const crewChoices = leaderAction.getByRole('checkbox');
    await crewChoices.nth(0).check();
    await crewChoices.nth(1).check();
    await leaderAction.getByRole('button', { name: /^Propose Team$/i }).click();
    await expect(phones.locator('.phone-action .final-proposal-warning')).toHaveCount(proposal === 5 ? 5 : 0);
    for (let seat = 0; seat < 5; seat += 1) {
      await phones.nth(seat).getByRole('button', { name: /^Reject$/i }).click();
    }
  }

  await expect(page.getByText(/Evil wins because five crew proposals in a row were rejected this quest/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Copy demo log/i })).toBeVisible();
});

test('pure AI demo can pause between quest rounds', async ({ page }) => {
  await page.route('**/api/ai-avalon', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { message: 'forced fallback' } }),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: /Multi-phone simulator/i }).click();
  await page.getByLabel(/Table size/i).getByRole('button', { name: '5' }).click();
  await page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' }).click();
  await page.getByRole('button', { name: /Start demo/i }).click();
  await page.getByRole('switch', { name: /Pause after AI quests/i }).click();

  await expect(page.getByRole('dialog', { name: /Review this round/i })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('dialog', { name: /Review this round/i })).toHaveCSS('z-index', '80');
  await expect(page.getByText(/Quest result is public\. Review the table history/i)).toBeVisible();
  await expect(page.getByText(/Quest: 1 needs/i)).toBeVisible();

  await page.getByRole('button', { name: /Enter next round/i }).click();
  await expect(page.getByRole('dialog', { name: /Review this round/i })).toHaveCount(0);
  await expect(page.getByText(/Quest: 2 needs/i)).toBeVisible();
});

test('finished AI demo can copy a complete analysis log', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5173' });
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
      nativeSetTimeout(handler, typeof timeout === 'number' && timeout > 20 ? 20 : timeout, ...args)
    )) as typeof window.setTimeout;
  });
  await page.route('**/api/ai-avalon', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { message: 'forced fallback' } }),
  }));

  await page.goto('/?step=demo');
  await page.getByLabel(/Table size/i).getByRole('button', { name: '5' }).click();
  await page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' }).click();
  await page.getByRole('button', { name: /Start demo/i }).click();

  const copyButton = page.getByRole('button', { name: /Copy demo log/i });
  await expect(copyButton).toBeVisible({ timeout: 20000 });
  await copyButton.click();
  await expect(page.getByText(/Demo log copied\./i)).toBeVisible();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('# Avalon demo log');
  expect(copied).toContain('## Players, identities, and role vision');
  expect(copied).toContain('- Controller: ai');
  expect(copied).toContain('- Role vision:');
  expect(copied).toContain('## AI belief profiles');
  expect(copied).toContain('- pEvil:');
  expect(copied).toContain('- Evidence for evil:');
  expect(copied).toContain('## Quest rounds');
  expect(copied).toContain('- Public table history:');
  expect(copied).toContain('- AI private reasoning:');
  expect(copied).toContain('Private reasoning');
  expect(copied).toContain('Belief update');
  expect(copied).toContain('- Belief before:');
  expect(copied).toContain('- Belief after:');
  expect(copied).toContain('## Structured audit events');
  expect(copied).toContain('"schema": "avalon-audit.v2"');
  expect(copied).toContain('"policy"');
  expect(copied).toContain('"beliefEvents"');
  expect(copied).toContain('"finalBeliefs"');
  expect(copied).toContain('"pEvil"');
  expect(copied).toContain('"ruleText"');
  expect(copied).not.toContain('"reasonDictionary"');
  expect(copied).not.toContain('"beliefProfiles"');
  expect(copied).not.toContain('"beliefProfilesBefore"');
  expect(copied).not.toContain('"beliefProfilesAfter"');
  expect(copied).toContain('"speech": "ui_only"');
  expect(copied).toContain('"evidence": "formal_actions_only"');
  expect(copied.length).toBeLessThan(240000);
});

test('demo phone result styling does not enlarge cards into neighbors', async ({ page }) => {
  await page.goto('/?step=demo');
  await page.getByLabel(/Table size/i).getByRole('button', { name: '5' }).click();
  await page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' }).click();
  await page.getByRole('button', { name: /Start demo/i }).click();

  const phones = page.locator('.demo-phone-grid .player-phone');
  await expect(phones).toHaveCount(5);
  await expect(phones.first()).toHaveClass(/leader-phone/);
  await expect(phones.first()).toHaveCSS('border-top-color', 'rgb(47, 140, 163)');
  await phones.first().evaluate((node) => node.classList.add('phone-winner'));
  await expect(phones.first()).toHaveCSS('border-top-color', 'rgb(233, 188, 72)');
  await phones.first().evaluate((node) => node.classList.remove('phone-winner'));

  await phones.evaluateAll((nodes) => {
    nodes.forEach((node, index) => {
      node.classList.add('mission-fail-phone');
      node.classList.add(index === 1 ? 'phone-loser' : 'phone-winner');
    });
  });
  await page.waitForTimeout(350);

  const layout = await phones.evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      transform: getComputedStyle(node).transform,
    };
  }));

  for (const card of layout) {
    expect(card.transform).toBe('none');
  }
  for (let index = 0; index < layout.length - 1; index += 1) {
    expect(layout[index].right).toBeLessThanOrEqual(layout[index + 1].left);
  }
});

test('demo phone internals do not overflow the phone frame', async ({ page }) => {
  await page.goto('/?step=demo');
  await page.getByLabel(/Table size/i).getByRole('button', { name: '5' }).click();
  await page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' }).click();
  await page.getByRole('button', { name: /Start demo/i }).click();

  const phones = page.locator('.demo-phone-grid .player-phone');
  await expect(phones).toHaveCount(5);

  const borsPhone = phones.nth(1);
  await borsPhone.locator('.agent-card p').first().evaluate((node) => {
    node.textContent = `公开发言：${'currentTeamRoleVisibleInfo'.repeat(4)}，Arthur AI supports Bors AI as a test team.`;
  });
  await borsPhone.locator('.phone-action p').first().evaluate((node) => {
    node.textContent = `任务队伍：Arthur AI, Bors AI, ${'veryLongUnbrokenPlayerName'.repeat(4)}`;
  });

  const swipeArea = borsPhone.locator('.phone-private-swipe');
  const swipeBox = await swipeArea.boundingBox();
  expect(swipeBox).not.toBeNull();
  if (!swipeBox) return;
  await page.mouse.move(swipeBox.x + swipeBox.width / 2, swipeBox.y + swipeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(swipeBox.x + swipeBox.width * 0.9, swipeBox.y + swipeBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(borsPhone.locator('.private-swipe-slider')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');

  const overflowIssues = await phones.evaluateAll((nodes) => nodes.flatMap((phone, phoneIndex) => {
    const phoneRect = phone.getBoundingClientRect();
    const visibleBlocks = [
      ...phone.querySelectorAll(':scope > .phone-top, :scope > .phone-private-swipe, :scope > .agent-card, :scope > .phone-action, .private-swipe-neutral'),
    ];
    return visibleBlocks.flatMap((block, blockIndex) => {
      const rect = block.getBoundingClientRect();
      const outsideFrame = rect.left < phoneRect.left - 1 || rect.right > phoneRect.right + 1;
      const scrollOverflow = !block.classList.contains('phone-private-swipe') && block.scrollWidth > block.clientWidth + 1;
      return outsideFrame || scrollOverflow
        ? [`phone ${phoneIndex} block ${blockIndex}: rect ${rect.left}-${rect.right}, frame ${phoneRect.left}-${phoneRect.right}, scroll ${block.scrollWidth}/${block.clientWidth}`]
        : [];
    });
  }));
  expect(overflowIssues).toEqual([]);
});
