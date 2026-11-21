// The release-notes renderer (release-updates PR 3, Task 3.4). Release notes arrive as text from a
// file the host's update agent wrote, so nothing here ever builds HTML from them: the subset below
// (## and ### headings, "- " bullets, paragraphs, **bold**, `code`) becomes React elements and
// every other character, an HTML comment, a tag or a <script> included, stays literal text.
// Never dangerouslySetInnerHTML. A line that is exactly a release-run marker is dropped (ruling
// P1): the release agent stamps one into a note, and it is not something a reader should see.
import { Fragment, type ReactNode } from "react";

/** A whole line that is a release-run marker. */
export const RELEASE_RUN_MARKER = /^<!-- heatsynq-release-run \d+ -->$/;

/** `**bold**` and `` `code` `` inside one line of text; anything else is text as it was written. */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={key++}>{m[1]}</strong>);
    else out.push(<code key={key++} className="rounded bg-surface-50 px-1 text-[0.9em]">{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "h2" | "h3" | "p"; text: string }
  | { kind: "ul"; items: string[] };

function blocksOf(body: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const endPara = () => { if (para.length) blocks.push({ kind: "p", text: para.join(" ") }); para = []; };
  const endList = () => { if (list) blocks.push({ kind: "ul", items: list }); list = null; };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (RELEASE_RUN_MARKER.test(raw)) continue;
    if (line.trim() === "") { endPara(); endList(); continue; }
    const h = /^(##|###) (.+)$/.exec(line);
    if (h) { endPara(); endList(); blocks.push({ kind: h[1] === "##" ? "h2" : "h3", text: h[2] }); continue; }
    if (line.startsWith("- ")) { endPara(); (list ??= []).push(line.slice(2)); continue; }
    endList();
    para.push(line.trim());
  }
  endPara(); endList();
  return blocks;
}

/** The notes body as elements; an empty body (or one of only markers) is nothing. */
export function renderNotes(body: string): ReactNode {
  const blocks = blocksOf(body);
  if (blocks.length === 0) return null;
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "h2") return <h3 key={i} className="mt-4 text-base font-semibold text-ink-800">{renderInline(b.text)}</h3>;
        if (b.kind === "h3") return <h4 key={i} className="mt-3 text-sm font-semibold text-ink-800">{renderInline(b.text)}</h4>;
        if (b.kind === "ul") {
          return (
            <ul key={i} className="my-2 list-disc pl-5 text-sm text-ink-800">
              {b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
            </ul>
          );
        }
        return <p key={i} className="my-2 text-sm text-ink-800"><Fragment>{renderInline(b.text)}</Fragment></p>;
      })}
    </>
  );
}
