import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IssueTrackerKind } from "@t3tools/contracts";
import * as LinearDriver from "@t3tools/issue-tracker-linear/server/driver";
import * as TkIssueTracker from "@t3tools/issue-tracker-tk/server/TkIssueTracker";
import {
  isStandaloneIssueTracker,
  isWorkspaceIssueTracker,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
  type WorkspaceIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as IssueTrackerHostLive from "./IssueTrackerHostLive.ts";

export class IssueTrackerRegistry extends Context.Service<
  IssueTrackerRegistry,
  {
    /** Null for a kind with no implementation, which the service reports as unsupported. */
    readonly get: (kind: IssueTrackerKind) => IssueTrackerApi | null;
    readonly kinds: ReadonlyArray<IssueTrackerKind>;
    /** The trackers a user connects with a credential of their own, in registration order. */
    readonly standalone: ReadonlyArray<StandaloneIssueTrackerApi>;
    /** The trackers kept in a project's own files, offered wherever a project root holds one. */
    readonly workspace: ReadonlyArray<WorkspaceIssueTrackerApi>;
  }
>()("t3/issue/IssueTrackerRegistry") {}

/** Exported for tests, which stand a registry up from trackers they supply themselves. */
export function fromTrackers(
  trackers: ReadonlyArray<IssueTrackerApi>,
): IssueTrackerRegistry["Service"] {
  const byKind = new Map(trackers.map((tracker) => [tracker.kind, tracker]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: trackers.map((tracker) => tracker.kind),
    standalone: trackers.filter(isStandaloneIssueTracker),
    workspace: trackers.filter(isWorkspaceIssueTracker),
  };
}

/** Trackers that are not a git host's own. Each signs requests with a credential from Settings. */
const STANDALONE_TRACKERS = [LinearDriver.make];

/** Trackers kept in the project's own files. Each needs no credential. */
const WORKSPACE_TRACKERS = [TkIssueTracker.make];

const make = Effect.gen(function* () {
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const standalone = yield* Effect.all(STANDALONE_TRACKERS);
  const workspace = yield* Effect.all(WORKSPACE_TRACKERS);
  return fromTrackers([
    ...drivers.flatMap(({ instance }) => instance.issues ?? []),
    ...standalone,
    ...workspace,
  ]);
});

export const layer = Layer.effect(IssueTrackerRegistry, make).pipe(
  Layer.provide(Layer.merge(BuiltInDrivers.layer, IssueTrackerHostLive.layer)),
);
