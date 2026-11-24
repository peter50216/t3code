import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthTerminalOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { composerTargetKey, type ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import {
  parseComposerShellCommandLine,
  shellCommandTerminalContext,
} from "../../lib/composerShellCommand";
import { readEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  cancelHeldComposerSend,
  joinPreparedImagesToDraft,
  trackRunningShellCommand,
} from "./preparingComposerImages";

interface ComposerShellCommandInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly projectRoot: string | null;
  readonly worktreePath: string | null;
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
}

/**
 * Runs a draft's `! <command>` on the environment server and attaches the output to the draft
 * as terminal context. Returns false for a draft that is not a shell command line.
 * `replaceDraft` takes the `! <command>` text out of the draft before the command runs.
 * A send made while the command runs waits for its output, and is cancelled without it.
 */
export function useComposerShellCommand(input: ComposerShellCommandInput) {
  const runCommand = useAtomCommand(terminalEnvironment.runCommand, {
    label: "composer shell command",
    reportFailure: false,
  });

  return (prompt: string, replaceDraft: (prompt: string) => void): boolean => {
    const line = parseComposerShellCommandLine(prompt);
    if (line === null || input.projectRoot === null) return false;
    const { environmentId, routeThreadKey, currentRouteThreadKeyRef, composerRef } = input;
    if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: m(msg("Command not run")),
          description: m(msg("You do not have permission to run commands in this environment.")),
        }),
      );
      return true;
    }

    replaceDraft(line.remainingPrompt);
    const targetKey = composerTargetKey(input.composerDraftTarget);
    const finishRunning = trackRunningShellCommand(targetKey, line.command);

    void runCommand({
      environmentId,
      input: {
        cwd: projectScriptCwd({
          project: { cwd: input.projectRoot },
          worktreePath: input.worktreePath,
        }),
        command: line.command,
        env: projectScriptRuntimeEnv({
          project: { cwd: input.projectRoot },
          worktreePath: input.worktreePath,
        }),
      },
    })
      .then((result) => {
        if (result._tag === "Failure") {
          cancelHeldComposerSend(targetKey);
          if (isAtomCommandInterrupted(result)) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: m(msg("Command failed to run")),
              description:
                thrownErrorMessage(squashAtomCommandFailure(result), m) ??
                m(msg("An error occurred.")),
            }),
          );
          return;
        }
        // The composer on screen belongs to another thread once the user leaves this one.
        if (currentRouteThreadKeyRef.current !== routeThreadKey) {
          cancelHeldComposerSend(targetKey);
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: m(msg("Command output not attached")),
              description: m(msg("You left the thread before the command finished.")),
            }),
          );
          return;
        }
        const context = shellCommandTerminalContext(randomUUID(), line.command, result.value);
        joinPreparedImagesToDraft(() => composerRef.current?.addTerminalContext(context));
      })
      .finally(finishRunning);
    return true;
  };
}
