import { msg, useGT } from "gt-react";

import { composerTargetKey, type ComposerThreadTarget } from "../../composerDraftStore";
import { m, type MessageResolver } from "../../i18n/messages";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  usePreparingComposerImages,
  useRunningShellCommands,
  type RunningShellCommand,
} from "./preparingComposerImages";

export const HELD_COMPOSER_SEND_BANNER_ID = "held-composer-send";

function HeldComposerSendStatus({ draftTarget }: { readonly draftTarget: ComposerThreadTarget }) {
  const gt = useGT();
  const targetKey = composerTargetKey(draftTarget);
  const preparingCount = usePreparingComposerImages(targetKey).length;
  const runningCount = useRunningShellCommands(targetKey).length;
  const label =
    preparingCount > 0
      ? gt(
          "{count, plural, one {Sending once image is ready} other {Sending once {count} images are ready}}",
          { count: preparingCount },
        )
      : runningCount > 0
        ? gt(
            "{count, plural, one {Sending once the command finishes} other {Sending once {count} commands finish}}",
            { count: runningCount },
          )
        : gt("Sending message");
  return <span aria-live="polite">{label}</span>;
}

const RUNNING_SHELL_COMMANDS_BANNER_ID = "running-shell-commands";

/** Shown while composer `!` commands run; their output joins the draft when each one ends. */
export function runningShellCommandsBannerItem(
  commands: ReadonlyArray<RunningShellCommand>,
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  return {
    id: RUNNING_SHELL_COMMANDS_BANNER_ID,
    variant: "info",
    icon: <Spinner size="xs" aria-hidden="true" />,
    title: (
      <span aria-live="polite">
        {resolve(
          msg("{count, plural, one {Running command} other {Running {count} commands}}", {
            count: commands.length,
          }),
        )}
      </span>
    ),
    description: (
      <span className="block font-mono [overflow-wrap:anywhere]">
        {commands.map((running) => (
          <span key={running.id} className="block truncate">
            {`! ${running.command.split("\n", 1)[0]}`}
          </span>
        ))}
      </span>
    ),
  };
}

/** Shown while a send waits for pasted or dropped images to finish compressing. */
export function heldComposerSendBannerItem(
  input: {
    readonly draftTarget: ComposerThreadTarget;
    readonly onCancel: () => void;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  return {
    id: HELD_COMPOSER_SEND_BANNER_ID,
    variant: "info",
    icon: <Spinner size="xs" aria-hidden="true" />,
    title: <HeldComposerSendStatus draftTarget={input.draftTarget} />,
    description: resolve(msg("Edit or press Esc to cancel")),
    actions: (
      <Button
        size="xs"
        variant="ghost"
        onPointerDown={(event) => event.preventDefault()}
        onClick={input.onCancel}
      >
        {resolve(msg("Cancel"))}
      </Button>
    ),
  };
}
