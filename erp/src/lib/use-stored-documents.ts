"use client";
// The stored-documents lists' one fetch and state (P6 step 3; #632). Five pages drew the same list
// from five hand copies, and only Statements had the #223 item 6 form: three kept a failed read's
// error over a later read that landed (#632 bug b, fixed in each copy by P6 step 2), and four said
// "Nothing printed yet." while their first read was still out (bug a). Each list keeps its own
// name and table (`tests/shipment-totals-wiring.test.ts` pins `ShipmentDocumentsList`); only the
// read and its state are shared.
//
// `url` is the list's key: null reads nothing (Statements with no customer picked). `refresh` is
// bumped by every print, which reads again under the same key, so the list never blanks back to
// "Loading…" after a print. Both landings are gated on the newest ticket (§5.13, F7).
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { emptyListState, landFailure, landRows, listStatus, type ListState } from "@/lib/list-status";
import { useLatest } from "@/lib/use-latest";

export function useStoredDocuments<T>(url: string | null, allowed: boolean, refresh: number) {
  const [state, setState] = useState<ListState<T>>(emptyListState);
  const latest = useLatest();
  useEffect(() => {
    const t = latest.next();
    if (!allowed || url === null) return;
    api<T[]>(url)
      .then((rows) => { if (latest.isCurrent(t)) setState((s) => landRows(s, url, rows)); })
      .catch((e) => { if (latest.isCurrent(t)) setState((s) => landFailure(s, (e as Error).message)); });
  }, [url, allowed, refresh, latest]);
  const status = listStatus({ allowed, error: state.error, loadedFor: state.loadedFor, key: url, count: state.rows.length });
  return { docs: state.rows, error: state.error, status };
}
