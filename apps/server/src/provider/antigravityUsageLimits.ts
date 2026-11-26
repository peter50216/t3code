// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";

import type {
  AntigravityAuthMethod,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  ANTIGRAVITY_OAUTH_TOKEN_FILENAME,
  resolveAntigravityCaBundlePath,
  stripAntigravityAmbientEnvironment,
} from "./antigravityAuthSupport.ts";

const FIVE_HOURS_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const USAGE_PROBE_TIMEOUT = "15 seconds";
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const AUTH_REQUIRED_MARKER = "Authentication required.";

const AntigravityUsageBucket = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_time: Schema.optional(Schema.NullOr(Schema.String)),
});

const AntigravityUsageGroup = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  buckets: Schema.Array(AntigravityUsageBucket),
});

const AntigravityUsageCommandResponse = Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.NullOr(Schema.String)),
  command: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        data: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              groups: Schema.optional(Schema.Array(AntigravityUsageGroup)),
            }),
          ),
        ),
      }),
    ),
  ),
});
type AntigravityUsageCommandResponse = typeof AntigravityUsageCommandResponse.Type;

const decodeUsageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(AntigravityUsageCommandResponse),
);

class AntigravityUsageAuthRequired extends Schema.TaggedError<AntigravityUsageAuthRequired>()(
  "AntigravityUsageAuthRequired",
  {},
) {}

class AntigravityUsageOutputTooLarge extends Schema.TaggedError<AntigravityUsageOutputTooLarge>()(
  "AntigravityUsageOutputTooLarge",
  {},
) {}

class AntigravityUsageSymlinkError extends Schema.TaggedError<AntigravityUsageSymlinkError>()(
  "AntigravityUsageSymlinkError",
  { cause: Schema.Defect() },
) {}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function classifyBucketWindow(bucket: typeof AntigravityUsageBucket.Type): {
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly windowDurationMins?: number;
} {
  const token = (bucket.window ?? "").trim().toLowerCase();
  if (token === "5h" || token === "session" || /(?:^|[-_])5h$|five\s*hour/i.test(bucket.id)) {
    return { kind: "session", windowDurationMins: FIVE_HOURS_MINS };
  }
  if (token === "weekly" || token === "7d" || /(?:^|[-_])weekly$/i.test(bucket.id)) {
    return { kind: "weekly", windowDurationMins: WEEK_MINS };
  }
  if (token === "monthly") {
    return { kind: "monthly" };
  }
  return { kind: "other" };
}

function formatGroupPrefix(groupName: string): string {
  return groupName
    .trim()
    .replace(/\s+models$/i, "")
    .replace(/\s+and\s+/gi, " & ");
}

function formatBucketLabel(input: {
  readonly groupName: string;
  readonly groupCount: number;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly bucket: typeof AntigravityUsageBucket.Type;
}): string {
  const prefix = input.groupCount > 1 ? formatGroupPrefix(input.groupName) : "";
  if (prefix) {
    const suffix =
      input.kind === "session"
        ? "5h"
        : input.kind === "weekly"
          ? "Weekly"
          : input.kind === "monthly"
            ? "Monthly"
            : input.bucket.name?.trim() || input.bucket.id.trim();
    return `${prefix} ${suffix}`;
  }
  switch (input.kind) {
    case "session":
      return "Session";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "other":
      return input.bucket.name?.trim() || input.bucket.id.trim();
  }
}

export function antigravityUsageResponseToLimits(input: {
  readonly response: AntigravityUsageCommandResponse;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const { response, checkedAt } = input;
  const groups = response.command?.data?.groups;
  if (response.status !== "SUCCESS" || response.command?.name !== "usage" || !groups) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Antigravity could not read usage limits.",
    });
  }
  const seen = new Set<string>();
  const windows: ServerProviderUsageWindow[] = [];
  for (const group of groups) {
    for (const bucket of group.buckets) {
      const id = bucket.id.trim();
      if (!id || seen.has(id)) continue;
      if (
        typeof bucket.remaining_fraction !== "number" ||
        !Number.isFinite(bucket.remaining_fraction)
      ) {
        continue;
      }
      seen.add(id);
      const { kind, windowDurationMins } = classifyBucketWindow(bucket);
      const resetsAt = isoFromString(bucket.reset_time);
      const usedPercent = clampPercent(
        Math.round((1 - bucket.remaining_fraction) * 1_000_000) / 10_000,
      );
      windows.push({
        id,
        kind,
        label: formatBucketLabel({
          groupName: group.name,
          groupCount: groups.length,
          kind,
          bucket,
        }),
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
      });
    }
  }
  const windowRank = (window: ServerProviderUsageWindow) => {
    const groupRank = window.id.startsWith("gemini-") ? 0 : window.id.startsWith("3p-") ? 1 : 2;
    const kindRank =
      window.kind === "session"
        ? 0
        : window.kind === "weekly"
          ? 1
          : window.kind === "monthly"
            ? 2
            : 3;
    return groupRank * 4 + kindRank;
  };
  return {
    checkedAt,
    windows: windows.toSorted(
      (left, right) => windowRank(left) - windowRank(right) || left.id.localeCompare(right.id),
    ),
  };
}

export function parseAntigravityUsageOutput(
  stdout: string,
  checkedAt: string,
): ServerProviderUsageLimits {
  const trimmed = stdout.trim();
  const decoded = decodeUsageJson(trimmed).pipe(
    Option.orElse(() => {
      const lines = trimmed.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim() ?? "";
        if (!line.startsWith("{")) continue;
        const candidate = decodeUsageJson(line);
        if (Option.isSome(candidate)) return candidate;
      }
      return Option.none();
    }),
  );
  if (Option.isNone(decoded)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Antigravity could not read usage limits.",
    });
  }
  return antigravityUsageResponseToLimits({ response: decoded.value, checkedAt });
}

const collectGuardedOutput = Effect.fn("AntigravityUsageLimits.collectGuardedOutput")(function* (
  stream: ChildProcessSpawner.ChildProcessHandle["stdout"],
  maxBytes: number,
) {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let tail = "";
  const decoder = new TextDecoder();
  yield* stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          return yield* new AntigravityUsageOutputTooLarge();
        }
        chunks.push(chunk);
        const text = `${tail}${decoder.decode(chunk, { stream: true })}`;
        if (text.includes(AUTH_REQUIRED_MARKER)) {
          return yield* new AntigravityUsageAuthRequired();
        }
        tail = text.slice(-AUTH_REQUIRED_MARKER.length);
      }),
    ),
  );
  return Buffer.concat(chunks, totalBytes).toString("utf8");
});

/**
 * `agy --print "/usage" --output-format json` reads OAuth tokens from `$HOME/.gemini/antigravity-cli`,
 * whereas T3 isolates each instance under `<profile>/antigravity-acp`. Link a scoped temp HOME so
 * every Antigravity instance queries its own Google account without touching `~/.gemini`.
 */
export const probeAntigravityUsageLimits = Effect.fn("AntigravityUsageLimits.probe")(
  function* (input: {
    readonly executablePath: string;
    readonly profileDirectory: string;
    readonly tempDirectory: string;
    readonly authMethod: AntigravityAuthMethod;
    readonly baseEnv: NodeJS.ProcessEnv;
  }): Effect.fn.Return<
    ServerProviderUsageLimits | undefined,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod === "gemini-api-key" || input.authMethod === "agent-platform") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;

    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const tokenExists = yield* fs
      .exists(path.join(acpDirectory, ANTIGRAVITY_OAUTH_TOKEN_FILENAME))
      .pipe(Effect.orElseSucceed(() => false));
    if (!tokenExists) return undefined;

    const probeFailed = makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Antigravity could not read usage limits.",
    });

    return yield* Effect.gen(function* () {
      yield* fs.makeDirectory(input.tempDirectory, { recursive: true, mode: 0o700 });
      const usageHome = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: input.tempDirectory, prefix: "usage-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const geminiDir = path.join(usageHome, ".gemini");
      yield* fs.makeDirectory(geminiDir, { recursive: true, mode: 0o700 });
      yield* Effect.tryPromise({
        try: () =>
          NodeFSP.symlink(
            acpDirectory,
            path.join(geminiDir, "antigravity-cli"),
            platform === "win32" ? "junction" : "dir",
          ),
        catch: (cause) => new AntigravityUsageSymlinkError({ cause }),
      });

      const caBundlePath = yield* resolveAntigravityCaBundlePath(platform, input.baseEnv);
      const {
        DISPLAY: _display,
        WAYLAND_DISPLAY: _wayland,
        HOME: _home,
        USERPROFILE: _userProfile,
        ...cleanEnv
      } = stripAntigravityAmbientEnvironment(input.baseEnv);
      const env: NodeJS.ProcessEnv = {
        ...cleanEnv,
        ...(caBundlePath !== undefined &&
        input.baseEnv.SSL_CERT_FILE === undefined &&
        input.baseEnv.SSL_CERT_DIR === undefined
          ? { SSL_CERT_FILE: caBundlePath }
          : {}),
        HOME: usageHome,
        ...(platform === "win32"
          ? { USERPROFILE: usageHome, TEMP: usageHome, TMP: usageHome }
          : { TMPDIR: usageHome }),
        SSH_CONNECTION: input.baseEnv.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      };

      const child = yield* spawner.spawn(
        ChildProcess.make(input.executablePath, ["--print", "/usage", "--output-format", "json"], {
          cwd: usageHome,
          env,
          extendEnv: false,
          shell: false,
          stdin: "ignore",
        }),
      );

      const [stdout, _stderr, exitCode] = yield* Effect.all(
        [
          collectGuardedOutput(child.stdout, MAX_STDOUT_BYTES),
          collectGuardedOutput(child.stderr, MAX_STDERR_BYTES),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      if (Number(exitCode) !== 0) return probeFailed;
      return parseAntigravityUsageOutput(stdout, DateTime.formatIso(yield* DateTime.now));
    }).pipe(
      Effect.scoped,
      Effect.timeout(USAGE_PROBE_TIMEOUT),
      Effect.catchTags({
        AntigravityUsageAuthRequired: () =>
          Effect.succeed(
            makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: "Sign in to Antigravity to view usage limits.",
            }),
          ),
      }),
      Effect.orElseSucceed(() => probeFailed),
    );
  },
);
