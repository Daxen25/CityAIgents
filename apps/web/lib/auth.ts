import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { mode } from "./config";
import { supabase } from "./supabase";
const secret = randomBytes(32); // Local sessions expire on process restart; no persistent secret required.
const mockUser = "11111111-1111-4111-8111-111111111111";
export function localToken() {
  const payload = `${mockUser}.${Date.now() + 8 * 60 * 60 * 1000}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}
export function verifyLocalToken(token?: string) {
  if (!token) return null;
  const [id, expiry, sig] = token.split(".");
  if (id !== mockUser || !sig || Number(expiry) < Date.now()) return null;
  const expected = createHmac("sha256", secret)
    .update(`${id}.${expiry}`)
    .digest("hex");
  return sig.length === expected.length &&
    timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ? id
    : null;
}
export async function userId() {
  if (mode() === "mock")
    return verifyLocalToken((await cookies()).get("city-local")?.value);
  const { data, error } = await (await supabase()).auth.getUser();
  return error ? null : (data.user?.id ?? null);
}
export async function requireUser() {
  const id = await userId();
  if (!id) redirect("/login");
  return id;
}
