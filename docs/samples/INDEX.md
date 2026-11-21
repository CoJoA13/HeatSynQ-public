# Fictional reference forms

These six one-page PDFs are newly authored HeatSynQ examples, using invented companies,
addresses, identifiers, prices and results. They contain no real signature or business
record. They illustrate document fields; they are not operating instructions, valid
certifications, payment requests, or captures of the application's current PDF renderer.

| Example | File |
|---|---|
| Order form | [Order Form Sample.pdf](<Order Form Sample.pdf>) |
| Bill of lading | [Bill of Lading Sample.pdf](<Bill of Lading Sample.pdf>) |
| Certification | [Certification Sample.pdf](<Certification Sample.pdf>) |
| Invoice | [Invoice Sample.pdf](<Invoice Sample.pdf>) |
| Quote | [Quote Sample.pdf](<Quote Sample.pdf>) |
| Shipping ticket | [Shipping Ticket Sample.pdf](<Shipping Ticket Sample.pdf>) |

Original private business forms are excluded from this source distribution.
These fictional examples do not redefine historical requirements. The independently
written [design rationale](../design-rationale.md) describes the application's scope.
No clearance for an older repository copy or its history is implied by this selection.

## Rebuild

With Python 3 and ReportLab installed, run from the repository root:

```bash
python3 docs/samples/generate.py
```

Use `--output /path/to/preview` to render into a separate directory. The generator reads
only the repository's vendored Liberation Sans fonts, whose
[OFL notice](../../erp/src/server/pdf/fonts/liberation-sans/LICENSE) must accompany
redistributed copies. No original forms or external business data are inputs. The source
and authored form content are covered by the project's [Apache-2.0 license](../../LICENSE).
