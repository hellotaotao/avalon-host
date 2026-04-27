const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

type SupabaseClientLike = {
  from: (table: string) => any;
  channel: (topic: string) => any;
  removeChannel: (channel: any) => Promise<unknown>;
};

let clientPromise: Promise<SupabaseClientLike | undefined> | undefined;

export function getSupabaseClient(): Promise<SupabaseClientLike | undefined> {
  if (!isSupabaseConfigured) return Promise.resolve(undefined);
  clientPromise ??= loadClient();
  return clientPromise;
}

async function loadClient(): Promise<SupabaseClientLike | undefined> {
  const moduleName = '@supabase/supabase-js';
  const dynamicImport = new Function('moduleName', 'return import(moduleName)') as (
    moduleName: string,
  ) => Promise<{ createClient: (url: string, key: string, options?: unknown) => SupabaseClientLike }>;
  const { createClient } = await dynamicImport(moduleName);
  return createClient(supabaseUrl!, supabaseAnonKey!, {
    realtime: {
      params: {
        eventsPerSecond: 5,
      },
    },
  });
}
