// The one notice box (spec 2026-10-30-ux-redesign-design.md §4.3): a refusal stays the app's red
// (owner ruling 2 of 2026-10-30), a warning is the design's orange, an informational line its
// blue-grey, a success its green. The classes are src/lib/ui-classes.ts's NOTICE. A caller that
// must keep its element (PageStatus's `<p role="alert">`, the recovery notice's `<aside>`) reads
// NOTICE directly; this component is for the plain case. Client-safe.
import type { ReactNode } from "react";
import { NOTICE, type NoticeKind } from "@/lib/ui-classes";

export function Notice({ kind, children, role, className }: {
  kind: NoticeKind;
  children: ReactNode;
  role?: "alert" | "status";
  className?: string;
}) {
  return <div role={role} className={className ? `${NOTICE[kind]} ${className}` : NOTICE[kind]}>{children}</div>;
}
