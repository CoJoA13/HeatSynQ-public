# HeatSynQ product identity

These are the supplied HeatSynQ product assets, preserved byte-for-byte. The two
PNG wordmarks duplicated in the original bundle are stored once each here.

- Use `heatsynq-logo-dark.png` (light lettering) on dark backgrounds and
  `heatsynq-logo-light.png` (dark lettering) on light backgrounds.
- Use the PNG wordmarks for stable typography. The supplied SVG wordmarks retain
  live text, whose appearance depends on locally available fonts.
- The tile icons, compact marks, SVGs and all supplied PNG sizes are retained for
  supported app-icon surfaces and future packaging.

The app statically imports its wordmarks and 512px metadata icon. The root README
displays the 128px tile at 64px. `erp/src/app/favicon.ico` intentionally copies
`heatsynq.ico` so Next's favicon file convention serves the supplied icon.
`docs/manual/brand/heatsynq-logo-light.png` intentionally copies the light wordmark
so the manual builder can validate, inline and include it in its source digest.
