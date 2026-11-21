import type { TemplateConfig } from "./types";

/**
 * Whether a template places a logo at all. A flow template places it through `config.logo` (a
 * placement and width); a canvas template places it through a `{ kind: "logo" }` layout item and
 * keeps `config.logo` null. The print and preview paths turn a version's stored logo bytes into a
 * data URI only when this is true, so a canvas logo is not dropped before it reaches the builder.
 *
 * The flow builder's own `ctx.logo` (`prepareSheets`) deliberately still reads `config.logo`: a
 * canvas logo is drawn from its item, not from the flow's header slot.
 *
 * Client-safe: types only, no server import.
 */
export function templatePlacesLogo(config: Pick<TemplateConfig, "logo" | "layout">): boolean {
  return config.logo !== null || (config.layout?.items.some((item) => item.kind === "logo") ?? false);
}
