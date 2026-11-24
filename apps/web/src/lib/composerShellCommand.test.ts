import { COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS } from "@t3tools/contracts";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { parseComposerShellCommandLine, shellCommandTerminalContext } from "./composerShellCommand";
import { formatTerminalContextReference } from "./terminalContext";

const chip = formatTerminalContextReference({
  id: "context-1",
  terminalLabel: "! git status",
  lineStart: 1,
  lineEnd: 3,
});
const imageChip = formatComposerContextReference({
  kind: "image",
  contextId: toKindScopedComposerContextId("image", "abc"),
  label: "shot.png",
});

const result = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  truncated: false,
};

describe("parseComposerShellCommandLine", () => {
  it("reads a command after the bang", () => {
    expect(parseComposerShellCommandLine("! git status")).toEqual({
      command: "git status",
      remainingPrompt: "",
    });
    expect(parseComposerShellCommandLine("  !ls\n-la  ")).toEqual({
      command: "ls\n-la",
      remainingPrompt: "",
    });
  });

  it("keeps the context chips before the bang", () => {
    expect(parseComposerShellCommandLine(`${chip}\n! git log -1`)).toEqual({
      command: "git log -1",
      remainingPrompt: chip,
    });
  });

  it("sends a normal message", () => {
    expect(parseComposerShellCommandLine("hello ! there")).toBeNull();
    expect(parseComposerShellCommandLine("!")).toBeNull();
    expect(parseComposerShellCommandLine("!   ")).toBeNull();
    expect(parseComposerShellCommandLine(`explain ${chip}\n! ls`)).toBeNull();
    expect(parseComposerShellCommandLine(`${chip} what does this mean?`)).toBeNull();
  });

  it("does not read an image chip as a command", () => {
    expect(parseComposerShellCommandLine(imageChip)).toBeNull();
    expect(parseComposerShellCommandLine(`${imageChip} what is this?`)).toBeNull();
  });
});

describe("shellCommandTerminalContext", () => {
  it("puts the command, stdout and stderr in one excerpt", () => {
    const context = shellCommandTerminalContext("run-1", "git status", {
      ...result,
      stdout: "On branch main\r\nclean\n",
      stderr: "warning\n",
    });
    expect(context.text).toBe("$ git status\nOn branch main\nclean\nwarning");
    expect(context.terminalLabel).toBe("! git status");
    expect(context.lineStart).toBe(1);
    expect(context.lineEnd).toBe(4);
  });

  it("adds the status when the command did not exit with 0", () => {
    expect(shellCommandTerminalContext("run-1", "false", { ...result, exitCode: 1 }).text).toBe(
      "$ false\n[exit code 1]",
    );
    expect(
      shellCommandTerminalContext("run-1", "sleep 999", {
        ...result,
        exitCode: null,
        timedOut: true,
      }).text,
    ).toBe("$ sleep 999\n[timed out]");
  });

  it("shortens a long or multi-line command in the label", () => {
    expect(shellCommandTerminalContext("run-1", "echo a\necho b", result).terminalLabel).toBe(
      "! echo a…",
    );
    const label = shellCommandTerminalContext("run-1", "x".repeat(200), result).terminalLabel;
    expect(label.length).toBeLessThanOrEqual(82);
    expect(label.endsWith("…")).toBe(true);
  });

  it("stays inside the composer's terminal context limit", () => {
    const context = shellCommandTerminalContext("run-1", "cat big", {
      ...result,
      stdout: "y\n".repeat(COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS),
    });
    expect(context.text.length).toBe(COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS);
    expect(context.text.endsWith("[output truncated]")).toBe(true);
    expect(context.lineEnd).toBe(context.text.split("\n").length);
  });
});
