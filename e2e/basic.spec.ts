import { test, expect } from '@playwright/test';

test('home page shows Avalon entry actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Host the round/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Join by rune/i })).toBeVisible();
});
