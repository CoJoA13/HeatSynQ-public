import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WhatsNewView } from "@/components/WhatsNewDialog";
import { loadUpdates, invalidateUpdates, sendSeen, type UpdateNote } from "@/lib/updates-client";
import { DATABASE_CHANGES_AFTER } from "@/lib/database-change-words";

const notes: UpdateNote[] = [
  { version: "1.4.0", publishedAt: "2026-11-19T10:00:00Z", databaseChanges: true, body: "## Database changes\n\nfuture tense\n\n- fixed (#9)" },
  { version: "1.3.0", publishedAt: "2026-11-10T10:00:00Z", databaseChanges: false, body: "- older" },
];

afterEach(() => vi.unstubAllGlobals());

describe("WhatsNewView", () => {
  it("lists every note newest first, an installed database note in the past tense", () => {
    const out = renderToStaticMarkup(<WhatsNewView notes={notes} />);
    expect(out.indexOf("1.4.0")).toBeLessThan(out.indexOf("1.3.0"));
    expect(out).not.toContain("future tense");
    expect(out).toContain("This update changed the database.");
    expect(DATABASE_CHANGES_AFTER).toContain("This update changed the database.");
    expect(out).toContain("older");
    expect(out).toContain("Got it");
  });
  it("renders nothing without notes", () => {
    expect(renderToStaticMarkup(<WhatsNewView notes={[]} />)).toBe("");
  });
});

describe("sendSeen", () => {
  it("posts the newest listed version", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ lastSeenVersion: "1.4.0" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendSeen(notes);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/updates/seen");
    expect(JSON.parse(String(init.body))).toEqual({ version: "1.4.0" });
  });
  it("sends nothing for no notes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await sendSeen([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("loadUpdates sharing", () => {
  it("shares a GET that is out, but the read after a write is a new request", async () => {
    const resolvers: ((r: Response) => void)[] = [];
    const fetchMock = vi.fn(() => new Promise<Response>((res) => { resolvers.push(res); }));
    vi.stubGlobal("fetch", fetchMock);
    const a = loadUpdates();
    const b = loadUpdates();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    invalidateUpdates();
    const c = loadUpdates();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.stringify({ running: null, whatsNew: [], pending: null, pendingNote: null, hold: null, canHold: false });
    // The first flight settles alone; its cleanup must not clear the second flight's slot.
    resolvers[0](new Response(body));
    await Promise.all([a, b]);
    const d = loadUpdates();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvers[1](new Response(body));
    await Promise.all([c, d]);
  });
});
