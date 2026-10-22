"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionSchema } from "@agent-city/core";
import { localToken, requireUser } from "@/lib/auth";
import { mode } from "@/lib/config";
import { supabase } from "@/lib/supabase";
import { createMission, createWorkspace, transition } from "@/lib/repository";
import { planMission, recoverPlan } from "@/lib/planning";
import { reviewTaskPlan } from "@/lib/orchestration";
export async function login(form: FormData) {
  if (mode() === "mock") {
    (await cookies()).set("city-local", localToken(), {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
      maxAge: 28800,
    });
  } else {
    const parsed = z
      .object({
        email: z.email().max(320),
        password: z.string().min(1).max(4096),
      })
      .safeParse({
        email: String(form.get("email") ?? "").trim(),
        password: form.get("password"),
      });
    if (!parsed.success) redirect("/login?error=Unable+to+sign+in");
    const credentials = parsed.data;
    const { error } = await (
      await supabase()
    ).auth.signInWithPassword({
      ...credentials,
    });
    if (error) redirect("/login?error=Unable+to+sign+in");
  }
  redirect("/dashboard");
}
export async function logout() {
  if (mode() === "mock") (await cookies()).delete("city-local");
  else {
    const { error } = await (await supabase()).auth.signOut({ scope: "local" });
    if (error) redirect("/dashboard?error=Unable+to+sign+out.+Please+retry.");
  }
  redirect("/login");
}
async function mutation(work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operation failed";
    redirect(`/dashboard?error=${encodeURIComponent(message.slice(0, 250))}`);
  }
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
export async function newMission(form: FormData) {
  const user = await requireUser();
  await mutation(() =>
    createMission(user, {
      workspaceId: form.get("workspaceId"),
      title: form.get("title"),
      objective: form.get("objective"),
      kind: form.get("kind"),
    }),
  );
}
export async function advanceMission(form: FormData) {
  const user = await requireUser();
  await mutation(async () => {
    const id = z.uuid().parse(form.get("id"));
    const action = actionSchema.parse(form.get("action"));
    await transition(user, id, action);
  });
}
export async function newWorkspace(form: FormData) {
  await requireUser();
  await mutation(async () => {
    if (mode() !== "supabase")
      throw new Error("Local workspace is already provisioned");
    await createWorkspace(
      z.string().trim().min(2).max(80).parse(form.get("name")),
    );
  });
}
export async function generateChiefPlan(form: FormData) {
  await requireUser();
  await mutation(async () => {
    await planMission(z.uuid().parse(form.get("id")), form.get("authorize") === "yes");
  });
}
export async function recoverChiefPlan(form: FormData) {
  await requireUser();
  await mutation(async () => { await recoverPlan(z.uuid().parse(form.get("id"))); });
}

export async function finalizeTaskPlan(form: FormData) {
  await requireUser();
  await mutation(async () => {
    await reviewTaskPlan({
      missionId: form.get("missionId"), runId: form.get("runId"), requestId: form.get("requestId"),
      decision: form.get("decision"), acceptedTaskIds: form.getAll("acceptedTaskIds"),
      confirmed: form.get("confirmed") === "yes",
    });
  });
}
