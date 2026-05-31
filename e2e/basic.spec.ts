import { test, expect } from '@playwright/test';

test('home page shows Veiled Roundtable entry actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Host the round/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Join by rune/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /AI fill-ins for short tables/i })).toBeVisible();
  await expect(page.getByAltText(/Phones around a candlelit Avalon round table/i)).toBeVisible();
});

test('demo setup uses table size and manual seats instead of separate modes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try demo/i }).click();

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
  await expect(progress).toHaveCSS('z-index', '30');

  const firstQuest = progress.locator('.quest-track span').first();
  await firstQuest.evaluate((node) => node.classList.add('fail'));
  const failMarkerContent = await firstQuest.evaluate((node) => getComputedStyle(node, '::after').content);
  expect(failMarkerContent).toBe('none');
});

test('pure AI demo can pause between quest rounds', async ({ page }) => {
  await page.route('**/api/ai-avalon', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { message: 'forced fallback' } }),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: /Try demo/i }).click();
  await page.getByLabel(/Table size/i).getByRole('button', { name: '5' }).click();
  await page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' }).click();
  await page.getByRole('button', { name: /Start demo/i }).click();
  await page.getByRole('switch', { name: /Pause after AI quests/i }).click();

  await expect(page.getByRole('dialog', { name: /Review this round/i })).toBeVisible({ timeout: 15000 });
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
  expect(copied).toContain('## Quest rounds');
  expect(copied).toContain('- Public table history:');
  expect(copied).toContain('- AI private reasoning:');
  expect(copied).toContain('Private reasoning');
  expect(copied).toContain('Belief update');
  expect(copied).toContain('- Belief before:');
  expect(copied).toContain('- Belief after:');
  expect(copied).toContain('## Structured audit events');
  expect(copied).toContain('"schema": "avalon-demo-audit.v1"');
  expect(copied).toContain('"formalActionPolicy"');
  expect(copied).toContain('"speechPolicy": "ignored_by_design"');
  expect(copied).toContain('"evidenceMode": "formal_actions_only"');
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
