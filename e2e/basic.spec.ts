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
  await page.getByRole('button', { name: /Start demo/i }).click();
  const setupSummary = page.getByLabel(/Demo table setup/i);
  await expect(setupSummary.getByText('Demo roundtable', { exact: true })).toBeVisible();
  await expect(setupSummary.getByText(/Watch 7 AI players/i)).toBeVisible();
  await expect(page.getByText(/AI Orchestrator/i)).toBeVisible();
  const autoAdvanceSwitch = page.getByRole('switch', { name: /Auto-advance AI actions/i });
  await expect(autoAdvanceSwitch).toBeVisible();
  await expect(autoAdvanceSwitch).toBeChecked();
  await autoAdvanceSwitch.click();
  await expect(autoAdvanceSwitch).not.toBeChecked();
  await expect(page.getByLabel(/Pause after each AI quest/i)).toBeVisible();

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
  await page.getByLabel(/Pause after each AI quest/i).check();

  await expect(page.getByRole('dialog', { name: /Review this round/i })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Quest result is public\. Review the table history/i)).toBeVisible();
  await expect(page.getByText(/Quest: 1 needs/i)).toBeVisible();

  await page.getByRole('button', { name: /Enter next round/i }).click();
  await expect(page.getByRole('dialog', { name: /Review this round/i })).toHaveCount(0);
  await expect(page.getByText(/Quest: 2 needs/i)).toBeVisible();
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
