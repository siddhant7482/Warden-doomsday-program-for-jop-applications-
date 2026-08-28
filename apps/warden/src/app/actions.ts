"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { applications } from "@/db/schema";
import { dedupeKey } from "@/pipeline/parse";

/* Manual logging exists because not every application produces a
 * confirmation email. It is deliberately marked `manual` so the share
 * of the count that is unverifiable stays visible — the inbox is the
 * referee, and anything it did not see should say so. */
export async function logApplication(formData: FormData) {
  const company = String(formData.get("company") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  if (!company || !role) return { ok: false, error: "Company and role are both required." };

  const now = new Date();
  await db.insert(applications).values({
    company,
    role,
    platform: "other",
    status: "applied",
    appliedAt: now,
    lastContactAt: now,
    dedupeKey: dedupeKey(company, role),
    manual: true,
  });

  revalidatePath("/");
  revalidatePath("/pipeline");
  return { ok: true };
}
