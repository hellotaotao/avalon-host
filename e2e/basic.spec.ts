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
  await expect(page.getByLabel(/Manual seats/i).getByRole('button', { name: '7' })).toHaveClass(/selected/);

  await page.getByLabel(/Manual seats/i).getByRole('button', { name: '0' }).click();
  await expect(page.getByText(/Watch 7 AI players/i)).toBeVisible();
  await page.getByRole('button', { name: /Start demo/i }).click();
  const setupSummary = page.getByLabel(/Demo table setup/i);
  await expect(setupSummary.getByText('Demo roundtable', { exact: true })).toBeVisible();
  await expect(setupSummary.getByText(/Watch 7 AI players/i)).toBeVisible();
  await expect(page.getByText(/AI Orchestrator/i)).toBeVisible();
});
