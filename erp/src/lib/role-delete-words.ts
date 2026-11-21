// The refusal of a role delete with no reason, stated once: `deleteRole` (src/server/roles.ts)
// refuses in it, and the Roles page refuses a blank answer in it before sending (#636). Import-free,
// so the client page can read it.
export const ROLE_DELETE_REASON_REQUIRED = "A reason is required to delete a role";
