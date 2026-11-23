import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as TkIssueTracker from "./TkIssueTracker.ts";

const BLOCKED = `---
id: db-0w04
status: in_progress
deps: []
links: []
created: 2026-09-08T06:03:22Z
type: bug
priority: 1
assignee: Peter Shih
tags: [ui, backend]
---
# Shop rerolls cost too much

Rerolls drain gold.

## Acceptance Criteria

Cheaper rerolls.

## Notes

**2026-09-08T06:39:49Z**

First pass.

**2026-09-08T06:43:47Z**

Second pass.
`;

const DONE = `---
id: db-0mgz
status: closed
created: 2026-09-01T00:00:00Z
type: task
priority: 2
---
# Ship the catalog
`;

type Run = SourceControlHost.SourceControlHost["Service"]["process"]["run"];
type RunInput = Parameters<Run>[0];

/** A project root with the given tickets, a tracker over it, and every `tk` run it made. */
const setup = (tickets: Record<string, string>, run?: (input: RunInput) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, ".tickets"));
    for (const [name, source] of Object.entries(tickets)) {
      yield* fs.writeFileString(path.join(root, ".tickets", name), source);
    }
    const runs: RunInput[] = [];
    const tracker = yield* TkIssueTracker.make.pipe(
      Effect.provide(
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              runs.push(input);
              return Effect.succeed(TestSourceControlHost.processOutput(run?.(input) ?? ""));
            },
          },
          git: { readConfigValue: () => Effect.succeed("Peter Shih") },
        }),
      ),
    );
    return { root, path, tracker, runs };
  });

const target = (root: string) => ({ cwd: root, host: TkIssueTracker.HOST, scope: "~/game" });
const listAll = { state: "all", involvement: "all", limit: 50, sort: "updated" } as const;

it.layer(NodeServices.layer)("TkIssueTracker", (it) => {
  it.effect("reads a ticket's fields, body and notes as tk writes them", () =>
    Effect.gen(function* () {
      const { root, tracker } = yield* setup({ "db-0w04.md": BLOCKED });
      const issue = yield* tracker.getIssue({ ...target(root), key: "db-0w04" });
      expect(issue).toMatchObject({
        key: "db-0w04",
        title: "Shop rerolls cost too much",
        body: "Rerolls drain gold.\n\n## Acceptance Criteria\n\nCheaper rerolls.",
        state: { category: "open", name: "In Progress" },
        createdAt: "2026-09-08T06:03:22.000Z",
        assignees: [{ login: "Peter Shih" }],
        labels: [{ name: "ui" }, { name: "backend" }, { name: "bug" }, { name: "P1" }],
        commentCount: 2,
      });
      expect(issue.comments.map(({ createdAt, body }) => ({ createdAt, body }))).toEqual([
        { createdAt: "2026-09-08T06:39:49.000Z", body: "First pass." },
        { createdAt: "2026-09-08T06:43:47.000Z", body: "Second pass." },
      ]);
      expect(issue.states.map((state) => state.name)).toEqual(["Open", "In Progress", "Closed"]);
    }),
  );

  it.effect("filters a listing by state, text, assignment and label, and pages it", () =>
    Effect.gen(function* () {
      const { root, tracker } = yield* setup({
        "db-0w04.md": BLOCKED,
        "db-0mgz.md": DONE,
        "README.md": "Not a ticket.",
      });
      const keys = (input: Partial<Parameters<typeof tracker.listIssues>[0]>) =>
        tracker
          .listIssues({ ...target(root), ...listAll, ...input } as Parameters<
            typeof tracker.listIssues
          >[0])
          .pipe(Effect.map((page) => page.items.map((item) => item.key)));

      expect((yield* keys({ sort: "created" })).sort()).toEqual(["db-0mgz", "db-0w04"]);
      expect(yield* keys({ state: "open" })).toEqual(["db-0w04"]);
      expect(yield* keys({ state: "closed" })).toEqual(["db-0mgz"]);
      expect(yield* keys({ query: "CATALOG" })).toEqual(["db-0mgz"]);
      expect(yield* keys({ involvement: "assigned", viewer: "Peter Shih" })).toEqual(["db-0w04"]);
      expect(yield* keys({ involvement: "authored", viewer: "Peter Shih" })).toEqual([]);
      expect(yield* keys({ labels: ["P1", "UI"] })).toEqual(["db-0w04"]);

      const first = yield* tracker.listIssues({ ...target(root), ...listAll, limit: 1 });
      const second = yield* tracker.listIssues({
        ...target(root),
        ...listAll,
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(first.nextCursor).toBe("1");
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map((item) => item.key).sort()).toEqual([
        "db-0mgz",
        "db-0w04",
      ]);
    }),
  );

  it.effect("refuses a key that is not a ticket file in the directory", () =>
    Effect.gen(function* () {
      const { root, tracker } = yield* setup({ "db-0w04.md": BLOCKED });
      for (const key of ["../db-0w04", "0w04", "db-missing"]) {
        const error = yield* Effect.flip(tracker.getIssue({ ...target(root), key }));
        expect(error.reason).toBe("not-found");
      }
      const comment = yield* Effect.flip(
        tracker.comment!({ ...target(root), key: "0w04", body: "Partial ids reach tk." }),
      );
      expect(comment.reason).toBe("not-found");
    }),
  );

  it.effect("writes through tk with the project's own tickets directory", () =>
    Effect.gen(function* () {
      const { root, path, tracker, runs } = yield* setup({ "db-0w04.md": BLOCKED }, (input) =>
        input.args[0] === "create" ? "db-new1\n" : "",
      );
      yield* tracker.setState!({ ...target(root), key: "db-0w04", state: "In Progress" });
      yield* tracker.comment!({ ...target(root), key: "db-0w04", body: "--not an option" });
      const created = yield* tracker.create!({
        ...target(root),
        title: "New ticket",
        body: "Details",
        labels: ["ui"],
        assignees: [],
      });

      expect(runs.map(({ command, args, stdin }) => ({ command, args, stdin }))).toEqual([
        { command: "tk", args: ["status", "db-0w04", "in_progress"], stdin: undefined },
        { command: "tk", args: ["add-note", "db-0w04"], stdin: "--not an option" },
        { command: "tk", args: ["create", "New ticket", "-d", "Details", "--tags", "ui"] },
      ]);
      expect(runs.every((input) => input.env?.TICKETS_DIR === path.join(root, ".tickets"))).toBe(
        true,
      );
      expect(created.key).toBe("db-new1");
      expect(created.url.endsWith("/.tickets/db-new1.md")).toBe(true);

      const unknown = yield* Effect.flip(
        tracker.setState!({ ...target(root), key: "db-0w04", state: "Blocked" }),
      );
      expect(unknown.detail).toContain("Blocked");
      expect(runs).toHaveLength(3);
    }),
  );

  it.effect("reports a server without tk as a missing tool", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const tracker = yield* TkIssueTracker.make.pipe(
        Effect.provide(
          TestSourceControlHost.layer({
            process: {
              run: (input) =>
                Effect.fail(
                  new VcsProcessSpawnError({
                    operation: input.operation,
                    command: input.command,
                    cwd: input.cwd,
                    cause: PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                    }),
                  }),
                ),
            },
          }),
        ),
      );
      const error = yield* Effect.flip(
        tracker.create!({ ...target(root), title: "x", body: "", labels: [], assignees: [] }),
      );
      expect(error.reason).toBe("missing-tool");
    }),
  );

  it.effect("offers a scope only for a root that holds a tickets directory", () =>
    Effect.gen(function* () {
      const { root, tracker } = yield* setup({});
      const fs = yield* FileSystem.FileSystem;
      const bare = yield* fs.makeTempDirectoryScoped();
      expect(yield* tracker.workspace.scope(root)).toBe(root);
      expect(yield* tracker.workspace.scope(bare)).toBeNull();
    }),
  );

  it.effect("names a scope under the home directory from home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(TkIssueTracker.scopeFor(path, "/home/a/projects/game", "/home/a")).toBe(
        "~/projects/game",
      );
      expect(TkIssueTracker.scopeFor(path, "/srv/game", "/home/a")).toBe("/srv/game");
    }),
  );
});
