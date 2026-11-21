# LoadSynQ recipe reads

HeatSynQ owns each part's manually numbered recipe and its captured process revisions.
LoadSynQ reads a saved order/load pair through:

`GET /api/external/orders/{orderNumber}/loads/{loadNumber}`

Both path values are positive decimal integers from 1 through 2147483647. Leading zeros
are accepted; signs, decimals, exponents and whitespace are rejected. The traveler barcode
remains `ORDER-LOAD`. Responses always carry `Cache-Control: no-store`.

## Credential setup and rotation

Provision an independent random 32-byte credential encoded as 64 hexadecimal characters
in `LOADSYNQ_API_TOKEN`. This credential is separate from `HEALTH_MONITOR_TOKEN` and session
credentials. Keep it in deployment secrets, never in Git, URLs or logs. Configure the same
value in LoadSynQ's integration secret storage and send it only in the request header:

```http
Authorization: Bearer <LOADSYNQ_API_TOKEN>
```

Empty or malformed server configuration disables the endpoint with 404. The main app's
Compose environment optionally forwards the token; the image-release Compose layer inherits
that environment. Practice has no integration token configured by default. This document does
not provision a credential or deploy the service. Use a protected transport for bearer requests.

For rotation, provision a new independent token, update HeatSynQ's deployment secret and
recreate the intended app service using its existing deployment procedure, then update
LoadSynQ's secret. The old token stops working once replaced. There is no overlapping-token
grace period; plan for a short integration interruption. Do not reuse the health token.

Only the bearer header authorizes reads: a user/admin session or query parameter does not.
Authenticated attempts, including invalid path values and unsuccessful lookups, share a limit
of 60 requests per minute per configured integration credential. The fixed window starts at
the first accepted authentication. Rejected credentials consume no allowance. The limiter
uses one bounded process-local record; process restarts and credential rotation reset it.
Multiple app processes have separate limits. A 429 response includes `Retry-After` as an
integer ceiling number of seconds until the current window expires.

## JSON contract

The TypeScript contract is `ExternalLoadV1` in `erp/src/lib/external-load-contract.ts`;
the captured recipe shape is `RecipeSnapshotV1` in `erp/src/lib/recipe-snapshot.ts`.
IDs are opaque strings. Order/load numbers, revision numbers and positions are JSON numbers.
Recipe numbers are strings preserving leading zeros. There is no shared cross-part recipe.

| Field | JSON type and meaning |
| --- | --- |
| `schemaVersion` | Number, exactly `1` |
| `order` | Object: `id` string, `orderNumber` number |
| `load` | Object: `id` string, `loadNumber` number, `qty` number or null, `weight` object |
| `load.weight` | Object: `value` decimal string or null, `unit` exactly `"lb"` |
| `customer` | Object: `id`, `code`, `name`, all strings |
| `leadPart` | Object: `id`, `partNumber`, `partName`, all strings |
| `recipe.status` | `"available"`, `"no_numbered_recipe"` or `"legacy_snapshot_unavailable"` |
| `recipe.snapshot` | Captured snapshot object when available; otherwise null |

A snapshot contains `schemaVersion: 1`, string `recipeId`, `recipeNumber` and `partId`,
number `revisionNumber`, and a `steps` array. Each step contains string `stepId`, `codeId`,
`code`, `codeName`, `instruction`, number `position`, and a `fields` array. Each field contains
string `fieldDefId` and `label`, string-or-null `unit`, number `position`, `type` and `value`:

| Field type | Value |
| --- | --- |
| `NUMBER` | Decimal string or null; no numeric conversion |
| `TEXT` | String or null |
| `DATE` | ISO calendar date string `YYYY-MM-DD` or null |
| `CHECKBOX` | Boolean or null |

**What `fields` lists (process steps simplification, 2026-09-26).** `fields` lists the step's own
parameter rows, in position order. `fieldDefId` is the row's key: a suggestion ID for a row copied
from a step code's suggestion, a field-definition ID for a row migrated from a step value stored
before that change, and a generated ID for a row added by hand on the part. One key always means one
type and one unit, so a row whose type or unit changes arrives under a new key. A suggestion removed
on the part is absent, rather than listed with a `null` value. Snapshots captured before this change
are unchanged (they list every field the step's code had, filled or not), and the JSON shape
(`RecipeSnapshotV1`, `ExternalLoadV1`) is unchanged.

Example response (fictional IDs and names):

```json
{
  "schemaVersion": 1,
  "order": { "id": "order-example", "orderNumber": 1200 },
  "load": { "id": "load-example", "loadNumber": 1, "qty": 40,
    "weight": { "value": null, "unit": "lb" } },
  "customer": { "id": "customer-example", "code": "ACME", "name": "Acme Gear" },
  "leadPart": { "id": "part-example", "partNumber": "P-100", "partName": "Ring gear" },
  "recipe": {
    "status": "available",
    "snapshot": {
      "schemaVersion": 1,
      "recipeId": "recipe-example",
      "recipeNumber": "001207",
      "partId": "part-example",
      "revisionNumber": 1,
      "steps": [{
        "stepId": "step-example", "position": 1,
        "codeId": "code-example", "code": "HT", "codeName": "Heat",
        "instruction": "Hold",
        "fields": [{ "fieldDefId": "field-example", "label": "Temperature",
          "type": "NUMBER", "unit": "F", "position": 1, "value": "1650" }]
      }]
    }
  }
}
```

## Lookup and failure semantics

The lookup resolves the exact current order and load number. Its read-only Repeatable Read
transaction returns a coherent projection, with the lead line at position 1 and that line's
stored `(partId, revisionNumber)`. It never selects the latest part revision or a rider recipe.
Customer/part names and load quantities are current; a historically referenced soft-deleted
part remains readable. The recipe content is the immutable captured revision. Null quantity,
weight or parameter values stay null, and HeatSynQ performs no automatic unit conversion.

An unnumbered stored revision reports `no_numbered_recipe`. A numbered revision without
a captured snapshot, or missing historical revision metadata, reports
`legacy_snapshot_unavailable`. These are successful lookups with `snapshot: null`; the endpoint
does not backfill history, capture new snapshots, refresh sessions or mutate audit records.

| HTTP status | JSON body / meaning |
| --- | --- |
| 200 | `ExternalLoadV1`, including either unavailable-recipe status |
| 400 | `{"error":"Invalid order or load number"}` |
| 401 | `{"error":"Unauthorized"}` — missing or incorrect bearer credential |
| 404 | `{"error":"Not found"}` — disabled endpoint, missing/voided order or missing current load |
| 429 | `{"error":"Too many requests"}` — authenticated allowance exhausted; observe `Retry-After` |
| 503 | `{"error":"Service unavailable"}` — database or snapshot-validation failure; no internal details |

Load renumbering or re-splitting can make the same barcode resolve to a different current
load row. Print a fresh traveler after those changes. Archived PDF bytes stay unchanged.
LoadSynQ owns preserving the full scan-time response for its historical equipment record;
this endpoint does not provide historical load versions.

HeatSynQ supplies recipe data. It neither maps SSI opcodes nor sends to equipment.
LoadSynQ owns device mapping, unit compatibility, equipment/slot selection, transfer and
confirmation, starting with SSI 9010. This interface alone does not establish machine readiness
or prove an equipment transfer works.
