"use client";
// The traveler canvas designer's Design tab (PR C of #926, Task 4; design
// `docs/superpowers/specs/2026-11-07-traveler-canvas-designer-design.md` §8): the palette, the
// stage and the inspector over the one `config` the editor holds. The panel's own state is view
// state alone: which item is selected (an id; the item is found in the layout at render, so an item
// that leaves the layout leaves the selection with it), the panel's one message and the stage's
// scale. Every edit is one `apply` over the layout through the leaf (`replaceItem`, `setAnchor`,
// `removeItem`, `placeNew`); nothing here sends a request (the logo `<img>` reads the draft's logo).
//
// `measure` is the editor's (ruling C1). The live page beside the stage (Task 6) is the editor's
// too: it builds the pane (`<PreviewPane autoRun onMeasure={setMeasure} …/>`, with the Preview tab's
// record) and hands it here as `preview` (ruling C16), so this panel knows nothing of its props and
// takes no measure setter; the pane reports the measure to the editor, which hands it back here for
// the stage and the warnings.
// The live page is a page-shaped frame as tall as the window (owner ruling 2026-11-20, which
// replaced ruling C28's 76 rem container query): it is a fourth column only where the grid ITSELF,
// measured, holds that frame beside the palette's 12 rem, a stage at scale 0.65 and the inspector's
// 16 rem (`liveBeside`, `src/lib/preview-frame.ts`), and spans under the stage below that, the
// palette then scrolling within the stage's height so the page sits right under the stage. The
// grid's width, not the window's, because the rail and the Template status card take their share
// of any window. Before the grid is measured (and in a static render) the page is under the stage.
// Under the stage, the stage itself fits the window below its top, never under scale 0.65.
//
// Back to sections and Clear the page (Task 5) are the editor's: each asks, then edits the layout
// through `apply`, so the panel only draws the two buttons in its header under the edit gate. The
// canvas's refusal is the panel's second message, derived at render: it is the sentence that closes
// the editor's Save (`canvasSaveBlock`), and the stage outlines the items it names.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PanelMessage } from "@/components/PanelMessage";
import { DESIGNER_WORDS, fitScale, isRequired, paletteEntries, placeNew, removeItem, replaceItem, setAnchor } from "@/lib/canvas-designer";
import { canvasPageFor } from "@/lib/template-contracts/canvas";
import { canvasRefusal, canvasWarnings, type CanvasMeasure } from "@/lib/template-canvas";
import type { TemplateConfig, TemplateContract } from "@/lib/template-contracts";
import type { CanvasAnchor, CanvasItem } from "@/lib/template-contracts/canvas";
import { setLayout } from "@/lib/template-editor";
import { fontFaceCss } from "@/lib/template-fonts";
import { boundedStageScale, designGrid, liveBeside, pageFrame, stageRoom } from "@/lib/preview-frame";
import { useMeasuredWidth, useWindowHeight } from "@/lib/use-viewer-size";
import { BUTTON_NEUTRAL_COMPACT, CARD, TEXT_MUTED } from "@/lib/ui-classes";
import { CanvasInspector } from "./CanvasInspector";
import { CanvasPalette } from "./CanvasPalette";
import { CanvasStage } from "./CanvasStage";

export type DesignPanelProps = {
  templateId: string;
  contract: TemplateContract;
  config: TemplateConfig;
  apply: (fn: (c: TemplateConfig) => TemplateConfig) => void;
  disabled: boolean;
  editTitle: string | undefined;
  measure: CanvasMeasure | null;
  /** The draft's logo (`/api/templates/<id>/logo?v=<updatedAt>`), null when the draft has none. */
  logoSrc: string | null;
  /** The editor's Back to sections and Clear the page: each asks before it edits the layout. */
  onBackToSections: () => void;
  onClearPage: () => void;
  /** The live page (Task 6, ruling C16): the editor's own `PreviewPane` under `autoRun`. */
  preview: ReactNode;
};

export function DesignPanel(props: DesignPanelProps) {
  const { contract, config, apply, disabled, editTitle, measure, logoSrc, onBackToSections, onClearPage, preview } = props;
  const layout = config.layout;
  const pageFooter = config.pageFooter;
  // The template's fonts: the fold's shared-width line reads them (the base size reaches the steps
  // table's width too, but only its handwriting-restore branch uses it, which rule 9's lock makes unreachable).
  const fonts = config.fonts;
  // The template's page: the stage draws it and the rules and the designer judge by it.
  const page = canvasPageFor(contract.docType, config.formats.labelSize);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const column = useRef<HTMLDivElement>(null);
  const [grid, gridWidth] = useMeasuredWidth();
  const windowHeight = useWindowHeight();
  // The live page's frame at the window's height, unnarrowed: beside the stage it is its column's width.
  const frameWidth = windowHeight === null ? 0 : pageFrame(page, windowHeight).width;
  const columns = designGrid(gridWidth !== null && frameWidth > 0 && liveBeside(gridWidth, frameWidth, page), frameWidth);

  // The stage fits its column. The column is observed, not the stage, whose width follows the scale.
  // With the live page under the stage, the stage is also bounded to the window height left below
  // its column's top in the document (owner ruling 2026-11-20, second: `boundedStageScale`), so the
  // whole stage shows as the tab opens and the page sits closer. The top is read when the column or
  // the window resizes, never on a render, so a message appearing above the grid rescales nothing.
  const under = columns.capPalette;
  useEffect(() => {
    const element = column.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const room = under && windowHeight !== null ? stageRoom(windowHeight, element.getBoundingClientRect().top + window.scrollY) : null;
      setScale(boundedStageScale(fitScale(element.clientWidth, page), room, page));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [page, under, windowHeight]);

  const refusal = useMemo(() => (layout === null ? null : canvasRefusal(layout, contract, { pageFooter, page, fonts })), [layout, contract, pageFooter, page, fonts]);
  const warnings = useMemo(
    () => (layout === null ? [] : canvasWarnings(layout, contract, measure ?? undefined, { pageFooter, fonts, page })),
    [layout, contract, measure, pageFooter, fonts, page],
  );
  if (layout === null) return null;

  const selected = layout.items.find((item) => item.id === selectedId) ?? null;
  const edit = (fn: (layout: NonNullable<TemplateConfig["layout"]>) => NonNullable<TemplateConfig["layout"]>) =>
    apply((c) => (c.layout === null ? c : setLayout(c, fn(c.layout))));
  const commit = (next: CanvasItem) => edit((current) => replaceItem(current, next));
  const anchor = (id: string, to: CanvasAnchor) => edit((current) => {
    const item = current.items.find((other) => other.id === id);
    return item === undefined ? current : replaceItem(current, setAnchor(current, item, to));
  });
  const remove = (item: CanvasItem) => {
    if (isRequired(item, contract)) {
      setMessage(DESIGNER_WORDS.cannotRemove(contract));
      return;
    }
    setMessage(null);
    edit((current) => removeItem(current, item.id));
  };

  return (
    <section id="canvas-design" className={CARD}>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onBackToSections} disabled={disabled} title={editTitle} className={BUTTON_NEUTRAL_COMPACT}>
          {DESIGNER_WORDS.backToSections}
        </button>
        <button type="button" onClick={onClearPage} disabled={disabled} title={editTitle} className={BUTTON_NEUTRAL_COMPACT}>
          {DESIGNER_WORDS.clearPage}
        </button>
      </div>
      <PanelMessage message={refusal?.sentence ?? null} />
      <PanelMessage message={message} />
      <div ref={grid} className={columns.className} style={columns.style}>
        <div data-palette-column="" className={columns.capPalette ? "min-w-0 lg:max-h-(--stage-height) lg:overflow-y-auto" : "min-w-0"}
             style={columns.capPalette ? ({ "--stage-height": `${page.height * scale}px` } as CSSProperties) : undefined}>
          <CanvasPalette entries={paletteEntries(layout, contract)} disabled={disabled} editTitle={editTitle}
                         onAdd={(entry) => {
                           const item = placeNew(layout, contract, entry, { pageFooter, page, fonts });
                           edit((current) => ({ ...current, items: [...current.items, item] }));
                           setSelectedId(item.id);
                           setMessage(null);
                         }} />
        </div>
        <div ref={column} className="min-w-0 overflow-auto">
          <CanvasStage layout={layout} contract={contract} scale={scale} measure={measure} selectedId={selected?.id ?? null}
                       onSelect={setSelectedId} onCommit={commit} onRemove={remove} refusal={refusal} warnings={warnings}
                       fontCss={fontFaceCss(config.fonts.family)} family={config.fonts.family} logoSrc={logoSrc}
                       pageFooter={pageFooter} disabled={disabled} textBlocks={config.textBlocks} page={page} fonts={fonts} />
        </div>
        <div>
          {selected === null
            ? <p className={TEXT_MUTED}>{DESIGNER_WORDS.selectAnItem}</p>
            : <CanvasInspector key={selected.id} item={selected} layout={layout} contract={contract} onChange={commit}
                               onAnchor={(to) => anchor(selected.id, to)} onRemove={remove} onMessage={setMessage}
                               disabled={disabled} editTitle={editTitle} />}
        </div>
        <div data-live-page="" className={columns.pageClass}>
          {preview}
        </div>
      </div>
    </section>
  );
}
