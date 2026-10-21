import { z } from "zod";

export const planSchema = z.strictObject({
  summary: z.string().trim().min(1).max(2000),
  tasks: z.array(z.strictObject({
    title: z.string().trim().min(1).max(200),
    suggested_agent_role: z.enum(["chief-of-staff", "researcher", "developer"]),
    expected_deliverable: z.string().trim().min(1).max(2000),
  })).min(1).max(12),
  risks: z.array(z.string().trim().min(1).max(500)).max(10),
});
export type Plan = z.infer<typeof planSchema>;
