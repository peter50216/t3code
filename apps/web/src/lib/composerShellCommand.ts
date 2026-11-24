import {
  COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
  type TerminalRunCommandResult,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";

import type { TerminalContextSelection } from "./terminalContext";

const LABEL_MAX_CHARS = 80;
const TRUNCATED_MARKER = "\n[output truncated]";

export interface ComposerShellCommandLine {
  readonly command: string;
  /** The context chips before the `!`, which stay in the draft. */
  readonly remainingPrompt: string;
}

/** A draft of context chips followed by `! <command>` runs `<command>` instead of sending. */
export function parseComposerShellCommandLine(prompt: string): ComposerShellCommandLine | null {
  const headEnd = collectComposerContextReferences(prompt).at(-1)?.end ?? 0;
  const head = prompt.slice(0, headEnd);
  if (replaceComposerContextReferences(head, () => "").trim() !== "") return null;
  const tail = prompt.slice(headEnd).trimStart();
  if (!tail.startsWith("!")) return null;
  const command = tail.slice(1).trim();
  if (command === "") return null;
  return { command, remainingPrompt: head };
}

function shellCommandLabel(command: string): string {
  const clipped = command
    .split("\n", 1)[0]!
    .trim()
    .slice(0, LABEL_MAX_CHARS - 1);
  return `! ${clipped}${clipped === command ? "" : "…"}`;
}

/**
 * The command line, its output, and a status line when it did not exit with 0.
 * Each run needs its own `runId`: the draft drops a context whose terminal and lines repeat.
 */
export function shellCommandTerminalContext(
  runId: string,
  command: string,
  result: TerminalRunCommandResult,
): TerminalContextSelection {
  const sections = [`$ ${command}`];
  for (const output of [result.stdout, result.stderr]) {
    const trimmed = output.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    if (trimmed !== "") sections.push(trimmed);
  }
  if (result.timedOut) sections.push("[timed out]");
  else if (result.exitCode !== 0) sections.push(`[exit code ${result.exitCode ?? "unknown"}]`);
  let text = sections.join("\n");
  if (text.length > COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS) {
    text =
      text.slice(0, COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS - TRUNCATED_MARKER.length) +
      TRUNCATED_MARKER;
  }
  return {
    terminalId: `composer-shell-command:${runId}`,
    terminalLabel: shellCommandLabel(command),
    lineStart: 1,
    lineEnd: text.split("\n").length,
    text,
  };
}
