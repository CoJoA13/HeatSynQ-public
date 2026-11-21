"use client";
// A template's version table, read by the list page's selected template and the editor's Versions
// tab (the UX redesign PR 11, owner 2026-11-01 on #826). The list hands in the row's Open draft
// action; the editor hands in none, since a draft is open by definition. Client-safe, no state.
import type { ReactNode } from "react";
import { formatDate } from "@/lib/format";

export type VersionSummary = {
  versionNumber: number; status: "DRAFT" | "PUBLISHED" | "DISCARDED";
  publishedAt: string | null; publishedBy: string | null; hasLogo: boolean;
};

export function TemplateVersions({ versions, publishedVersionNumber, action }: {
  versions: readonly VersionSummary[];
  publishedVersionNumber: number | null;
  action?: (version: VersionSummary) => ReactNode;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-xs uppercase text-ink-500">
          <th className="py-1">Version</th>
          <th className="py-1">Status</th>
          <th className="py-1">Published</th>
          {action && <th className="py-1"></th>}
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => (
          <tr key={v.versionNumber} className="border-b last:border-0">
            <td className="py-1">v{v.versionNumber}{v.hasLogo && <span className="ml-1 text-xs text-ink-500">(logo)</span>}</td>
            <td className="py-1">
              {v.versionNumber === publishedVersionNumber ? "PUBLISHED (current)" : v.status}
            </td>
            <td className="py-1 text-xs text-ink-500">
              {v.publishedAt ? `${formatDate(v.publishedAt)}${v.publishedBy ? ` · ${v.publishedBy}` : ""}` : "—"}
            </td>
            {action && <td className="py-1 text-right">{action(v)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
