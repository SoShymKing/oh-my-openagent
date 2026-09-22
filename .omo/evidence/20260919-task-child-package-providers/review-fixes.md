# 8492 — package extensions reach EVERY child launch path

Review of #8497 (5 adversarial lanes) found the enrichment reached an ordinary first spawn and
nothing else. This records the fixes for those findings.

## WHAT WAS TESTED

1. `bun test packages/senpi-task/src packages/omo-senpi/src/components/task`
2. `bun run typecheck` at the worktree root
3. Mutation proofs that the two new test files can fail for the regressions they name
4. `node packages/omo-senpi/plugin/scripts/build-extension.mjs` (bundle regenerated on Linux + Node,
   per the platform/engine constraint the senpi-compatibility gate enforces)

## WHAT WAS OBSERVED

1. 3074 pass / 1 skip / 0 fail across 410 files. The skip is the pre-existing
   `rpc-process.windows.test.ts` windowsHide case, untouched by this change.
2. typecheck exit 0 (tsgo, typecheck:script, typecheck:packages).
3. Mutation results, both reverted afterwards:
   - `buildRespawnRunner` stops enriching (the pre-fix behaviour) => RED on
     "#given a revived child that names no extensions". 6 pass / 1 fail.
   - `workpoolProcessLaunch` ignores the session resolver (the pre-fix behaviour) => RED on both
     workpool package assertions. 5 pass / 2 fail.
   Baseline and post-revert are both 7 pass / 0 fail.
4. The six pre-existing `package-extensions.test.ts` cases pass UNMODIFIED, including
   "#given a ... runner #when contexts and installed packages change between spawns", which pins
   `resolutions === 2`. An earlier attempt to memoize the installed-root lookup broke that contract
   and was reverted: freshness is deliberate, so the lookup cost is bounded by a timeout instead.

## WHY IT IS ENOUGH

The three findings were each a distinct producer of a child launch list:

- Revival: `composeTaskEngine` passed no `rpcRespawnRunner`, so `manager.ts` fell back to a bare
  `new RpcProcessRunner()` carrying no inherited extensions at all. Now `buildRespawnRunner` supplies
  the same package-aware list, and the mutation above proves the test sees it.
- Team members and pool workers assembled their own arrays from argv, and any defined
  `spec.extensions` short-circuits the enrichment branch by design. They now resolve through the
  shared resolver; the contract that a caller-supplied list wins, including `[]`, is unchanged and
  still pinned.
- `member-respawn.ts` snapshotted the inherited list when the resolver was constructed. It now
  resolves per revival, so a child revived after more extensions registered sees them.

## WHAT WAS OMITTED

No credentials, tokens, environment dumps, or machine identifiers are recorded here. The live
provider QA for the original defect is in #8497's own PR body.
