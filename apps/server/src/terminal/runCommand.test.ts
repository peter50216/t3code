import { TerminalRunCommandError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import { runCommandShell, runTerminalCommand } from "./runCommand.ts";

describe("runCommandShell", () => {
  it("runs the command with the user's shell on POSIX", () => {
    expect(runCommandShell("ls -la", "linux", { SHELL: "/usr/bin/zsh" })).toEqual({
      command: "/usr/bin/zsh",
      args: ["-c", "ls -la"],
    });
    expect(runCommandShell("ls", "darwin", {})).toEqual({ command: "/bin/sh", args: ["-c", "ls"] });
  });

  it("runs the command with cmd.exe on Windows", () => {
    expect(runCommandShell("dir", "win32", {})).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "dir"],
    });
  });
});

describe("runTerminalCommand", () => {
  it.effect("closes stdin, bounds the run, and reports the exit code", () => {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) => {
        calls.push(input);
        return Effect.succeed({
          stdout: "out\n",
          stderr: "err\n",
          code: ChildProcessSpawner.ExitCode(2),
          timedOut: false,
          stdoutTruncated: true,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      },
    });
    return Effect.gen(function* () {
      const result = yield* runTerminalCommand({
        cwd: "/repo",
        command: "make test",
        env: { T3CODE_PROJECT_ROOT: "/repo" },
      }).pipe(Effect.provide(runner));
      expect(result).toEqual({
        stdout: "out\n",
        stderr: "err\n",
        exitCode: 2,
        timedOut: false,
        truncated: true,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        cwd: "/repo",
        env: { T3CODE_PROJECT_ROOT: "/repo" },
        stdin: "",
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
      });
      expect(calls[0]!.args.at(-1)).toBe("make test");
    });
  });

  it.effect("reports a spawn failure as a terminal error", () => {
    const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cwd: input.cwd,
            cause: new Error("ENOENT"),
          }),
        ),
    });
    return Effect.gen(function* () {
      const error = yield* runTerminalCommand({ cwd: "/missing", command: "ls" }).pipe(
        Effect.provide(runner),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(TerminalRunCommandError);
      expect(error.cwd).toBe("/missing");
    });
  });
});
