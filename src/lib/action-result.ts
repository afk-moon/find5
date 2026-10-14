export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

export const actionError = (e: unknown): ActionResult => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e),
});
