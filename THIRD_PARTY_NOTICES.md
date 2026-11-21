# Third-party notices

The [Apache-2.0 project license](LICENSE) applies to HeatSynQ's original code and
documentation. Third-party components retain their respective licenses. This file
is an inventory of bundled material, not a replacement for those license texts.

## PDF fonts

| Component | License and attribution source |
|---|---|
| Liberation Sans | [Bundled SIL Open Font License 1.1 and copyright notice](erp/src/server/pdf/fonts/liberation-sans/LICENSE) |
| Liberation Serif | [Bundled SIL Open Font License 1.1 and copyright notice](erp/src/server/pdf/fonts/liberation-serif/LICENSE) |
| Roboto Mono | [Bundled SIL Open Font License 1.1 and copyright notice](erp/src/server/pdf/fonts/roboto-mono/OFL.txt) |
| Roboto supplied by pdfmake | License and notices supplied in the installed pdfmake package |

The [font provenance record](erp/src/server/pdf/fonts/PROVENANCE.md) records upstream
locations, versions and checksums. Preserve the bundled font licenses when redistributing
them, including in packaged builds.

## Dependencies and starter assets

Application and build dependencies are identified in [`erp/package.json`](erp/package.json)
and the exact dependency tree in [`erp/package-lock.json`](erp/package-lock.json).
Their license and NOTICE files remain authoritative and must be retained as applicable
when distributing source bundles or container images.

The Next.js/Vercel starter SVG assets under `erp/public/` retain their upstream origin;
their presence is not an endorsement or a grant of trademark rights. HeatSynQ does not
use third-party logos as its project identity.

## Reference materials

The examples under [`docs/samples/`](docs/samples/INDEX.md) are newly authored fictional
forms. Original private business forms and vendor research are not offered under the
HeatSynQ license. This source selection excludes those private reference materials. Their absence
does not establish redistribution rights or clearance for any historical copy.
The supplied HeatSynQ [brand asset record](erp/src/assets/brand/README.md) describes
the assets retained here; it is not an independent rights-clearance certificate.
