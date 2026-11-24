import {
  TerminalRunCommandError,
  type TerminalRunCommandInput,
  type TerminalRunCommandResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { ProcessRunner } from "../processRunner.ts";

const RUN_COMMAND_TIMEOUT = "2 minutes";
// The composer keeps at most 64,000 characters of one terminal context.
const RUN_COMMAND_MAX_OUTPUT_BYTES = 48 * 1024;
const TRUNCATED_MARKER = "\n[output truncated]";

export function runCommandShell(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (platform === "win32") {
    return { command: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { command: env.SHELL ?? "/bin/sh", args: ["-c", command] };
}

/** Runs one non-interactive shell command for a composer `!` line. */
export const runTerminalCommand = Effect.fn("TerminalRunCommand.run")(function* (
  input: TerminalRunCommandInput,
) {
  const runner = yield* ProcessRunner;
  const shell = runCommandShell(
    input.command,
    yield* HostProcess.Platform,
    yield* HostProcess.Environment,
  );
  const output = yield* runner
    .run({
      ...shell,
      cwd: input.cwd,
      ...(input.env !== undefined ? { env: input.env } : {}),
      // An empty stdin ends commands that read it instead of holding them until the timeout.
      stdin: "",
      timeout: RUN_COMMAND_TIMEOUT,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: RUN_COMMAND_MAX_OUTPUT_BYTES,
      outputMode: "truncate",
      truncatedMarker: TRUNCATED_MARKER,
    })
    .pipe(
      Effect.mapError(
        (error) => new TerminalRunCommandError({ cwd: input.cwd, detail: error.message }),
      ),
    );
  return {
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: output.code === null ? null : Number(output.code),
    timedOut: output.timedOut,
    truncated: output.stdoutTruncated || output.stderrTruncated,
  } satisfies TerminalRunCommandResult;
});
