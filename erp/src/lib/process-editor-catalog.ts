export type ProcessEditorField = Readonly<{
  id: string;
  label: string;
  type: string;
  unit: string | null;
  sort: number;
}>;

export type ProcessEditorCode = Readonly<{
  id: string;
  code: string;
  name: string;
  active: boolean;
  defaultInstruction: string;
  fields: readonly ProcessEditorField[];
}>;
