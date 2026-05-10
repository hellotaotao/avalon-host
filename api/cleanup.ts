// @ts-nocheck
import { neon } from '@neondatabase/serverless';

type VercelRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type VercelResponse = {
  status(statusCode: number): VercelResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(): void;
};

type CleanupReason = 'finished_older_than_7_days' | 'abandoned_setup_or_lobby_older_than_48_hours' | 'stale_in_progress_older_than_7_days';

type CleanupRow = {
  id: string;
  status: string;
  cleanup_reason: CleanupReason;
};

let sqlClient: ReturnType<typeof neon> | undefined;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('content-type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  try {
    const result = await cleanupOldRooms();
    res.status(200).json(result);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Cleanup failed.' });
  }
}

export async function cleanupOldRooms() {
  const deletedRows = (await getSql()`
    delete from rooms
    where
      (status = 'finished' and updated_at < now() - interval '7 days')
      or (status in ('setup', 'lobby') and updated_at < now() - interval '48 hours')
      or (status not in ('finished', 'setup', 'lobby') and updated_at < now() - interval '7 days')
    returning id::text as id,
      status,
      case
        when status = 'finished' then 'finished_older_than_7_days'
        when status in ('setup', 'lobby') then 'abandoned_setup_or_lobby_older_than_48_hours'
        else 'stale_in_progress_older_than_7_days'
      end as cleanup_reason
  `) as CleanupRow[];

  return {
    deletedRooms: deletedRows.length,
    deletedByReason: countBy(deletedRows, 'cleanup_reason'),
    deletedByStatus: countBy(deletedRows, 'status'),
  };
}

function isAuthorized(req: VercelRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    return readHeader(req, 'authorization') === `Bearer ${cronSecret}`;
  }
  return readHeader(req, 'x-vercel-cron') === '1';
}

function readHeader(req: VercelRequest, headerName: string) {
  const headers = req.headers ?? {};
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === headerName.toLowerCase())?.[1];
  return Array.isArray(match) ? match[0] : match;
}

function countBy(rows: CleanupRow[], key: 'cleanup_reason' | 'status') {
  return rows.reduce<Record<string, number>>((counts, row) => {
    counts[row[key]] = (counts[row[key]] ?? 0) + 1;
    return counts;
  }, {});
}

function getSql() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new HttpError(500, 'DATABASE_URL is not configured.');
  sqlClient ??= neon(databaseUrl);
  return sqlClient;
}

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}
