import { createClient } from "@supabase/supabase-js";

/**
 * Cliente Supabase con la service-role key: corre server-side y bypassa RLS.
 * NUNCA debe exponerse al cliente MCP (que habla con este backend vía HTTP, no con Supabase).
 */
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno (ver backend/.env.example)",
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
