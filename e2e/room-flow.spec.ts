import { expect, test, type BrowserContext, type Page } from '@playwright/test';

test('live UI creates a room, joins five players, starts, proposes, votes, and submits mission cards', async ({ browser }) => {
  const context = await browser.newContext();
  const pages: Page[] = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      pages.push(await context.newPage());
    }

    const host = pages[0];
    await host.goto('/?devSession=p1');
    await host.getByRole('button', { name: /Host the round/i }).click();
    await host.getByLabel(/Your nickname/i).fill('Tao P1');
    await host.getByRole('button', { name: /^Create Room$/i }).click();
    await expect(host.getByRole('heading', { name: /Current Room/i })).toBeVisible();
    const roomCode = (await host.locator('.room-code-copy strong').innerText()).trim();
    expect(roomCode).toMatch(/^\d{5}$/);

    for (let index = 1; index < pages.length; index += 1) {
      const page = pages[index];
      await page.goto(`/?devSession=p${index + 1}&step=join&code=${roomCode}`);
      await page.getByLabel(/Your nickname/i).fill(`Tao P${index + 1}`);
      await page.getByRole('button', { name: /^Join Room$/i }).click();
      await expect(page.getByRole('heading', { name: /Current Room/i })).toBeVisible();
    }

    for (const page of pages) {
      const readyButton = page.getByRole('button', { name: /^Set Ready$/i });
      if (await readyButton.isVisible()) await readyButton.click();
    }

    await expect(host.getByRole('button', { name: /^Start Game$/i })).toBeEnabled();
    await host.getByRole('button', { name: /^Start Game$/i }).click();

    for (const page of pages) {
      await expect(page.getByText(/Table Quest/i)).toBeVisible();
    }

    const leader = await findPageWithButton(pages, /^Propose Team$/i);
    const leaderChecks = leader.locator('.phone-action input[type="checkbox"]');
    await leaderChecks.nth(0).check();
    await leaderChecks.nth(1).check();
    await leader.getByRole('button', { name: /^Propose Team$/i }).click();

    for (const page of pages) {
      await expect(page.getByText(/Team vote/i)).toBeVisible();
      await page.getByRole('button', { name: /^Approve$/i }).click();
    }

    await expect(host.getByText('Mission card', { exact: true }).first().or(host.getByText('Mission', { exact: true }).first())).toBeVisible();
    const missionActors = await findPagesWithVisibleButton(pages, /^Success$/i);
    expect(missionActors).toHaveLength(2);
    for (const page of missionActors) {
      await page.getByRole('button', { name: /^Success$/i }).click();
    }

    await expect(host.getByText(/Good won/i)).toBeVisible();
    await expect(host.getByText('Quest 2 of 5')).toBeVisible();
  } finally {
    await context.close();
  }
});

async function findPageWithButton(pages: Page[], name: RegExp): Promise<Page> {
  for (const page of pages) {
    const button = page.getByRole('button', { name });
    if (await button.isVisible()) return page;
  }
  throw new Error(`No page has visible button ${name}`);
}

async function findPagesWithVisibleButton(pages: Page[], name: RegExp): Promise<Page[]> {
  const matches: Page[] = [];
  for (const page of pages) {
    const button = page.getByRole('button', { name });
    if (await button.isVisible()) matches.push(page);
  }
  return matches;
}
