import { test, expect } from '@playwright/test';

test('home page shows Veiled Roundtable entry actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Host the round/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Join by rune/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /AI fill-ins for short tables/i })).toBeVisible();
  await expect(page.getByAltText(/Phones around a candlelit Avalon round table/i)).toBeVisible();
});
