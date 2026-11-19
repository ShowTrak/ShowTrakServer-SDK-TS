// Wire contract for the ShowTrak Server WebSocket control API (`/sdk` namespace).
//
// Standalone mirror of the relevant server shapes — kept intentionally small
// (only the fields integrations consume) so it does not track every internal
// field the server serializes. See constants.ts for the sync note.

import type {
  AudioDevicesView,
  ClientResourceAlarm,
  ClientSystemChecks,
  NetworkStatusView,
  PowerStatusSnapshot,
  StorageStatusView,
  TemperaturesSnapshot,
} from './entities.js';

// --- Views (server → client push payloads) -------------------------------

/** Integrated (SDK) client action / event catalog entry. */
export interface IntegratedAction {
  ID: string;
  Label: string;
  ColourIndex: number;
  /**
   * Bare Bootstrap Icons name (no `bi-` prefix). Older servers omit it
   * entirely; newer ones default it to `"terminal"` when the integrated client
   * declares none.
   */
  Icon?: string;
  HasFeedback: boolean;
  /**
   * The integrated client's own handler timeout in milliseconds. Absent on
   * older servers; newer ones default it when the client declares none.
   */
  TimeoutMs?: number;
}

/**
 * Public projection of a client. Monitoring targets, dummy clients and FreeKiosk
 * terminals are surfaced through the same shape (distinguished by `Type`) so
 * integrations treat them all uniformly — they appear in the client list, carry
 * status + label, and are addressable by slug. For those, `UUID` is a synthetic
 * scoped id (`monitor:<id>`, `dummy:<uuid>`, `kiosk:<uuid>`) and the telemetry
 * fields are empty.
 *
 * `Type` stays open on purpose. A server newer than this SDK may introduce an
 * entity type the union does not name, and a closed union would make that a
 * COMPILE error in every consumer rather than a value they can simply ignore.
 * The named members still autocomplete.
 */
export interface ClientView {
  Type: 'client' | 'monitor' | 'dummy' | 'freekiosk' | (string & {});
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

  // --- Tile telemetry ------------------------------------------------------
  // Everything below has always been on the wire; it was simply not declared,
  // because this file mirrors only what integrations were known to consume. A
  // UI that reproduces the ShowTrak client tile needs all four: the address to
  // identify a machine, the vitals to fill the CPU/RAM bars, LastSeen to count
  // how long something has been down, and the warnings to say WHY a client is
  // degraded rather than just that it is.
  //
  // All optional: a monitor, dummy or FreeKiosk terminal carries none of them,
  // and neither does an older server.

  /** Last known IP address. Absent for entities with no host of their own. */
  IP?: string | null;

  /** Epoch ms of the last heartbeat. The offline counter is `now - LastSeen`. */
  LastSeen?: number | null;

  /**
   * Live CPU / RAM / uptime, present only while a client is online.
   *
   * `Ram.UsagePercentage` is a STRING — the client sends it through
   * `Number#toFixed(2)`. Reading it as a number without coercing is the trap
   * here, and it fails silently by rendering an empty bar rather than throwing.
   */
  Vitals?: Vitals | null;

  /** Why a client is degraded, one message per problem. Empty when healthy. */
  DegradedWarnings?: string[];

  // --- Health telemetry -----------------------------------------------------
  // What the desktop's Storage, Audio, Network, Usage and Power & Thermal tabs
  // read. Absent on older servers and on entities that are not real clients.

  /** Online but still completing its first report. */
  Initialising?: boolean;
  /** Epoch ms the machine last booted. */
  BootTime?: number | null;
  SystemChecks?: ClientSystemChecks;
  /** Monitored system checks currently breaching. */
  ResourceAlarms?: ClientResourceAlarm[];
  PowerStatus?: PowerStatusSnapshot | null;
  Temperatures?: TemperaturesSnapshot | null;
  AudioDevices?: AudioDevicesView;
  NetworkStatus?: NetworkStatusView;
  StorageStatus?: StorageStatusView;
  /** What the client can report about its USB devices. */
  USBCapabilities?: { Location: boolean; FirmwareVersion: boolean; DeviceState: boolean } | null;
  /** The MAC serving its socket address, and every MAC on record (its Wake-on-LAN targets). */
  MacAddress?: string | null;
  MacAddresses?: MacAddressView[];
  Version?: string;
  /** Live USB devices, plus monitored ones that are not connected. */
  USBDeviceList?: UsbDeviceView[];
  /** Displays, plus monitored ones that are not connected. */
  DisplayList?: DisplayView[];
  RunningApplications?: RunningApplicationsView;
}

/** Live telemetry a client reports on every heartbeat. */
export interface Vitals {
  CPU: { UsagePercentage: number };
  Ram: {
    Total: number;
    Used: number;
    /** Transmitted as a string via `toFixed(2)` — coerce before comparing. */
    UsagePercentage: string;
  };
  Uptime: { Formatted: string };
}

/** One MAC the client is known by. The full set is its Wake-on-LAN targets. */
export interface MacAddressView {
  MacAddress: string;
  InterfaceName?: string | null;
  /** Reported by the client, or added by hand at the desk. */
  Source?: 'Reported' | 'Manual';
  FirstSeen?: number;
  LastSeen?: number;
}

/**
 * A USB device as the server serializes it, with its critical-marking
 * annotations applied.
 *
 * Devices that report no serial number are guarded by name and quantity
 * instead, which is why `ConnectedCount`/`Quantity`/`Shortfall` exist alongside
 * the per-serial `IsConnected` — a keyboard hub that returns four of an expected
 * five is neither present nor absent, and only the counts can say so.
 */
export interface UsbDeviceView {
  ManufacturerName?: string | null;
  ProductName?: string | null;
  SerialNumber?: string | null;
  IsCritical?: boolean;
  IsConnected?: boolean;
  IsCriticalByName?: boolean;
  NameKey?: string;
  /** Bus and port path, e.g. `1-1.2`; comma-separated when guarded by name. */
  Location?: string | null;
  FirmwareVersion?: string | null;
  DeviceState?: { ErrorCode: number; Message: string | null } | null;
  Issues?: Array<{ Kind: string; Message: string }>;
  Critical?: {
    Location: string | null;
    FirmwareVersion: string | null;
    RequireNoError: boolean;
    [key: string]: unknown;
  } | null;
  Quantity?: number;
  ConnectedCount?: number;
  Shortfall?: boolean;
  Missing?: boolean;
}

/** A display attached to the client, with its critical-marking annotations. */
export interface DisplayView {
  DisplayID?: string;
  Label?: string | null;
  IsCritical?: boolean;
  IsConnected?: boolean;
  /** The display is present but its resolution/position no longer match. */
  Mismatch?: boolean;
  CurrentSignature?: string | null;
  ExpectedSignature?: string | null;
  ScreenNumber?: number;
  Width?: number;
  Height?: number;
  ScaleFactor?: number;
  RefreshRate?: number | null;
  Rotation?: number;
  Primary?: boolean;
  Bounds?: { x: number; y: number; width: number; height: number };
  Missing?: boolean;
  Issues?: Array<{ Kind: string; Message: string }>;
  Critical?: {
    DisplayID?: string;
    RequirePresent?: boolean;
    Width: number | null;
    Height: number | null;
    RefreshRate: number | null;
    ScaleFactor: number | null;
    Rotation: number | null;
    RequirePrimary: boolean;
    PositionX: number | null;
    PositionY: number | null;
  } | null;
}

/**
 * One address on an interface.
 *
 * Lower-case field names: the agent passes Node's `os.networkInterfaces()`
 * entries through almost verbatim, and `family` is a string on older Node and
 * the number 4/6 on newer — compare loosely.
 */
export interface NetworkAddressView {
  family: string | number;
  address: string;
  netmask?: string | null;
  cidr?: string | null;
  mac?: string | null;
  internal?: boolean;
  scopeid?: number | null;
  /** Server-side annotation: whether the address is currently live. */
  active?: boolean;
}

export interface NetworkInterfaceView {
  name: string;
  addresses: NetworkAddressView[];
}

export interface RunningApplicationView {
  Name: string;
  Count: number;
  Key?: string;
  IsCritical?: boolean;
  IsRunning?: boolean;
  /** Null when the platform cannot tell. */
  Responding?: boolean | null;
  IsForeground?: boolean;
  RequireForeground?: boolean;
  RequireResponding?: boolean;
}

/**
 * The client's running-application snapshot.
 *
 * `Status.State` matters as much as the list: a client that cannot enumerate
 * processes (`permission_denied` on macOS without Full Disk Access) reports an
 * EMPTY list, which is indistinguishable from "nothing running" unless the state
 * is read too.
 */
export interface RunningApplicationsView {
  SampledAt?: number;
  TotalCount?: number;
  Truncated?: boolean;
  Items?: RunningApplicationView[];
  Status?: {
    State: 'unknown' | 'ok' | 'error' | 'permission_denied' | (string & {});
    Message?: string | null;
    Platform?: string;
  };
  /** The application in front, when the platform can say. */
  Foreground?: string | null;
  Capabilities?: { Responding: boolean; Foreground: boolean } | null;
}

/**
 * The full server-side client record, as `GetClient` answers it.
 *
 * A superset of ClientView: the same identity and status fields plus the
 * inventory the desktop's Client Info panel reads — every MAC, the USB devices,
 * the displays, the network interfaces and the running applications.
 *
 * The index signature stays. This is the desktop's own object and it carries
 * more columns than any consumer reads; declaring the ones a detail view
 * actually uses and leaving the rest indexable is the honest middle, because
 * mirroring every internal column here would be a second schema to keep in step
 * for no gain.
 */
export interface ClientDetail extends ClientView {
  MacAddress?: string | null;
  MacAddresses?: MacAddressView[];
  LastSeen?: number | null;
  USBDeviceList?: UsbDeviceView[];
  DisplayList?: DisplayView[];
  NetworkInterfaces?: NetworkInterfaceView[];
  RunningApplications?: RunningApplicationsView;
  /** The script the client runs when it starts, and its delay. Clients only. */
  RunOnLaunchScriptID?: string | null;
  RunOnLaunchDelaySeconds?: number | null;
  /** Seconds a client may be silent before it reads offline; null for the server default. */
  OfflineGraceSeconds?: number | null;
  [key: string]: unknown;
}

/** Public projection of a group. */
export interface GroupView {
  GroupID: number;
  Title: string | null;
  Slug: string | null;
  Weight?: number;
  isFullWidth?: boolean;
  /** Columns the group's box spans in the desktop grid. Absent on older servers. */
  ColumnSpan?: number;
  /** Index into the desktop's group palette, or null for no tint. */
  Colour?: number | null;
}

/**
 * A tag's dynamic membership rule. Workspace:true means "every client"; otherwise
 * a client is a member if its UUID is whitelisted, its group is, or it carries
 * one of the tags this tag absorbs. Mirrors the server-side TagScope so
 * membership can be resolved client-side.
 *
 * `Tags` is optional: an older server omits it, and an absent list means "no
 * tags", never "all".
 */
export interface TagScope {
  Workspace: boolean;
  Groups: number[];
  Clients: string[];
  Tags?: number[];
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

/**
 * How firmly a script asks before it runs. `Critical` is the desktop's loud
 * variant, which names every target and defaults to Cancel.
 */
export type ScriptConfirmationLevel = 'None' | 'Standard' | 'Critical';

/** Public projection of a script catalog entry (ID is the script slug). */
export interface ScriptView {
  ID: string;
  Name: string;
  Colour?: number;
  Icon?: string | null;
  /** Whether to ask at all. Older servers send only this; see ConfirmationLevel. */
  Confirmation?: boolean;
  /** Absent on servers predating levels, where `Confirmation: true` means Standard. */
  ConfirmationLevel?: ScriptConfirmationLevel;

  // --- Targeting -----------------------------------------------------------
  // What decides which clients a script is offered on. See IsScriptTargetable;
  // the server re-checks the whitelist on dispatch regardless.

  /** Operating systems the script has an entry point for (`Windows`, `macOS`, `Linux`). */
  CompatiblePlatforms?: string[];
  /** False for a script switched off by its author, or whose Script.json failed to parse. */
  isEnabled?: boolean;
  /** Per-show restriction on which clients may run it; null means unrestricted. */
  Whitelist?: TagScope | null;
}

export type AppMode = 'SHOW' | 'EDIT';

/**
 * The ShowTrak client list's three layouts: tiles, compact tiles, or a table.
 * Each renderer (the desktop and every Web UI browser) applies a layout change.
 */
export type ViewMode = 'grid' | 'compact' | 'list';

export const VIEW_MODES: readonly ViewMode[] = ['grid', 'compact', 'list'] as const;

/**
 * Where a script execution has got to.
 *
 * Note there is no separate "running" state: a queued execution and a running
 * one are BOTH `Pending`, and only `StatusText` distinguishes them (it reads
 * "Queued" while a client works through its backlog). That is the server's
 * model, not a simplification here — do not infer running-ness from the status.
 */
export type ScriptExecutionStatus = 'Pending' | 'Failed' | 'Completed';

/**
 * One script execution, live.
 *
 * The server keeps a list of these and re-broadcasts the whole list on every
 * change, which is what lets a late-joining device show work already in flight
 * rather than only what starts after it connected.
 *
 * `Internal` marks executions the server raised for itself rather than for an
 * operator — script deployment, integrated actions. The desktop hides some of
 * these, and anything mirroring its execution panel should decide deliberately
 * rather than showing housekeeping as though someone asked for it.
 */
export interface ScriptExecutionView {
  Internal: boolean;
  RequestID: string;
  Status: ScriptExecutionStatus;
  /** 0–100. Meaningful only while Pending; a settled execution sits at 100. */
  Progress: number;
  /** What the client last said it was doing, or "Queued" before it starts. */
  StatusText: string;
  Timer: {
    Start: number;
    /** Epoch ms when it settled; null while it is still queued or running. */
    End: number | null;
    /** Milliseconds taken; null until it settles. */
    Duration: number | null;
  };
  Client: { UUID: string | null; Nickname: string | null; Hostname: string | null };
  Script: { ID: string; Name: string };
  Error: string | null;
}

/**
 * A device announcing itself on the network but not yet adopted into the
 * workspace. Pushed in full whenever the list changes (and once on connect, on
 * servers that send it), so a remote can offer Adopt and Identify for it.
 */
export interface PendingAdoptionView {
  UUID: string;
  Hostname: string;
  IP: string;
  Version: string;
  /** 'Pending', or 'Adopting' once an adoption has been asked for. */
  State: string;
  /** Identify mode is running on it. */
  Identifying: boolean;
}

// --- Push channels (server → client) -------------------------------------

/**
 * Channels the `/sdk` namespace forwards. Names match the server's internal
 * push channels so one allowlist serves both the Web UI and the SDK.
 */
export interface ServerPushEvents {
  SetFullClientList: (clients: ClientView[], groups: GroupView[]) => void;
  ClientUpdated: (client: ClientView) => void;
  // Monitors, dummies and FreeKiosk terminals as client-shaped views (Type
  // 'monitor' / 'dummy' / 'freekiosk').
  SetFullMonitoringTargetList: (monitors: ClientView[]) => void;
  MonitoringTargetUpdated: (monitor: ClientView) => void;
  SetFullDummyClientList: (dummies: ClientView[]) => void;
  DummyClientUpdated: (dummy: ClientView) => void;
  SetFullFreeKioskTerminalList: (terminals: ClientView[]) => void;
  FreeKioskTerminalUpdated: (terminal: ClientView) => void;
  SetTagList: (tags: TagView[]) => void;
  SetScriptList: (scripts: ScriptView[]) => void;
  ModeUpdated: (mode: AppMode) => void;
  AlertActionsUpdated: (enabled: boolean) => void;
  Notify: (message: string, type?: string, duration?: number) => void;
  /**
   * The whole execution list, on every change. Servers from 3.34 also send it
   * once on connect, so work already in flight is visible straight away.
   */
  UpdateScriptExecutions: (executions: ScriptExecutionView[]) => void;
  /** Sent once on connect too, to every session from server 3.34 (devices only before). */
  SetDevicesPendingAdoption: (devices: PendingAdoptionView[]) => void;
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
  // Client-list layout (grid / compact / list). Servers before 3.34 answer
  // these with "Unknown command".
  | 'view.set'
  | 'view.toggle'
  // Monitoring check actions: a projector's power, a console's scene. The same
  // verbs the OSC /API/Monitor routes offer. Server 3.34+.
  | 'monitor.action'
  // FreeKiosk terminal commands (screen, brightness, reload ...), by terminal,
  // group, tag or every terminal. Server 3.34+.
  | 'freekiosk.terminal'
  | 'freekiosk.group'
  | 'freekiosk.tag'
  | 'freekiosk.all'
  // Deliver a heartbeat to a dummy client on behalf of whatever it stands for.
  // Server 3.34+.
  | 'dummy.heartbeat'
  // The execution panel: retry what failed, clear what finished. Server 3.34+.
  | 'executions.retryFailed'
  | 'executions.clearSettled'
  // Identify — flashes an overlay on the client's own screen. Mutates nothing
  // and is deliberately available in SHOW mode: it exists for the operator
  // standing at a rack working out which machine is which.
  | 'identify.client'
  | 'identify.stop'
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
  /**
   * `mode` names the layout. Earlier SDKs sent `{ compact }` instead, which
   * servers still read as compact vs grid.
   */
  'view.set': { mode: ViewMode };
  /** Compact on or off, as SDK 1.x has always documented it. */
  'view.toggle': Record<string, never>;
  /**
   * `value` fills the action's first declared parameter (what a single text
   * field can address, as the OSC route's trailing value does); `params` names
   * any of them and wins over `value`. Blank `value` means none.
   */
  'monitor.action': {
    slug: string;
    method: string;
    actionId: string;
    value?: string | number;
    params?: Record<string, unknown>;
  };
  /** `value` fills a command's one parameter (brightness, volume: 0-100). */
  'freekiosk.terminal': { slug: string; commandId: string; value?: string | number };
  'freekiosk.group': { slug: string; commandId: string; value?: string | number };
  'freekiosk.tag': { slug: string; commandId: string; value?: string | number };
  'freekiosk.all': { commandId: string; value?: string | number };
  'dummy.heartbeat': { slug: string };
  'executions.retryFailed': Record<string, never>;
  'executions.clearSettled': Record<string, never>;
  'identify.client': { slug: string };
  'identify.stop': { slug: string };
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
