# Darkpi Fork Operations & Notes

This document covers the `darkpi` fork (`fork = git@github.com:peter50216/t3code.git`, branch/bookmark `darkpi`; `origin` stays upstream `pingdotgg/t3code`), including how live builds are packaged and switched, rebase traps, and Antigravity usage-limit implementation constraints.

## 1. Fork Layout & Conventions

- Live runtime directory: `~/.t3/runtime/versions/<nightly>+darkpi.N`.
- Before adding commits, verify `git branch -vv` / `jj bookmark list darkpi`. A detached `HEAD` at `fork/darkpi` can lag behind local `darkpi` if an earlier local build has not been pushed yet.
- Run targeted Vitest suites from the owning package directory (for example `cd apps/server && ../../node_modules/.bin/vp test run ...`). Running from the repo root can also pick up duplicate worktree copies under `.workspaces/nightly/`.
- Darkpi's shell sets `DO_NOT_TRACK=1` and `T3CODE_TELEMETRY_ENABLED=false`, which breaks upstream `AnalyticsService.test.ts`. Run that test with `env -u DO_NOT_TRACK -u T3CODE_TELEMETRY_ENABLED`.

## 2. Antigravity (`agy`) Usage Limits Notes

Implementation lives in:

- [antigravityUsageLimits.ts](../../apps/server/src/provider/antigravityUsageLimits.ts)
- [AntigravityProvider.ts](../../apps/server/src/provider/AntigravityProvider.ts)
- [AntigravityDriver.ts](../../apps/server/src/provider/Drivers/AntigravityDriver.ts)
- [managedProvider.ts](../../packages/provider-core/src/server/managedProvider.ts)
- [usageLimits.ts](../../packages/shared/src/usageLimits.ts)

### Why CLI `/usage` instead of ACP

Verified against `agy` v1.5.18:

- `agy acp --stdio` does not expose account 5h/weekly quota:
  - `initialize` only advertises `_meta.antigravity: { tier: true, systemPrompt: { append: true } }`.
  - `session/new` returns `_meta.antigravity.tier.name` (for example `Google AI Pro`), which is surfaced as `auth.label`.
  - `session/update` `usage_update` is per-session context window token usage (`{ used, size }`), not subscription quota.
  - `available_commands_update` omits `/usage`; sending `"/usage"` via `session/prompt` sends literal text to the model.
- `agy --print "/usage" --output-format json` spends zero turns and zero tokens (~2s wall time) and returns structured `command.data.groups[].buckets[]` (`gemini-5h`, `gemini-weekly`, `3p-5h`, `3p-weekly` with `window`, `remaining_fraction`, `reset_time`).

### Implementation Traps

1. **Profile isolation (`HOME` vs `GEMINI_HOME`)**:
   - T3 Code runs `agy acp` with `--gemini-dir <profile> --app-data-dir antigravity-acp` and `SSH_CONNECTION`, storing the token at `<stateDir>/providers/antigravity/<sha256(instanceId)>/antigravity-acp/antigravity-oauth-token`.
   - Top-level `agy --print "/usage"` ignores `GEMINI_HOME` and only reads `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` (`%USERPROFILE%` on Windows).
   - `antigravityUsageLimits.ts` creates a scoped temp `HOME`, links `.gemini/antigravity-cli` to `<profile>/antigravity-acp` (junction on Windows), strips ambient credential/display variables, and sets `SSH_CONNECTION` + `AGY_CLI_DISABLE_AUTO_UPDATE=true`.
2. **Unauthenticated 60s hang**:
   - Without a valid token, `agy --print "/usage"` prints `Authentication required.` and blocks for ~60s even with `stdin: "ignore"`.
   - Pre-check `antigravity-oauth-token` existence before spawning, abort streams immediately upon seeing `Authentication required.`, and enforce a 15s timeout.
3. **Effect 4 `Cache.makeWith` & refresh cadence**:
   - Dynamic per-entry TTL requires `Cache.makeWith(lookup, { capacity, timeToLive })`; `Cache.make` only accepts a static `Duration`.
   - Successful reads are cached for 5 minutes; failures and missing tokens return `Duration.zero`.
   - Refreshes trigger on: initial server boot check, periodic `managedProvider` checks (5 min in `balanced` when foreground demand exists), opening the Usage page (5-min client throttle, invalidates cache), manual Refresh (invalidates cache), `onSessionStarted` when missing/failed, and `usage_limit` turn failures (`refreshUsage`). Normal turn completion does not re-probe.
4. **Sign-out cleanup**:
   - `publishEnrichedSnapshot` in `managedProvider.ts` must not carry forward `usageLimits` or `usageAuthLabel` when `auth.status === "unauthenticated"`.
5. **Floating-point rounding**:
   - IEEE-754 gives `(1 - 0.55) * 100 === 44.99999999999999`; round via `Math.round((1 - remaining_fraction) * 1_000_000) / 10_000`.
6. **Window ordering & model-group scoping**:
   - Display order is fixed to `gemini-5h` → `gemini-weekly` → `3p-5h` → `3p-weekly` in `displayLimitWindows`, `collectProviderUsageLimits`, and `antigravityUsageResponseToLimits`.
   - `exhaustedUsageWindow` scopes `gemini-*` to `gemini*` models and `3p-*` to non-Gemini models; `poolMember` suppresses only the matching group's `5h` window when its `weekly` window is exhausted.
   - Note: `AntigravityProvider.onSessionStarted` calls `managed.applyUsageLimits({ ...probed, complete: true })`, which re-sorts via `makeUsageLimits` (`kind`, then `id`). Web/Mobile UIs still render Gemini first through `displayLimitWindows` / `collectProviderUsageLimits`, whereas raw `t3_usage_limits_read` output can reflect `makeUsageLimits` ordering after `onSessionStarted`.

## 3. Live Runtime Build, Verify & Switch

Check `~/.t3/runtime/versions/` and increment `+darkpi.N`. The embedded `package.json` version **must** match the runtime directory name; otherwise `t3code.service` crash-loops with `"The service launcher started a different t3 version"`.

### Build, Install & Verify

```bash
cd ~/projects/t3code
VERSION="0.1.13-nightly.20261125.5258+darkpi.N"
PREV_VERSION="0.1.13-nightly.20261125.5258+darkpi.(N-1)"
export PATH="$PWD/node_modules/.bin:$HOME/.local/share/vite-plus/package_manager/pnpm/12.14.0/pnpm/bin:$(echo /nix/store/*-patchelf-*/bin | awk '{print $1}'):$PATH"

# Temporarily stamp package versions; always revert after building
trap 'git checkout -- . >/dev/null 2>&1 || true' EXIT
node scripts/update-release-package-versions.ts "$VERSION"
vp run --filter @t3tools/web --filter t3 build
node scripts/apply-web-brand-assets.ts production apps/server/dist/client
node apps/server/scripts/cli.ts build-exe
node scripts/build-cli-archive.ts \
  --platform linux --arch x64 --version "$VERSION" \
  --resource-monitor-dir "$HOME/.t3/runtime/versions/$PREV_VERSION/resource-monitor"
node scripts/smoke-cli-archive.ts --archive "release-cli/t3-${VERSION}-linux-x64.tar.gz" --expect-version "$VERSION"
git checkout -- .
trap - EXIT

# Atomic install into ~/.t3/runtime/versions/
DEST="$HOME/.t3/runtime/versions/$VERSION"
TMP_DEST="$HOME/.t3/runtime/versions/.$VERSION.tmp"
rm -rf "$TMP_DEST" "$DEST"
mkdir -p "$TMP_DEST"
tar -xzf "release-cli/t3-${VERSION}-linux-x64.tar.gz" --strip-components=1 -C "$TMP_DEST"
printf '%s' "$VERSION" > "$TMP_DEST/.install-complete"
mv "$TMP_DEST" "$DEST"
rm -rf release-cli

# Verify version & isolated launcher (port 39771)
"$DEST/t3" --version
~/projects/t3code-zh-tw/verify-launcher.sh "$VERSION" "$DEST"
```

### Mandatory Pre-Restart Check & Switch

1. **List all active threads across all projects** before restarting `t3code.service`:

   ```json
   t3_thread_list({
     "allProjects": true,
     "includeSubagents": true,
     "statuses": ["running", "waiting", "starting", "preparing", "queued"]
   })
   ```

   - **Always include `"waiting"`**. Parent threads waiting on subagents, delegated tasks, or PR watches have status `"waiting"`, not `"running"`.
   - Notify every active/waiting parent thread (parent threads speak for their delegates) to checkpoint and avoid launching new child work, and confirm timing with Darkpi.

2. **Schedule the switch via `systemd-run`** so the restart survives dropping the current T3 Code session:

   ```bash
   systemd-run --user --collect --unit=t3-switch-version --on-active=60s \
     ~/projects/t3code-zh-tw/switch-version.sh "$VERSION"
   ```

3. After restart, verify `serverVersion` via `t3_environment_read` and confirm affected features/threads are healthy.

## 4. Rebasing onto a New Nightly

Rebase with `jj rebase -s <first fork commit> -d <nightly tag>` and resolve bottom-up. Recurring conflict areas:

- `apps/server/src/provider/agentContextBudget.json`: conflicts on every rebase (`t3_usage_limits_read` adds 299 bytes to `mcpToolListJsonBytes`). Re-verify with `vp test run src/provider/AgentContextBudget.test.ts` inside `apps/server`.
- `pnpm-lock.yaml` on the `tk` tracker commit: fix on that commit with `vp i --fix-lockfile` (with `pnpm` on `PATH`).
- Translation catalogs (`en.json`, `zh.json`, `zh-TW.json`): both sides append keys at the end; keep both, then re-sync `zh-TW` with `bun regen.ts ~/projects/t3code` from `~/projects/t3code-zh-tw` and verify with `node scripts/i18n-check.ts`.
