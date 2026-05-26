import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import process from 'node:process';

const APP_URL = process.env.AVALON_DEMO_URL || 'http://127.0.0.1:5173';
const PLAYER_NAMES = ['Tao Host', 'Lisa', 'Matt', 'Alice', 'Bob'];
const args = new Set(process.argv.slice(2));
const headless = args.has('--headless');
const closeWhenDone = args.has('--close');
const slowMo = Number(process.env.AVALON_DEMO_SLOWMO_MS || (headless ? 0 : 350));

let devServer;

async function main() {
  await ensureServer();

  const browser = await chromium.launch({
    headless,
    slowMo,
    args: ['--window-size=1500,950'],
  });
  const context = await browser.newContext({
    viewport: { width: 430, height: 900 },
  });

  const runId = `demo-${Date.now().toString(36)}`;
  const players = [];
  for (let index = 0; index < PLAYER_NAMES.length; index += 1) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 430, height: 900 });
    players.push({ index, name: PLAYER_NAMES[index], page });
  }

  const host = players[0].page;
  await host.goto(`${APP_URL}/?devSession=${runId}-p1`);
  await host.getByRole('button', { name: /Host the round/i }).click();
  await host.getByLabel(/Your nickname/i).fill(players[0].name);
  await host.getByRole('button', { name: /^Create Room$/i }).click();
  await expect(host.getByRole('heading', { name: /Current Room/i })).toBeVisible();

  const roomCode = (await host.locator('.room-code-copy strong').innerText()).trim();
  console.log(`Room code: ${roomCode}`);

  for (let index = 1; index < players.length; index += 1) {
    const player = players[index];
    await player.page.goto(`${APP_URL}/?devSession=${runId}-p${index + 1}&step=join&code=${roomCode}`);
    await player.page.getByLabel(/Your nickname/i).fill(player.name);
    await player.page.getByRole('button', { name: /^Join Room$/i }).click();
    await expect(player.page.getByRole('heading', { name: /Current Room/i })).toBeVisible();
  }

  await bringAllPagesToFront(players);
  await pauseForViewing('Five tabs joined the same room.');

  for (const player of players) {
    const readyButton = player.page.getByRole('button', { name: /^Set Ready$/i });
    if (await readyButton.isVisible()) await readyButton.click();
  }

  await expect(host.getByRole('button', { name: /^Start Game$/i })).toBeEnabled();
  await host.bringToFront();
  await pauseForViewing('All five players are ready. Starting game.');
  await host.getByRole('button', { name: /^Start Game$/i }).click();

  for (const player of players) {
    await expect(player.page.getByText(/Table Quest/i)).toBeVisible();
  }

  await revealRoles(players);
  await bringAllPagesToFront(players);
  await pauseForViewing('Roles are revealed on each player tab.');

  const leader = await findLeader(players);
  await leader.page.bringToFront();
  await proposeFirstQuestTeam(leader, players.slice(0, 2));
  await submitVotes(players);
  await submitMissionCards(players);

  await expect(host.getByText(/Good won/i)).toBeVisible();
  await host.bringToFront();
  await pauseForViewing('First quest completed. Browser will stay open unless --close is used.');

  if (closeWhenDone) {
    await browser.close();
    stopServer();
  }
}

async function ensureServer() {
  if (await canReach(APP_URL)) return;

  devServer = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  });

  devServer.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
  devServer.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));

  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (await canReach(APP_URL)) return;
    await wait(500);
  }
  throw new Error(`Timed out waiting for ${APP_URL}`);
}

async function canReach(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function revealRoles(players) {
  for (const player of players) {
    await player.page.bringToFront();
    const revealButton = player.page.getByRole('button', { name: /Reveal .* hidden role/i });
    if (await revealButton.isVisible()) await revealButton.click();
  }
}

async function findLeader(players) {
  for (const player of players) {
    const button = player.page.locator('.live-player-phone .phone-action').getByRole('button', { name: /^Propose Team$/i });
    if (await button.isVisible()) return player;
  }
  throw new Error('No visible leader proposal button found.');
}

async function proposeFirstQuestTeam(leader, team) {
  const action = leader.page.locator('.live-player-phone .phone-action');
  for (const player of team) {
    await action.getByLabel(player.name, { exact: true }).check();
  }
  await action.getByRole('button', { name: /^Propose Team$/i }).click();
}

async function submitVotes(players) {
  for (const player of players) {
    await player.page.bringToFront();
    await expect(player.page.getByText(/Team vote/i)).toBeVisible();
    await player.page.getByRole('button', { name: /^Approve$/i }).click();
  }
}

async function submitMissionCards(players) {
  for (const player of players) {
    const successButton = player.page.getByRole('button', { name: /^Success$/i });
    if (await successButton.isVisible()) {
      await player.page.bringToFront();
      await successButton.click();
    }
  }
}

async function bringAllPagesToFront(players) {
  for (const player of players) {
    await player.page.bringToFront();
    await wait(120);
  }
}

async function pauseForViewing(message) {
  console.log(message);
  if (!headless) await wait(Number(process.env.AVALON_DEMO_PAUSE_MS || 1200));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopServer() {
  if (devServer) devServer.kill('SIGTERM');
}

process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});

process.on('exit', stopServer);

main().catch((error) => {
  console.error(error);
  stopServer();
  process.exitCode = 1;
});
