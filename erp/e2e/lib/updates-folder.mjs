// The release-updates flow's throwaway update folder: its name, in one place, for the harness
// (run.mjs hands it to the server as UPDATES_DIR) and the fixture script (db-fixtures.ts reaps it).
// Plain node: no imports.
export const UPDATES_DIR_NAME = "e2e-updates";
