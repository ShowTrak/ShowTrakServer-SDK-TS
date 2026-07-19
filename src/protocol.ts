// Wire contract for the ShowTrak Server WebSocket control API (`/sdk` namespace).
//
// Standalone mirror of the relevant server shapes — kept intentionally small
// (only the fields integrations consume) so it does not track every internal
// field the server serializes. See constants.ts for the sync note.

// --- Views (server → client push payloads) -------------------------------

/** Integrated (SDK) client action / event catalog entry. */
export interface IntegratedAction {
  ID: string;
  Label: string;
  ColourIndex: number;
  HasFeedback: boolean;
}

/**
 * Public projection of a client. Monitors and dummies are surfaced through the
 * same shape (distinguished by `Type`) so integrations treat all three uniformly
 * — they appear in the client list, carry status + label, and are addressable by
 * slug. For monitors/dummies, `UUID` is a synthetic scoped id (`monitor:<id>` /
 * `dummy:<uuid>`) and telemetry fields are empty.
 */
export interface ClientView {
  Type: 'client' | 'monitor' | 'dummy';
  UUID: string;
  Slug: string | null;
  Nickname?: string | null;
  Hostname?: string | null;
  OperatingSystem?: string;
  VersionLabel?: string;
  GroupID?: number | null;
  Online?: boolean;
  Degraded?: boolean;
  Unassigned?: boolean;
  Integrated?: boolean;
  Identifying?: boolean;
  IntegratedActions?: IntegratedAction[];
}

/** Public projection of a group. */
export interface GroupView {
  GroupID: number;
  Title: string | null;
  Slug: string | null;
  Weight?: number;
  isFullWidth?: boolean;
}

/**
 * A tag's dynamic membership rule. Workspace:true means "every client"; otherwise
 * a client is a member if its UUID is whitelisted or its group is. Mirrors the
 * server-side TagScope so membership can be resolved client-side.
 */
export interface TagScope {
  Workspace: boolean;
  Groups: number[];
  Clients: string[];
}

/** Public projection of a tag. */
export interface TagView {
  TagID: number;
  Slug: string | null;
  Colour?: number;
  Icon?: string | null;
  /** Dynamic membership rule; may be absent when talking to an older server. */
  Scope?: TagScope;
}

/** Public projection of a script catalog entry (ID is the script slug). */
export interface ScriptView {
  ID: string;
  Name: string;
  Colour?: number;
  Icon?: string | null;
  Confirmation?: boolean;
}

export type AppMode = 'SHOW' | 'EDIT';

// --- Push channels (server → client) -------------------------------------

/**
 * Channels the `/sdk` namespace forwards. Names match the server's internal
 * push channels so one allowlist serves both the Web UI and the SDK.
 */
export interface ServerPushEvents {
  SetFullClientList: (clients: ClientView[], groups: GroupView[]) => void;
  ClientUpdated: (client: ClientView) => void;
  // Monitors and dummies as client-shaped views (Type 'monitor' / 'dummy').
  SetFullMonitoringTargetList: (monitors: ClientView[]) => void;
  MonitoringTargetUpdated: (monitor: ClientView) => void;
  SetFullDummyClientList: (dummies: ClientView[]) => void;
  DummyClientUpdated: (dummy: ClientView) => void;
  SetTagList: (tags: TagView[]) => void;
  SetScriptList: (scripts: ScriptView[]) => void;
  ModeUpdated: (mode: AppMode) => void;
  AlertActionsUpdated: (enabled: boolean) => void;
  Notify: (message: string, type?: string, duration?: number) => void;
}

export type ServerPushChannel = keyof ServerPushEvents;

// --- Commands (client → server) ------------------------------------------

/** Every command name the control API accepts. */
export type CommandName =
  // Wake-on-LAN
  | 'wol.all'
  | 'wol.client'
  | 'wol.group'
  | 'wol.tag'
  // Scripts (run by script slug)
  | 'script.all'
  | 'script.client'
  | 'script.group'
  | 'script.tag'
  // Integrated events (integrated clients only)
  | 'event.all'
  | 'event.client'
  | 'event.group'
  | 'event.tag'
  // Alerts
  | 'alerts.set'
  | 'alerts.toggle'
  // Show / Edit mode
  | 'mode.set'
  | 'mode.toggle'
  // Expanded / Compact view
  | 'view.set'
  | 'view.toggle'
  // Modals (desktop app only — the web UI ignores these)
  | 'modal.openClient'
  | 'modal.closeAll'
  // Misc
  | 'show.save'
  // Shutdown (graceful honours save / show-mode prompts; force skips them)
  | 'system.shutdown'
  | 'system.shutdownForce';

/** Argument shape per command (empty object when a command takes no args). */
export interface CommandArgs {
  'wol.all': Record<string, never>;
  'wol.client': { slug: string };
  'wol.group': { slug: string };
  'wol.tag': { slug: string };
  'script.all': { scriptSlug: string };
  'script.client': { slug: string; scriptSlug: string };
  'script.group': { slug: string; scriptSlug: string };
  'script.tag': { slug: string; scriptSlug: string };
  'event.all': { eventSlug: string };
  'event.client': { slug: string; eventSlug: string };
  'event.group': { slug: string; eventSlug: string };
  'event.tag': { slug: string; eventSlug: string };
  'alerts.set': { enabled: boolean };
  'alerts.toggle': Record<string, never>;
  'mode.set': { mode: AppMode };
  'mode.toggle': Record<string, never>;
  'view.set': { compact: boolean };
  'view.toggle': Record<string, never>;
  'modal.openClient': { slug: string };
  'modal.closeAll': Record<string, never>;
  'show.save': Record<string, never>;
  'system.shutdown': Record<string, never>;
  'system.shutdownForce': Record<string, never>;
}

/** Uniform command acknowledgement. */
export interface CommandResult {
  ok: boolean;
  detail: string;
}
