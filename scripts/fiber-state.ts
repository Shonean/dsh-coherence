/**
 * Sibling-cordis plugin-fiber lifecycle states.
 *
 * The published `@deepseek-ai/cordis` bundle ships the fiber runtime (a
 * `ctx.plugin()` fiber exposes `.state`/`.await()`) but does not re-export the
 * `FiberState` enum symbol. The numeric encoding below matches the fork's
 * runtime exactly (LOADING=1 while `apply` runs, ACTIVE=2 once settled), so the
 * harness and its spec share one stable contract without depending on an
 * unreleased fork export. Keep in lock-step with `@deepseek-ai/cordis` fiber
 * semantics if the fork ever exposes the enum publicly.
 */
export enum FiberState {
  PENDING,
  LOADING,
  ACTIVE,
  FAILED,
  DISPOSED,
  UNLOADING,
}
