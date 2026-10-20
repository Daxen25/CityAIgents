import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
const definitionSchema = z.object({
  key: z.string(),
  version: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
});
export async function readAgentDefinitions(db: SupabaseClient) {
  const { data, error } = await db
    .from("agent_definitions")
    .select("key,version,name,description")
    .order("name");
  if (error) throw new Error("Unable to load persisted agent definitions");
  return definitionSchema.array().parse(data);
}
