import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ANTIGRAVITY_OAUTH_TOKEN_FILENAME } from "./antigravityAuthSupport.ts";
import {
  antigravityUsageResponseToLimits,
  parseAntigravityUsageOutput,
  probeAntigravityUsageLimits,
} from "./antigravityUsageLimits.ts";

const checkedAt = "2026-11-26T09:20:00.000Z";

const sampleResponse = {
  conversation_id: "",
  status: "SUCCESS",
  response: "",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.875,
              reset_time: "2026-12-03T07:05:13Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.55,
              reset_time: "2026-11-26T12:05:13Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-12-03T09:20:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.2,
              reset_time: "2026-11-26T14:20:00Z",
            },
          ],
        },
      ],
    },
  },
};

describe("antigravityUsageResponseToLimits", () => {
  it("maps multi-group 5h and weekly buckets to usage windows", () => {
    const limits = antigravityUsageResponseToLimits({
      response: sampleResponse,
      checkedAt,
    });
    expect(limits).toEqual({
      checkedAt,
      windows: [
        {
          id: "gemini-5h",
          kind: "session",
          label: "Gemini 5h",
          usedPercent: 45,
          windowDurationMins: 300,
          resetsAt: "2026-11-26T12:05:13.000Z",
        },
        {
          id: "gemini-weekly",
          kind: "weekly",
          label: "Gemini Weekly",
          usedPercent: 12.5,
          windowDurationMins: 10080,
          resetsAt: "2026-12-03T07:05:13.000Z",
        },
        {
          id: "3p-5h",
          kind: "session",
          label: "Claude & GPT 5h",
          usedPercent: 80,
          windowDurationMins: 300,
          resetsAt: "2026-11-26T14:20:00.000Z",
        },
        {
          id: "3p-weekly",
          kind: "weekly",
          label: "Claude & GPT Weekly",
          usedPercent: 0,
          windowDurationMins: 10080,
          resetsAt: "2026-12-03T09:20:00.000Z",
        },
      ],
    });
  });

  it("uses short session/weekly labels for a single group and clamps fractions", () => {
    const limits = antigravityUsageResponseToLimits({
      checkedAt,
      response: {
        status: "SUCCESS",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  { id: "gemini-5h", window: "5h", remaining_fraction: -0.2, reset_time: null },
                  { id: "gemini-weekly", window: "weekly", remaining_fraction: 1.5 },
                  { id: "missing", window: "5h", remaining_fraction: null },
                ],
              },
            ],
          },
        },
      },
    });
    expect(limits.windows).toEqual([
      {
        id: "gemini-5h",
        kind: "session",
        label: "Session",
        usedPercent: 100,
        windowDurationMins: 300,
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
      },
    ]);
  });

  it("returns probeFailed for error or non-usage payloads", () => {
    expect(
      antigravityUsageResponseToLimits({
        checkedAt,
        response: { status: "ERROR", error: "boom" },
      }).unavailable?.reason,
    ).toBe("probeFailed");
    expect(parseAntigravityUsageOutput("not json at all", checkedAt).unavailable?.reason).toBe(
      "probeFailed",
    );
  });

  it("parses JSON even when preceded by diagnostic lines", () => {
    const limits = parseAntigravityUsageOutput(
      `some warning line\n${JSON.stringify(sampleResponse)}\n`,
      checkedAt,
    );
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toHaveLength(4);
  });
});

it.layer(NodeServices.layer)("probeAntigravityUsageLimits", (it) => {
  it.effect("marks API-key and agent-platform auth unsupported without spawning", () =>
    Effect.gen(function* () {
      for (const authMethod of ["gemini-api-key", "agent-platform"] as const) {
        const limits = yield* probeAntigravityUsageLimits({
          executablePath: "/nonexistent/agy",
          profileDirectory: "/nonexistent/profile",
          tempDirectory: "/nonexistent/tmp",
          authMethod,
          baseEnv: {},
        });
        expect(limits?.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it.effect("returns undefined without spawning when the OAuth token file is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-usage-missing-" });
      const limits = yield* probeAntigravityUsageLimits({
        executablePath: "/nonexistent/agy",
        profileDirectory: root,
        tempDirectory: root,
        authMethod: "oauth-personal",
        baseEnv: {},
      });
      expect(limits).toBeUndefined();
    }),
  );

  it.effect("links the profile's antigravity-acp directory into a temp HOME and parses usage", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-usage-probe-" });
      const profileDir = path.join(root, "profile");
      const acpDir = path.join(profileDir, "antigravity-acp");
      const tempDir = path.join(root, "tmp");
      const fakeAgy = path.join(root, "agy");
      yield* fs.makeDirectory(acpDir, { recursive: true });
      yield* fs.writeFileString(path.join(acpDir, ANTIGRAVITY_OAUTH_TOKEN_FILENAME), "fixture");
      yield* fs.writeFileString(
        fakeAgy,
        [
          "#!/bin/sh",
          'if [ ! -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ]; then',
          '  echo "missing token in $HOME" >&2',
          "  exit 2",
          "fi",
          'if [ -n "$GEMINI_API_KEY" ] || [ -n "$DISPLAY" ]; then',
          '  echo "ambient env leaked" >&2',
          "  exit 3",
          "fi",
          `printf '%s\\n' '${JSON.stringify(sampleResponse)}'`,
          "",
        ].join("\n"),
      );
      yield* fs.chmod(fakeAgy, 0o755);

      const baseEnv = yield* HostProcess.Environment;
      const limits = yield* probeAntigravityUsageLimits({
        executablePath: fakeAgy,
        profileDirectory: profileDir,
        tempDirectory: tempDir,
        authMethod: "oauth-personal",
        baseEnv: {
          PATH: baseEnv.PATH,
          GEMINI_API_KEY: "must-strip",
          DISPLAY: ":0",
        },
      });
      expect(limits?.unavailable).toBeUndefined();
      expect(limits?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["gemini-5h", 45],
        ["gemini-weekly", 12.5],
        ["3p-5h", 80],
        ["3p-weekly", 0],
      ]);
      // Scoped temp HOME should be cleaned up.
      expect(yield* fs.readDirectory(tempDir)).toEqual([]);
    }),
  );

  it.effect("aborts promptly when the CLI asks for interactive authentication", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-usage-auth-" });
      const profileDir = path.join(root, "profile");
      const acpDir = path.join(profileDir, "antigravity-acp");
      const tempDir = path.join(root, "tmp");
      const fakeAgy = path.join(root, "agy");
      yield* fs.makeDirectory(acpDir, { recursive: true });
      yield* fs.writeFileString(path.join(acpDir, ANTIGRAVITY_OAUTH_TOKEN_FILENAME), "expired");
      yield* fs.writeFileString(
        fakeAgy,
        [
          "#!/bin/sh",
          'echo "Authentication required. Please visit the URL to log in:"',
          "sleep 30",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(fakeAgy, 0o755);

      const baseEnv = yield* HostProcess.Environment;
      const limits = yield* probeAntigravityUsageLimits({
        executablePath: fakeAgy,
        profileDirectory: profileDir,
        tempDirectory: tempDir,
        authMethod: "oauth-personal",
        baseEnv: { PATH: baseEnv.PATH },
      });
      expect(limits?.unavailable).toEqual({
        reason: "probeFailed",
        message: "Sign in to Antigravity to view usage limits.",
      });
    }),
  );
});
