import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { mode } from "@/lib/config";
import { logout } from "../actions";
import { Button } from "@/components/ui/button";
export const dynamic = "force-dynamic";
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser();
  return (
    <>
      <header className="border-b border-input bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-6 px-6 py-5">
          <Link href="/dashboard" className="text-xl font-bold tracking-tight">
            ◈ Agent City
          </Link>
          <nav aria-label="Dashboard" className="flex flex-1 gap-5 text-sm">
            <Link href="/dashboard">Missions</Link>
            <Link href="/dashboard/agents">Agents</Link>
            <Link href="/dashboard/activity">Activity</Link>
          </nav>
          <form action={logout}>
            <Button variant="outline">Sign out</Button>
          </form>
        </div>
      </header>
      <div className="border-b border-input bg-muted px-6 py-2 text-center text-sm">
        {mode() === "mock"
          ? "LOCAL MOCK · simulated identity and execution · no external actions"
          : "SUPABASE · authenticated workspace · mock execution only"}
      </div>
      <main className="mx-auto max-w-7xl px-6 py-10">{children}</main>
    </>
  );
}
