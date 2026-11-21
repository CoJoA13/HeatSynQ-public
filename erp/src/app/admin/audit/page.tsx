"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/format";
import { useLatest } from "@/lib/use-latest";
import { PageHeader } from "@/components/PageHeader";
import { BUTTON_PRIMARY, CARD, CARD_FLUSH, INPUT_COMPACT, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";

type Entry = { id: string; at: string; actorName: string; entity: string; entityId: string; action: string; reason: string | null };

export default function AuditPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entity, setEntity] = useState("");
  const [actor, setActor] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Ticket-gated (the customers/page.tsx load shape): two Searches with different filters used to
  // land in arrival order, permanently showing A's rows under B's filter text. The success-path
  // `setError(null)` moved BEHIND the ticket check — a stale response must not clear a newer
  // failure either (§5.13).
  const latest = useLatest();
  async function load() {
    const ticket = latest.next();
    try {
      const params = new URLSearchParams();
      if (entity) params.set("entity", entity);
      if (actor) params.set("actor", actor);
      const data = await api<Entry[]>(`/api/admin/audit?${params}`);
      if (!latest.isCurrent(ticket)) return; // a slower, now-superseded search lost the state race
      setEntries(data);
      setError(null);
    } catch (e) {
      // F7 (customers/page.tsx): a superseded search's rejection must not clobber current state.
      if (!latest.isCurrent(ticket)) return;
      setError((e as Error).message);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  return (
    <div className="p-6">
      <PageHeader title="Audit log" subtitle="Newest 200 matching events." actions={
        <button onClick={load} className={BUTTON_PRIMARY}>Search</button>} />
      {error && <p className={`${NOTICE.refusal} mb-3`}>{error}</p>}
      <div className={`${CARD} mb-3`}>
        <h2 className="mb-2 text-[17px] font-semibold text-ink-800">Filters</h2>
        <div className="flex gap-2 text-sm">
          <input placeholder="Entity (e.g. user)" value={entity} onChange={(e) => setEntity(e.target.value)}
                 className={INPUT_COMPACT} />
          <input placeholder="Actor name" value={actor} onChange={(e) => setActor(e.target.value)}
                 className={INPUT_COMPACT} />
        </div>
      </div>
      <div className={`${CARD_FLUSH} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead><tr className="border-b text-left">
            <th className={`${TABLE_HEAD} p-2`}>When</th><th className={`${TABLE_HEAD} p-2`}>Who</th><th className={`${TABLE_HEAD} p-2`}>Entity</th>
            <th className={`${TABLE_HEAD} p-2`}>Action</th><th className={`${TABLE_HEAD} p-2`}>Reason</th>
          </tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t">
                <td className={TABLE_CELL}>{formatDateTime(e.at)}</td>
                <td className={TABLE_CELL}>{e.actorName}</td>
                <td className={TABLE_CELL}>{e.entity} <span title={e.entityId} className="text-ink-500">{e.entityId.length > 8 ? `${e.entityId.slice(0, 8)}…` : e.entityId}</span></td>
                <td className={TABLE_CELL}>{e.action}</td>
                <td className={TABLE_CELL}>{e.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
