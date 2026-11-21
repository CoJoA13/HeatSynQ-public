import type { RecipeSnapshotV1 } from "./recipe-snapshot";

export type ExternalLoadV1 = {
  schemaVersion: 1;
  order: { id: string; orderNumber: number };
  load: { id: string; loadNumber: number; qty: number | null;
    weight: { value: string | null; unit: "lb" } };
  customer: { id: string; code: string; name: string };
  leadPart: { id: string; partNumber: string; partName: string };
  recipe: { status: "available"; snapshot: RecipeSnapshotV1 }
    | { status: "no_numbered_recipe" | "legacy_snapshot_unavailable"; snapshot: null };
};
