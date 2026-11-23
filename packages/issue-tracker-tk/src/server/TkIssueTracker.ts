/**
 * tk's local tickets as an issue tracker. A project's tickets are the markdown files in the
 * `.tickets` directory at its root. Reads parse those files; writes run the `tk` CLI, so a ticket
 * changes exactly as the user's own `tk` would change it.
 */
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parse as parseYaml } from "yaml";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueComment,
  type IssueLabel,
  type IssueState,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import { isMissingExecutable } from "@t3tools/source-control-core/server/discovery";
import {
  IssueTrackerError,
  type IssueInvolvementFilter,
  type TrackerIssueDetail,
  type TrackerIssueSummary,
  type WorkspaceIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import { SourceControlHost } from "@t3tools/source-control-core/server/SourceControlHost";

export const KIND = IssueTrackerKind.make("tk");
export const HOST = "local";
const TICKETS_DIR = ".tickets";

/** The `tk` CLI edits only status, notes and new tickets; the rest is edited in the file. */
const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: false,
  comment: true,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: false,
  labels: false,
  assignees: false,
};

/** tk's statuses in workflow order, under the names people read and `setState` asks for. */
const STATUSES: ReadonlyArray<{ readonly status: string; readonly state: IssueState }> = [
  { status: "open", state: { category: "open", name: "Open" } },
  { status: "in_progress", state: { category: "open", name: "In Progress" } },
  { status: "closed", state: { category: "closed", name: "Closed", closeReason: "completed" } },
];

/** The id tk names the file by. A strict shape also keeps a key from leaving the directory. */
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NOTES_HEADING = /^## Notes[ \t]*$/m;
/** tk's `add-note` opens each note with its UTC time in bold on a line of its own. */
const NOTE_STAMP = /^\*\*(\d{4}-\d{2}-\d{2}T[^*\s]+)\*\*[ \t]*$/m;
const READ_CONCURRENCY = 16;
const UNKNOWN_TIME = "1970-01-01T00:00:00.000Z";

export interface Ticket {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly description: string;
  readonly notes: ReadonlyArray<{ readonly createdAt: string; readonly body: string }>;
  readonly created: string | null;
  readonly type: string | null;
  readonly priority: string | null;
  readonly assignee: string | null;
  readonly tags: ReadonlyArray<string>;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function isoTime(value: string | null): string | null {
  if (value === null) return null;
  return Option.getOrNull(Option.map(DateTime.make(value), DateTime.formatIso));
}

/** A ticket file's contents, or null when it is not one tk wrote. `id` is the file's name. */
export function parseTicket(id: string, source: string): Ticket | null {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const close = lines.indexOf("---", 1);
  if (close === -1) return null;
  let front: unknown;
  try {
    front = parseYaml(lines.slice(1, close).join("\n"));
  } catch {
    return null;
  }
  if (typeof front !== "object" || front === null) return null;
  const fields = front as Record<string, unknown>;

  const rest = lines.slice(close + 1);
  const titleAt = rest.findIndex((line) => line.startsWith("# "));
  const title = titleAt === -1 ? "" : rest[titleAt]!.slice(2).trim();
  const content = rest.slice(titleAt + 1).join("\n");
  const [description = "", notesText = ""] = content.split(NOTES_HEADING);
  // Split with a capture group: [before, stamp, body, stamp, body, ...].
  const parts = notesText.split(NOTE_STAMP);
  const notes: Array<{ createdAt: string; body: string }> = [];
  for (let index = 1; index + 1 < parts.length; index += 2) {
    const createdAt = isoTime(parts[index]!);
    if (createdAt !== null) notes.push({ createdAt, body: parts[index + 1]!.trim() });
  }
  const tags = Array.isArray(fields.tags)
    ? fields.tags.flatMap((tag) => text(tag) ?? [])
    : (text(fields.tags)
        ?.split(",")
        .map((tag) => tag.trim())
        .filter(Boolean) ?? []);

  return {
    id,
    status: text(fields.status) ?? "open",
    title,
    description: description.trim(),
    notes,
    created: isoTime(text(fields.created)),
    type: text(fields.type),
    priority: text(fields.priority),
    assignee: text(fields.assignee),
    tags,
  };
}

function stateOf(status: string): IssueState {
  return (
    STATUSES.find((entry) => entry.status === status)?.state ?? { category: "open", name: status }
  );
}

/** Tags, then the type and priority tk files every ticket under, so a list shows them too. */
function labelsOf(ticket: Ticket): ReadonlyArray<IssueLabel> {
  const names = [
    ...ticket.tags,
    ...(ticket.type === null ? [] : [ticket.type]),
    ...(ticket.priority === null ? [] : [`P${ticket.priority}`]),
  ];
  return [...new Set(names)].map((name) => ({ name, color: null }));
}

interface TicketFile {
  readonly ticket: Ticket;
  readonly file: string;
  readonly modifiedAt: string;
}

function toSummary({ ticket, file, modifiedAt }: TicketFile): TrackerIssueSummary {
  const state = stateOf(ticket.status);
  return {
    key: ticket.id,
    displayKey: ticket.id,
    title: ticket.title || ticket.id,
    url: NodeURL.pathToFileURL(file).href,
    author: null,
    state,
    createdAt: ticket.created ?? modifiedAt,
    updatedAt: modifiedAt,
    closedAt: state.category === "closed" ? modifiedAt : null,
    assignees:
      ticket.assignee === null
        ? []
        : [{ login: ticket.assignee, name: ticket.assignee, avatarUrl: null }],
    labels: labelsOf(ticket),
    commentCount: ticket.notes.length,
  };
}

function matches(
  { ticket }: TicketFile,
  filter: IssueInvolvementFilter & {
    readonly query?: string | undefined;
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignee?: string | undefined;
  },
): boolean {
  // tk records no author and no mentions, so only an assignment can involve the viewer.
  if (filter.involvement !== "all") {
    if (filter.involvement !== "assigned" || ticket.assignee !== filter.viewer) return false;
  }
  if (filter.assignee !== undefined && ticket.assignee !== filter.assignee) return false;
  if (filter.labels !== undefined && filter.labels.length > 0) {
    const names = new Set(labelsOf(ticket).map((label) => label.name.toLowerCase()));
    if (!filter.labels.every((label) => names.has(label.toLowerCase()))) return false;
  }
  const query = filter.query?.trim().toLowerCase();
  if (query) {
    const haystack = `${ticket.id}\n${ticket.title}\n${ticket.description}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

/** Where a project's tickets show as a scope: under `~` when in the home directory. */
export function scopeFor(
  path: Pick<Path.Path, "relative" | "isAbsolute" | "sep">,
  workspaceRoot: string,
  home: string,
): string {
  const relative = path.relative(home, workspaceRoot);
  if (relative === "") return "~";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return workspaceRoot;
  return `~/${relative.split(path.sep).join("/")}`;
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* SourceControlHost;

  const fail = (
    operation: string,
    reason: IssueTrackerError["reason"],
    detail: string,
    cause?: unknown,
  ) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const ticketsDir = (cwd: string) => path.join(cwd, TICKETS_DIR);

  // Untraced: a listing reads every ticket file, under the listing's own span.
  const readTicket = Effect.fnUntraced(
    function* (_operation: string, cwd: string, id: string) {
      const file = path.join(ticketsDir(cwd), `${id}.md`);
      const [source, info] = yield* Effect.all([fs.readFileString(file), fs.stat(file)]);
      const ticket = parseTicket(id, source);
      if (ticket === null) return null;
      const modifiedAt = Option.match(info.mtime, {
        onNone: () => UNKNOWN_TIME,
        onSome: (date) => DateTime.formatIso(DateTime.fromDateUnsafe(date)),
      });
      return { ticket, file, modifiedAt } satisfies TicketFile;
    },
    (effect, operation, _cwd, id) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause.reason._tag === "NotFound"
            ? fail(operation, "not-found", `Ticket ${id} does not exist.`, cause)
            : fail(operation, "failed", `Ticket ${id} could not be read.`, cause),
        ),
      ),
  );

  /** The ticket a client named, refused unless it is a file tk itself would address. */
  const requireTicket = (operation: string, cwd: string, key: string) =>
    (TICKET_ID.test(key)
      ? readTicket(operation, cwd, key)
      : Effect.fail(fail(operation, "not-found", `${key} is not a tk ticket id.`))
    ).pipe(
      Effect.filterOrFail(
        (found) => found !== null,
        () => fail(operation, "failed", `Ticket ${key} is not in tk's format.`),
      ),
    );

  const readTickets = (cwd: string) =>
    fs.readDirectory(ticketsDir(cwd)).pipe(
      Effect.mapError((cause) =>
        cause.reason._tag === "NotFound"
          ? fail("listIssues", "not-found", `${cwd} has no ${TICKETS_DIR} directory.`, cause)
          : fail("listIssues", "failed", `${ticketsDir(cwd)} could not be read.`, cause),
      ),
      Effect.flatMap((names) =>
        Effect.forEach(
          names.filter((name) => name.endsWith(".md") && TICKET_ID.test(name.slice(0, -3))),
          (name) =>
            readTicket("listIssues", cwd, name.slice(0, -3)).pipe(
              // A file removed between the listing and the read is simply gone.
              Effect.catchIf(
                (error) => error.reason === "not-found",
                () => Effect.succeed(null),
              ),
            ),
          { concurrency: READ_CONCURRENCY },
        ),
      ),
      Effect.map((found) => found.filter((entry) => entry !== null)),
    );

  const runTk = (operation: string, cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
    host.process
      .run({
        operation: `TkIssueTracker.${operation}`,
        command: "tk",
        args,
        cwd,
        // Pinned so tk never walks up to a parent directory's tickets.
        env: { TICKETS_DIR: ticketsDir(cwd) },
        allowNonZeroExit: true,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        ...(stdin === undefined ? {} : { stdin }),
      })
      .pipe(
        Effect.mapError((cause) =>
          isMissingExecutable(cause)
            ? fail(operation, "missing-tool", "tk is not installed on this server's PATH.", cause)
            : fail(operation, "failed", "tk could not be run.", cause),
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(
                fail(operation, "failed", result.stderr.trim() || `tk ${args[0]} failed.`),
              ),
        ),
      );

  const toDetail = (found: TicketFile): TrackerIssueDetail => ({
    ...toSummary(found),
    body: found.ticket.description,
    viewer: null,
    viewerPermissions: VIEWER_PERMISSIONS,
    states: STATUSES.map((entry) => entry.state),
    comments: found.ticket.notes.map((note, index): IssueComment => ({
      id: `${found.ticket.id}-note-${index + 1}`,
      author: null,
      body: note.body,
      createdAt: note.createdAt,
      url: null,
    })),
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
  });

  const api: WorkspaceIssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    workspace: {
      host: HOST,
      scope: (workspaceRoot) =>
        fs.stat(ticketsDir(workspaceRoot)).pipe(
          Effect.map((info) =>
            info.type === "Directory" ? scopeFor(path, workspaceRoot, NodeOS.homedir()) : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
    },

    // tk files new tickets under git's user.name, which is the closest it has to an account.
    getViewer: ({ cwd }) =>
      host.git.readConfigValue(cwd, "user.name").pipe(
        Effect.mapError((cause) =>
          fail("getViewer", "failed", "git user.name could not be read.", cause),
        ),
        Effect.flatMap((name) =>
          name?.trim()
            ? Effect.succeed(name.trim())
            : Effect.fail(
                fail("getViewer", "failed", "Set git user.name to see your assigned tickets."),
              ),
        ),
      ),

    listIssues: (input) =>
      readTickets(input.cwd).pipe(
        Effect.map((tickets) => {
          const kept = tickets
            .filter(
              ({ ticket }) =>
                input.state === "all" || stateOf(ticket.status).category === input.state,
            )
            .filter((found) => matches(found, input))
            .map(toSummary)
            .sort((a, b) =>
              input.sort === "created"
                ? b.createdAt.localeCompare(a.createdAt)
                : b.updatedAt.localeCompare(a.updatedAt),
            );
          const start = Number(input.cursor ?? 0) || 0;
          const end = start + input.limit;
          return {
            items: kept.slice(start, end),
            nextCursor: end < kept.length ? String(end) : null,
          };
        }),
      ),

    getIssue: ({ cwd, key }) => requireTicket("getIssue", cwd, key).pipe(Effect.map(toDetail)),

    // Every note arrives with the ticket, so there is never an older page.
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),

    create: Effect.fn("TkIssueTracker.create")(function* ({ cwd, title, body, labels, assignees }) {
      // tk reads any argument that starts with a hyphen as an option.
      if (title.startsWith("-")) {
        return yield* fail("create", "failed", "A tk ticket title cannot start with a hyphen.");
      }
      const args = ["create", title];
      if (body.trim()) args.push("-d", body);
      if (labels.length > 0) args.push("--tags", labels.join(","));
      if (assignees[0] !== undefined) args.push("-a", assignees[0]);
      const id = (yield* runTk("create", cwd, args)).split("\n").at(-1)?.trim() ?? "";
      if (!TICKET_ID.test(id)) {
        return yield* fail("create", "failed", "tk did not name the ticket it created.");
      }
      return {
        key: id,
        displayKey: id,
        url: NodeURL.pathToFileURL(path.join(ticketsDir(cwd), `${id}.md`)).href,
      };
    }),

    // On stdin, as an argument list this long can exceed the OS limit.
    comment: ({ cwd, key, body }) =>
      requireTicket("comment", cwd, key).pipe(
        Effect.flatMap(() => runTk("comment", cwd, ["add-note", key], body)),
        Effect.asVoid,
      ),

    setState: Effect.fn("TkIssueTracker.setState")(function* ({ cwd, key, state }) {
      const target = STATUSES.find((entry) => entry.state.name === state);
      if (target === undefined) {
        return yield* fail("setState", "failed", `tk has no state named ${state}.`);
      }
      yield* requireTicket("setState", cwd, key);
      yield* runTk("setState", cwd, ["status", key, target.status]);
    }),
  };
  return api;
});
