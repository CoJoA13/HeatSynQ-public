/**
 * pdfmake ships no types of its own, and `@types/pdfmake` types only the BROWSER build — its
 * `index.d.ts` describes `createPdf()`, which does not exist on the low-level Node entry point.
 *
 * pdfmake 0.3 RELOCATED that entry: 0.2's `pdfmake/src/printer.js` (a CommonJS `module.exports =
 * PdfPrinter`) is gone; the constructor now lives at `pdfmake/js/Printer.js` as an ES-style
 * `export default`, and — the breaking change `render.ts` has to absorb — `createPdfKitDocument`
 * is now ASYNC. The constructor also grew two parameters: a virtual filesystem and a URL resolver,
 * because 0.3 resolves a font DESCRIPTOR (a filename string) to its bytes through the vfs rather
 * than accepting raw `Buffer`s. See `render.ts` for how the app supplies both. Declared here,
 * minimally, for exactly the members we call.
 */
declare module "pdfmake/js/Printer.js" {
  import type { TDocumentDefinitions } from "pdfmake/interfaces";
  import type { Readable } from "node:stream";

  /** pdfkit's document — a readable stream that must be `end()`ed before it finishes emitting. */
  interface PdfKitDocument extends Readable {
    end(): void;
  }

  /** A font family's four faces. In 0.3 each face is a virtual-filesystem FILENAME (a string),
   *  NOT a Buffer — the bytes live in the vfs and pdfmake reads them from there at render time. */
  interface FontFamily {
    normal: string;
    bold: string;
    italics: string;
    bolditalics: string;
  }

  /** The subset of pdfmake's VirtualFileSystem that the font path actually calls. `writeFileSync`
   *  is optional because only the (unused) URL-download path writes; the font reads never do. */
  interface VirtualFs {
    existsSync(filename: string): boolean;
    readFileSync(filename: string): Buffer;
    writeFileSync?(filename: string, content: Buffer): void;
  }

  /** The subset of pdfmake's URLResolver that `Printer.resolveUrls` calls: `resolve()` once per
   *  font descriptor and `resolved()` once, awaited. Font descriptors are vfs filenames (never
   *  URLs) here, so both are no-ops — but the object is dereferenced unconditionally, so it must
   *  exist. */
  interface UrlResolver {
    resolve(url: string, headers?: Record<string, string>): void | Promise<void>;
    resolved(): Promise<unknown>;
  }

  export default class PdfPrinter {
    constructor(
      fontDescriptors: Record<string, FontFamily>,
      virtualfs?: VirtualFs,
      urlResolver?: UrlResolver,
      localAccessPolicy?: (path: string) => boolean,
    );
    /** 0.3 made this ASYNC — it resolves to the pdfkit document (which must still be `end()`ed). */
    createPdfKitDocument(
      docDefinition: TDocumentDefinitions,
      /** `tableLayouts` registers custom layouts by name — see render.ts's LAYOUT. */
      options?: { tableLayouts?: Record<string, unknown> },
    ): Promise<PdfKitDocument>;
  }
}

/**
 * pdfmake 0.3's layout engine, the class `Printer.js` lays every document out with. `render.ts`
 * reaches it for two things: wrapping `addHeadersAndFooters` so a page-bottom band's footer frame
 * ends at the band's bottom edge (#978), and wrapping `processNode` so the column clamp knows which
 * nodes lie inside a canvas table block (#971). Declared, minimally, for exactly the members those
 * wrappers call, as read at 0.3.13. CommonJS shaped `{ __esModule: true, default: LayoutBuilder }`,
 * like `Printer.js`.
 */
declare module "pdfmake/js/LayoutBuilder.js" {
  /** A footer or header frame: where pdfmake commits the unbreakable block it lays the node out in. */
  interface RepeatableFrame { x: number; y: number; width: number; height: number }

  export default class LayoutBuilder {
    addHeadersAndFooters(header: unknown, footer: unknown): void;
    addDynamicRepeatable(
      nodeGetter: unknown,
      sizeFunction: (
        pageSize: { width: number; height: number },
        pageMargins: { left: number; top: number; right: number; bottom: number },
      ) => RepeatableFrame,
      customPropertyName: string,
    ): void;
    /** Lays out one node: every stack item, column and table cell comes back through it. */
    processNode(node: unknown, isVerticalAlignmentAllowed?: boolean): void;
  }
}

/**
 * pdfmake 0.3's column calculator, which sizes a `columns` row's columns (`LayoutBuilder.processColumns`)
 * and a table's (`TableProcessor.beginTable`), each reading `buildColumnWidths` off this object at call
 * time. `render.ts` wraps that property for the column clamp (#971) and classifies columns with pdfmake's
 * own two tests. CommonJS shaped `{ __esModule: true, default: { buildColumnWidths, measureMinMax,
 * isAutoColumn, isStarColumn } }`. Declared, minimally, for exactly the members called, as read at 0.3.13.
 */
declare module "pdfmake/js/columnCalculator.js" {
  /** A column as the calculator sees it: its specified width, the minimum and maximum pdfmake
   *  measured for it, and the width it lays it out at, which `buildColumnWidths` sets. */
  export interface CalculatorColumn {
    width?: unknown;
    _minWidth: number;
    _maxWidth: number;
    _calcWidth: number;
  }
  const columnCalculator: {
    buildColumnWidths(columns: CalculatorColumn[], availableWidth: number, offsetTotal?: number, tableNode?: unknown): void;
    isAutoColumn(column: CalculatorColumn): boolean;
    isStarColumn(column: CalculatorColumn): boolean;
  };
  export default columnCalculator;
}
