export type LoadLimits = { loadQty: number | null; loadWeight: number | null };

export type LoadAdjustment =
  | { source: "part" }
  | ({ source: "order" } & LoadLimits);

export type EntryPlanInput = {
  customerId: string;
  lines: { partId: string; qty: number; weight: number }[];
  loadAdjustment?: LoadAdjustment;
};

export type EntryProcessContent = {
  recipeNumber: string | null;
  steps: {
    position: number;
    code: string;
    codeName: string;
    instruction: string;
    fields: {
      label: string;
      type: string;
      unit: string | null;
      value: string | boolean | null;
    }[];
  }[];
};

export type EntryPlanPreview = {
  fingerprint: string;
  leadPartId: string;
  revisionNumber: number;
  source: "part" | "order";
  defaults: LoadLimits;
  effective: LoadLimits;
  process?: EntryProcessContent;
  totalQty: number;
  totalWeightCents: string;
  loads: { loadNumber: number; qty: number; weight: number }[];
};
