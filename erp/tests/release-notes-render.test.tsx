import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderNotes, RELEASE_RUN_MARKER } from "@/lib/release-notes-render";

const html = (body: string) => renderToStaticMarkup(<div>{renderNotes(body)}</div>);

describe("renderNotes", () => {
  it("renders a script tag as literal text, never an element", () => {
    const out = html("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<script");
  });
  it("renders other HTML comments as literal text", () => {
    expect(html("<!-- hello -->")).toContain("&lt;!-- hello --&gt;");
  });
  it("drops a line that is exactly a release-run marker, and only that", () => {
    expect(RELEASE_RUN_MARKER.test("<!-- heatsynq-release-run 123 -->")).toBe(true);
    const out = html("<!-- heatsynq-release-run 42 -->\n\nKept text");
    expect(out).not.toContain("heatsynq-release-run");
    expect(out).toContain("Kept text");
    expect(html("x <!-- heatsynq-release-run 42 -->")).toContain("heatsynq-release-run");
    expect(html(" <!-- heatsynq-release-run 42 -->")).toContain("heatsynq-release-run");
  });
  it("renders headings, bullets, bold, code and (#N) as text", () => {
    const out = html("## Fixed\n\n- one **bold** item (#12)\n- two `code`\n\n### Sub\n\npara line\nsecond line");
    expect(out).toContain("<h3");
    expect(out).toContain("<ul");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code");
    expect(out).toContain("(#12)");
    expect(out).toContain("para line second line");
  });
  it("renders a body with or without Behind the scenes whole", () => {
    expect(html("- a\n\n## Behind the scenes\n\n- b")).toContain("Behind the scenes");
    const plain = html("- a");
    expect(plain).toContain("a");
    expect(plain).not.toContain("Behind");
  });
  it("renders an empty body as nothing", () => {
    expect(html("")).toBe("<div></div>");
    expect(html("<!-- heatsynq-release-run 1 -->")).toBe("<div></div>");
  });
});
