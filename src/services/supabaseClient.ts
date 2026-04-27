import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

let client: SupabaseClient | undefined;

export function getSupabaseClient(): Promise<SupabaseClient | undefined> {
  if (!isSupabaseConfigured) return Promise.resolve(undefined);
  client ??= createClient(supabaseUrl!, supabaseAnonKey!, {
    realtime: {
      params: {
        eventsPerSecond: 5,
      },
    },
  });
  return Promise.resolve(client);
}
