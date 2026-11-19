// ShowTrakControlClient — the high-level, typed entry point every integration
// uses to control a ShowTrak Server instance in real time and read live status.
//
// Transport is Socket.IO (the `/sdk` namespace). The client keeps local caches
// of the entities the server pushes so status/label feedback getters are
// synchronous (no round-trip), and emits change events integrations hook into.

import { io, type Socket } from 'socket.io-client';
import {
  DEFAULT_SERVER_PORT,
  SDK_NAMESPACE,
  COMMAND_EVENT,
  StatusColour,
  StatusRgb,
  type ClientStatus,
} from './constants.js';
import {
  RPC_CHANNELS,
  ToRpcResult,
  type Capabilities,
  type HistorySample,
  type NamedHistorySeries,
  type ResultTuple,
  type RpcChannel,
  type RpcResult,
} from './management.js';
import { Pair, type PairOptions, type PairResult } from './pairing.js';
import type {
  AlertRuleView,
  AlertSoundName,
  CustomAlertAudio,
  MonitoringActionFavouriteView,
  PublicSetting,
  ShowTrakAlert,
  AuditLogPage,
  AuditLogQuery,
  ClientHistorySeries,
  ClientVariableView,
  ClientVitalsHistory,
  DummyClientView,
  FreeKioskCommandDef,
  FreeKioskCapture,
  FreeKioskCommandSummary,
  FreeKioskMetricCatalog,
  FreeKioskMetricSeries,
  FreeKioskTerminalView,
  MonitoringActionSummary,
  MonitorLiveLevelsSnapshot,
  MonitoringMethodView,
  MonitoringTargetView,
  ExecutionOutputView,
} from './entities.js';
import type {
  AppMode,
  ClientDetail,
  PendingAdoptionView,
  ClientView,
  CommandArgs,
  CommandName,
  CommandResult,
  GroupView,
  ScriptView,
  ScriptExecutionView,
  TagScope,
  TagView,
  ViewMode,
} from './protocol.js';

interface ConnectOptionsBase {
  host: string;
  /** Defaults to DEFAULT_SERVER_PORT (3000). */
  port?: number;
  /** Reconnect automatically (default true). */
  reconnect?: boolean;
}

/**
 * Exactly one credential, never both.
 *
 * They are not interchangeable and the server treats them differently: an API
 * key identifies an INTEGRATION and may only send commands, while a device token
 * identifies a PAIRED DEVICE and additionally reaches the management bridge. A
 * union rather than two optional fields, so "I have neither" and "I have both"
 * are compile errors instead of a handshake the server has to adjudicate.
 */
export type ConnectOptions =
  | (ConnectOptionsBase & { apiKey: string; deviceToken?: never })
  | (ConnectOptionsBase & { deviceToken: string; apiKey?: never });

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Per-category permissions as probed from the server. See refreshCapabilities. */
interface SurfacePermissionSnapshot {
  clientManagement: boolean;
  groupManagement: boolean;
  monitoringManagement: boolean;
  alertManagement: boolean;
  identify: boolean;
  monitoringActions: boolean;
  scripts: boolean;
  remoteScripts: boolean;
  wol: boolean;
}

type Listener<T extends unknown[]> = (...args: T) => void;

interface Events {
  connect: [];
  disconnect: [reason: string];
  /**
   * This device's pairing was revoked at the desk. The stored token is now
   * worthless — drop it and send the operator back to pairing rather than
   * reconnecting, which will only be refused again.
   */
  revoked: [];
  capabilitiesChanged: [];
  error: [message: string];
  stateChanged: [state: ConnectionState];
  clientsChanged: [];
  tagsChanged: [];
  modeChanged: [mode: AppMode];
  alertsChanged: [enabled: boolean];
  scriptsChanged: [];
  /**
   * A monitor's live audio meters, while open with openLiveLevels. Sent in full
   * on every update, a few times a second.
   */
  liveLevels: [snapshot: MonitorLiveLevelsSnapshot];
  /** The live script-execution list changed — one started, moved on, or ended. */
  scriptExecutionsChanged: [executions: ScriptExecutionView[]];
  notify: [message: string, type: string, duration: number];
  /** An alert rule raised a ShowTrak alert. Every session, integrations included. */
  alert: [alert: ShowTrakAlert];
  // The events below are for paired devices. Servers from 3.34 send them to
  // device sessions only; earlier ones sent them to every session.
  /** An alert rule asked for one of the built-in sounds. */
  playSound: [name: AlertSoundName];
  /** An alert rule asked for a custom sound; its audio comes inline. */
  playCustomAudio: [audio: CustomAlertAudio];
  /** The custom alert sounds changed; re-read them if they are on screen. */
  audioAssetsChanged: [];
  /** A monitoring action was starred or unstarred. See getMonitoringFavourites. */
  favouritesChanged: [favourites: MonitoringActionFavouriteView[]];
  /** An alert rule was created, edited, enabled or deleted. See getAlertRules. */
  alertRulesChanged: [rules: AlertRuleView[]];
  /** A new audit log line; open log views can fetch it rather than poll. */
  auditLogAppended: [entry: unknown];
  /** The public display settings changed. See getPublicSettings. */
  settingsChanged: [settings: PublicSetting[]];
  /** Devices waiting to be adopted changed — one appeared, left, or started identifying. */
  pendingAdoptionChanged: [devices: PendingAdoptionView[]];
}

/**
 * Derive a client's status the same way the server UI paints its tile:
 * offline unless online; degraded when online with warnings; unassigned slots
 * read as idle.
 */
export function DeriveClientStatus(client: ClientView): ClientStatus {
  if (client.Unassigned) return 'IDLE';
  if (!client.Online) return 'OFFLINE';
  if (client.Degraded) return 'DEGRADED';
  return 'ONLINE';
}

/** Human label for a client — Nickname, falling back to Hostname, then slug. */
export function ClientLabel(client: ClientView): string {
  return (
    (client.Nickname && client.Nickname.trim()) ||
    (client.Hostname && client.Hostname.trim()) ||
    client.Slug ||
    client.UUID
  );
}

/**
 * Client-shaped entities that arrive on their own pair of channels.
 *
 * Real clients are deliberately absent: they carry telemetry, are indexed by
 * UUID as well as slug, and share their list event with the group list. Every
 * OTHER entity the server projects into a ClientView — monitoring targets, dummy
 * clients, FreeKiosk terminals — is a slug-keyed snapshot delivered as a
 * full-list event plus a single-entity update event, and nothing else about them
 * differs. So a new entity type is A ROW HERE, not a fourth copy of twenty
 * near-identical lines.
 *
 * `ScopeIdIsBare` records an inconsistency in the server rather than a choice.
 * A tag's membership list stores whatever id the scope picker wrote: a prefixed
 * `monitor:<id>` for monitoring targets, but a BARE uuid for dummies and
 * FreeKiosk terminals. The pushed ClientView always carries the prefixed form,
 * so matching a scope entry means knowing which of the two to compare. Getting
 * this wrong is invisible — the tag simply under-counts — which is exactly how
 * it went unnoticed for dummies.
 */
const AUXILIARY_ENTITIES = [
  {
    Kind: 'monitor',
    ListEvent: 'SetFullMonitoringTargetList',
    UpdateEvent: 'MonitoringTargetUpdated',
    Prefix: 'monitor:',
    ScopeIdIsBare: false,
  },
  {
    Kind: 'dummy',
    ListEvent: 'SetFullDummyClientList',
    UpdateEvent: 'DummyClientUpdated',
    Prefix: 'dummy:',
    ScopeIdIsBare: true,
  },
  {
    Kind: 'freekiosk',
    ListEvent: 'SetFullFreeKioskTerminalList',
    UpdateEvent: 'FreeKioskTerminalUpdated',
    Prefix: 'kiosk:',
    ScopeIdIsBare: true,
  },
] as const;

/** The entity kinds above, for callers that want to filter by one. */
export type AuxiliaryEntityKind = (typeof AUXILIARY_ENTITIES)[number]['Kind'];

/**
 * Every id a tag scope might have stored for this entity.
 *
 * Always includes the UUID as pushed. For an entity whose scope id is bare, the
 * de-prefixed form is added too — and ONLY for those, so a monitor's `monitor:8`
 * can never also match a scope entry that happens to read `8`.
 */
function ScopeIdCandidates(uuid: string): string[] {
  for (const Entity of AUXILIARY_ENTITIES) {
    if (!Entity.ScopeIdIsBare || !uuid.startsWith(Entity.Prefix)) continue;
    return [uuid, uuid.slice(Entity.Prefix.length)];
  }
  return [uuid];
}

/**
 * True when a scope covers a client. Mirrors the server's
 * ScriptWhitelistManager.IsClientAllowed, which is the rule for BOTH a tag's
 * membership and a script's whitelist, so feedback here matches dispatch there.
 *
 * An absent scope, or `Workspace: true`, covers everything. A scope may absorb
 * other tags (making it a superset of them), so this is a graph walk rather than
 * a lookup; `visited` breaks the cycle an operator can author by adding each of
 * two tags to the other. `tags` is the full tag list, needed only to expand
 * those nested tags.
 */
export function ScopeCoversClient(
  scope: TagScope | null | undefined,
  client: Pick<ClientView, 'UUID' | 'GroupID'> | null | undefined,
  tags: readonly TagView[] = [],
  visited: Set<number> = new Set()
): boolean {
  if (!scope || scope.Workspace) return true;
  if (!client || !client.UUID) return false;
  const Clients = Array.isArray(scope.Clients) ? scope.Clients : [];
  const Groups = Array.isArray(scope.Groups) ? scope.Groups : [];
  // Not just client.UUID: a dummy or a FreeKiosk terminal is pushed with a
  // prefixed uuid but recorded in a tag scope bare, so comparing only the
  // pushed form silently drops it from the tag. See AUXILIARY_ENTITIES.
  if (ScopeIdCandidates(client.UUID).some((Id) => Clients.includes(Id))) return true;
  if (client.GroupID != null && Groups.map(Number).includes(Number(client.GroupID))) return true;
  for (const raw of Array.isArray(scope.Tags) ? scope.Tags : []) {
    const tagID = Number(raw);
    if (!Number.isInteger(tagID) || visited.has(tagID)) continue;
    visited.add(tagID);
    const nested = tags.find((t) => Number(t.TagID) === tagID);
    // An unknown TagID (deleted tag still named by a stale scope) contributes
    // no members — it must never widen the scope.
    if (!nested || !nested.Scope) continue;
    if (ScopeCoversClient(nested.Scope, client, tags, visited)) return true;
  }
  return false;
}

/** An optional command value, left off the wire when absent or blank. */
function WithValue(value: string | number | undefined): { value?: string | number } {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string' && value.trim() === '') return {};
  return { value };
}

export class ShowTrakControlClient {
  private socket: Socket | null = null;
  private state: ConnectionState = 'disconnected';

  // Live caches, keyed by slug for O(1) feedback lookups. The auxiliary entities
  // are client-shaped and share the slug namespace with real clients, but each
  // kind is kept in its own map so a full-list replacement for one never
  // disturbs the others. getAllClients()/getClient() read across all of them.
  private clientsBySlug = new Map<string, ClientView>();
  private clientsByUuid = new Map<string, ClientView>();
  private auxiliaryBySlug = new Map<AuxiliaryEntityKind, Map<string, ClientView>>(
    AUXILIARY_ENTITIES.map((Entity) => [Entity.Kind, new Map<string, ClientView>()])
  );
  private groupsBySlug = new Map<string, GroupView>();
  private tagsBySlug = new Map<string, TagView>();
  private scriptsById = new Map<string, ScriptView>();
  // Held as the server's own ordered list rather than a map. The order IS
  // information — the manager appends, so each client is visibly working down
  // its own queue — and re-keying it would throw that away.
  private scriptExecutions: ScriptExecutionView[] = [];
  private favourites: MonitoringActionFavouriteView[] = [];
  private alertRules: AlertRuleView[] = [];
  private publicSettings: PublicSetting[] = [];
  private mode: AppMode = 'SHOW';
  private alertsEnabled = true;
  // Devices on the network waiting to be adopted, as the server's own list.
  private pendingAdoption: PendingAdoptionView[] = [];
  // Whether this session authenticated as a paired device. Only a device may
  // reach the management bridge, so an API-key session reports no management
  // capabilities rather than offering controls the server will refuse.
  private isDevice = false;
  private permissions: SurfacePermissionSnapshot | null = null;

  private listeners: { [K in keyof Events]: Set<Listener<Events[K]>> } = {
    connect: new Set(),
    disconnect: new Set(),
    error: new Set(),
    stateChanged: new Set(),
    clientsChanged: new Set(),
    tagsChanged: new Set(),
    modeChanged: new Set(),
    alertsChanged: new Set(),
    scriptsChanged: new Set(),
    scriptExecutionsChanged: new Set(),
    notify: new Set(),
    pendingAdoptionChanged: new Set(),
    revoked: new Set(),
    capabilitiesChanged: new Set(),
    liveLevels: new Set(),
    alert: new Set(),
    playSound: new Set(),
    playCustomAudio: new Set(),
    audioAssetsChanged: new Set(),
    favouritesChanged: new Set(),
    alertRulesChanged: new Set(),
    auditLogAppended: new Set(),
    settingsChanged: new Set(),
  };

  // --- Lifecycle ---------------------------------------------------------

  connect(options: ConnectOptions): void {
    this.disconnect();
    const port = options.port ?? DEFAULT_SERVER_PORT;
    const url = `http://${options.host}:${port}${SDK_NAMESPACE}`;
    this.isDevice = !!options.deviceToken;
    this.setState('connecting');
    this.socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: options.reconnect !== false,
      auth: options.deviceToken ? { deviceToken: options.deviceToken } : { apiKey: options.apiKey },
      forceNew: true,
    });
    this.wire(this.socket);
  }

  disconnect(): void {
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.disconnect();
      } catch {
        /* best effort */
      }
      this.socket = null;
    }
    this.clientsBySlug.clear();
    this.clientsByUuid.clear();
    for (const Store of this.auxiliaryBySlug.values()) Store.clear();
    this.groupsBySlug.clear();
    this.tagsBySlug.clear();
    this.scriptsById.clear();
    // Dropped along with everything else, and this one matters more than most:
    // an execution list is a claim about what is happening RIGHT NOW, so
    // carrying it across a disconnect would leave a UI showing a script as
    // still running long after we stopped being told otherwise.
    this.scriptExecutions = [];
    // Same reasoning: a device listed as waiting may have been adopted or left.
    this.pendingAdoption = [];
    this.setState('disconnected');
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  // --- Event subscription ------------------------------------------------

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const listener of this.listeners[event]) {
      try {
        listener(...args);
      } catch {
        /* a listener must not break delivery to the rest */
      }
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('stateChanged', state);
  }

  // --- Feedback getters (synchronous, read from cache) -------------------

  // Look up an entity by slug across every client-like kind (one shared,
  // collision-free namespace). Real clients win if a slug ever appears twice.
  getClient(slug: string): ClientView | undefined {
    const Client = this.clientsBySlug.get(slug);
    if (Client) return Client;
    for (const Store of this.auxiliaryBySlug.values()) {
      const Found = Store.get(slug);
      if (Found) return Found;
    }
    return undefined;
  }

  // Every controllable entity: real clients plus every auxiliary kind. Feeds the
  // summary counts and the per-entity status/label variables, so an entity type
  // missing from here is invisible to every aggregate the SDK reports.
  getAllClients(): ClientView[] {
    const All: ClientView[] = [...this.clientsBySlug.values()];
    for (const Store of this.auxiliaryBySlug.values()) All.push(...Store.values());
    return All;
  }

  /**
   * Just one kind of entity — 'client' for real clients, or any auxiliary kind.
   *
   * Reads the pushed `Type` rather than the internal store, so a kind this SDK
   * build predates still answers correctly once it is listed in
   * AUXILIARY_ENTITIES; and a caller can ask for a type by name without the SDK
   * needing a bespoke getter per entity.
   */
  getClientsByType(type: string): ClientView[] {
    return this.getAllClients().filter((Entity) => String(Entity.Type) === type);
  }

  getClientStatus(slug: string): ClientStatus | undefined {
    const client = this.getClient(slug);
    return client ? DeriveClientStatus(client) : undefined;
  }

  getClientStatusColour(slug: string): string | undefined {
    const status = this.getClientStatus(slug);
    return status ? StatusColour(status) : undefined;
  }

  getClientStatusRgb(slug: string): [number, number, number] | undefined {
    const status = this.getClientStatus(slug);
    return status ? StatusRgb(status) : undefined;
  }

  getClientLabel(slug: string): string | undefined {
    const client = this.getClient(slug);
    return client ? ClientLabel(client) : undefined;
  }

  /**
   * Roll a set of clients up to one scope status. The scope is only "healthy"
   * (ONLINE) when every member is up — a single degraded OR offline member drags
   * the whole scope to DEGRADED. It reads OFFLINE only when the entire scope is
   * down, and IDLE only when the entire scope is idle (unassigned).
   */
  private aggregateStatus(members: ClientView[]): ClientStatus {
    if (members.length === 0) return 'OFFLINE';
    const statuses = members.map(DeriveClientStatus);
    if (statuses.every((s) => s === 'OFFLINE')) return 'OFFLINE';
    if (statuses.every((s) => s === 'IDLE')) return 'IDLE';
    // Any member down or degraded (but not the whole scope) → DEGRADED.
    if (statuses.includes('DEGRADED') || statuses.includes('OFFLINE')) return 'DEGRADED';
    // Otherwise everything present is online; idle members don't detract.
    return 'ONLINE';
  }

  /** True when a client falls inside a tag's dynamic scope. See ScopeCoversClient. */
  private clientInTagScope(scope: TagScope | undefined, client: ClientView): boolean {
    return ScopeCoversClient(scope, client, this.getTags());
  }

  /** Aggregate status of a group's members (degraded > online > idle > offline). */
  getGroupStatus(slug: string): ClientStatus | undefined {
    const group = this.groupsBySlug.get(slug);
    if (!group) return undefined;
    const members = this.getAllClients().filter((c) => Number(c.GroupID) === group.GroupID);
    return this.aggregateStatus(members);
  }

  /**
   * Every entity a tag currently covers.
   *
   * Public because membership is not something a consumer can work out for
   * itself without reimplementing the scope walk — including the nested-tag
   * recursion, the cycle guard, and the prefixed-vs-bare id quirk that silently
   * under-counts dummies and FreeKiosk terminals. A second implementation of
   * that would disagree with this one eventually, and the disagreement would be
   * invisible: a tag filter that quietly omits a machine looks like a tag with
   * fewer members, not like a bug.
   *
   * Returns an empty list for an unknown slug, so a stale filter degrades to
   * "nothing matches" rather than throwing at a caller mid-render.
   */
  getTagMembers(slug: string): ClientView[] {
    const tag = this.tagsBySlug.get(slug);
    if (!tag) return [];
    return this.getAllClients().filter((c) => this.clientInTagScope(tag.Scope, c));
  }

  /** Whether one entity falls under a tag. Same rules as getTagMembers. */
  isClientInTag(tagSlug: string, clientSlug: string): boolean {
    const tag = this.tagsBySlug.get(tagSlug);
    const client = this.getClient(clientSlug);
    if (!tag || !client) return false;
    return this.clientInTagScope(tag.Scope, client);
  }

  /** Aggregate status of a tag's members (degraded > online > idle > offline). */
  getTagStatus(slug: string): ClientStatus | undefined {
    const tag = this.tagsBySlug.get(slug);
    if (!tag) return undefined;
    const members = this.getAllClients().filter((c) => this.clientInTagScope(tag.Scope, c));
    return this.aggregateStatus(members);
  }

  /** Aggregate status of every known client (degraded > online > idle > offline). */
  getAllStatus(): ClientStatus {
    return this.aggregateStatus(this.getAllClients());
  }

  getGroups(): GroupView[] {
    return Array.from(this.groupsBySlug.values());
  }

  getTags(): TagView[] {
    return Array.from(this.tagsBySlug.values());
  }

  getScripts(): ScriptView[] {
    return Array.from(this.scriptsById.values());
  }

  /** Starred monitoring actions, newest list from the server. Paired devices only. */
  getMonitoringFavourites(): MonitoringActionFavouriteView[] {
    return this.favourites;
  }

  /** Every alert rule, newest first. Paired devices only. */
  getAlertRules(): AlertRuleView[] {
    return this.alertRules;
  }

  /** The display settings a remote surface may read (column count, default view, …). */
  getPublicSettings(): PublicSetting[] {
    return this.publicSettings;
  }

  /**
   * The executions running, queued or finished on one client, in panel order.
   * Empty for a slug that does not name a client.
   */
  getExecutionsForClient(slug: string): ScriptExecutionView[] {
    const Client = this.getClient(slug);
    if (!Client) return [];
    return this.scriptExecutions.filter((Execution) => Execution.Client?.UUID === Client.UUID);
  }

  /**
   * Script executions the server currently knows about, in its own order.
   *
   * Includes settled ones: the server keeps a finished execution in the list so
   * an operator can see what a run did, and clears it on its own schedule. A UI
   * that only wants live work should filter on `Status === 'Pending'` rather
   * than expect this to empty itself.
   */
  getScriptExecutions(): ScriptExecutionView[] {
    return this.scriptExecutions;
  }

  /**
   * Devices announcing themselves on the network but not yet adopted. Empty on
   * a server that does not forward the list; adopting and identifying them
   * needs Edit mode and client management (see getCapabilities()).
   */
  getPendingAdoption(): PendingAdoptionView[] {
    return this.pendingAdoption;
  }

  getMode(): AppMode {
    return this.mode;
  }

  getAlertsEnabled(): boolean {
    return this.alertsEnabled;
  }

  // --- Commands (all slug-based) -----------------------------------------

  private command<K extends CommandName>(name: K, args: CommandArgs[K]): Promise<CommandResult> {
    return new Promise((resolve) => {
      if (!this.socket || this.state !== 'connected') {
        resolve({ ok: false, detail: 'Not connected' });
        return;
      }
      this.socket.emit(COMMAND_EVENT, name, args, (response: CommandResult | undefined) => {
        resolve(
          response && typeof response === 'object' ? response : { ok: false, detail: 'No response' }
        );
      });
    });
  }

  // Wake-on-LAN
  wolAll = (): Promise<CommandResult> => this.command('wol.all', {});
  wolClient = (slug: string): Promise<CommandResult> => this.command('wol.client', { slug });
  wolGroup = (slug: string): Promise<CommandResult> => this.command('wol.group', { slug });
  wolTag = (slug: string): Promise<CommandResult> => this.command('wol.tag', { slug });

  // Scripts (scriptSlug = script folder ID)
  runScriptOnAll = (scriptSlug: string): Promise<CommandResult> =>
    this.command('script.all', { scriptSlug });
  runScriptOnClient = (slug: string, scriptSlug: string): Promise<CommandResult> =>
    this.command('script.client', { slug, scriptSlug });
  runScriptOnGroup = (slug: string, scriptSlug: string): Promise<CommandResult> =>
    this.command('script.group', { slug, scriptSlug });
  runScriptOnTag = (slug: string, scriptSlug: string): Promise<CommandResult> =>
    this.command('script.tag', { slug, scriptSlug });

  // Integrated events (eventSlug = IntegratedAction ID)
  triggerEventOnAll = (eventSlug: string): Promise<CommandResult> =>
    this.command('event.all', { eventSlug });
  triggerEventOnClient = (slug: string, eventSlug: string): Promise<CommandResult> =>
    this.command('event.client', { slug, eventSlug });
  triggerEventOnGroup = (slug: string, eventSlug: string): Promise<CommandResult> =>
    this.command('event.group', { slug, eventSlug });
  triggerEventOnTag = (slug: string, eventSlug: string): Promise<CommandResult> =>
    this.command('event.tag', { slug, eventSlug });

  // Alerts
  alertsOn = (): Promise<CommandResult> => this.command('alerts.set', { enabled: true });
  alertsOff = (): Promise<CommandResult> => this.command('alerts.set', { enabled: false });
  alertsToggle = (): Promise<CommandResult> => this.command('alerts.toggle', {});

  // Show / Edit mode
  enterShowMode = (): Promise<CommandResult> => this.command('mode.set', { mode: 'SHOW' });
  enterEditMode = (): Promise<CommandResult> => this.command('mode.set', { mode: 'EDIT' });
  toggleMode = (): Promise<CommandResult> => this.command('mode.toggle', {});

  // Client-list layout. Applied by the desktop and by every Web UI browser.
  // Servers before 3.34 answer these with "Unknown command".
  setView = (mode: ViewMode): Promise<CommandResult> => this.command('view.set', { mode });
  enterCompactView = (): Promise<CommandResult> => this.setView('compact');
  /** The full-size tiles (the "grid" layout). */
  enterExpandedView = (): Promise<CommandResult> => this.setView('grid');
  enterListView = (): Promise<CommandResult> => this.setView('list');
  /** Compact on or off. */
  toggleView = (): Promise<CommandResult> => this.command('view.toggle', {});

  // Monitoring check actions (method = check type, e.g. `pjlink`; actionId =
  // one of its actions, e.g. `input.set`). `value` fills the action's first
  // parameter; `params` names any of them. Server 3.34+.
  runActionOnMonitor = (
    slug: string,
    method: string,
    actionId: string,
    value?: string | number,
    params?: Record<string, unknown>
  ): Promise<CommandResult> =>
    this.command('monitor.action', {
      slug,
      method,
      actionId,
      ...WithValue(value),
      ...(params ? { params } : {}),
    });

  // FreeKiosk terminal commands (commandId from FREEKIOSK_COMMANDS; `value` for
  // brightness and volume, 0-100). Server 3.34+.
  runFreeKioskCommandOnTerminal = (
    slug: string,
    commandId: string,
    value?: string | number
  ): Promise<CommandResult> =>
    this.command('freekiosk.terminal', { slug, commandId, ...WithValue(value) });
  runFreeKioskCommandOnGroup = (
    slug: string,
    commandId: string,
    value?: string | number
  ): Promise<CommandResult> =>
    this.command('freekiosk.group', { slug, commandId, ...WithValue(value) });
  runFreeKioskCommandOnTag = (
    slug: string,
    commandId: string,
    value?: string | number
  ): Promise<CommandResult> =>
    this.command('freekiosk.tag', { slug, commandId, ...WithValue(value) });
  runFreeKioskCommandOnAll = (commandId: string, value?: string | number): Promise<CommandResult> =>
    this.command('freekiosk.all', { commandId, ...WithValue(value) });

  // Dummy clients: deliver a heartbeat, as OSC /API/Dummy/<slug>/Heartbeat
  // does. The integration's own address is not recorded as the dummy's IP.
  // Server 3.34+.
  sendDummyHeartbeat = (slug: string): Promise<CommandResult> =>
    this.command('dummy.heartbeat', { slug });

  // The execution panel. Retry re-runs every failed execution the server can
  // retry (see IsRetryableExecution); clear drops finished rows and leaves
  // anything queued or running. Server 3.34+.
  retryFailedExecutions = (): Promise<CommandResult> => this.command('executions.retryFailed', {});
  clearSettledExecutions = (): Promise<CommandResult> =>
    this.command('executions.clearSettled', {});

  // Modals — these drive the desktop app's window only; the web UI ignores them.
  openClientModal = (slug: string): Promise<CommandResult> =>
    this.command('modal.openClient', { slug });
  closeAllModals = (): Promise<CommandResult> => this.command('modal.closeAll', {});

  // Misc
  saveShow = (): Promise<CommandResult> => this.command('show.save', {});

  // Shutdown — closes the ShowTrak Server itself, not a client. The graceful
  // form can be halted by an unsaved-changes or show-mode prompt on the desktop;
  // the force form closes regardless. Gate these behind a confirmation.
  shutdownServer = (): Promise<CommandResult> => this.command('system.shutdown', {});
  forceShutdownServer = (): Promise<CommandResult> => this.command('system.shutdownForce', {});

  // --- Pairing -----------------------------------------------------------

  /**
   * Exchange a PIN (or a scanned code, or nothing when the workspace has no PIN)
   * for a device token. Static because pairing is not a session: it opens its
   * own short-lived socket and closes it again, and the caller then `connect()`s
   * with the token like any other device would.
   */
  static pair(options: PairOptions): Promise<PairResult> {
    return Pair(options);
  }

  // --- Management (rpc) ---------------------------------------------------

  /**
   * Call one of the server's shared IPC handlers.
   *
   * Available to PAIRED DEVICES ONLY — an API-key session is refused by the
   * server, and short-circuited here so an integration gets a `forbidden`
   * without a pointless round trip.
   */
  rpc<T = unknown>(channel: RpcChannel, args: unknown[] = []): Promise<RpcResult<T>> {
    return new Promise((resolve) => {
      if (!this.socket || this.state !== 'connected') {
        resolve({ ok: false, code: 'not_connected' });
        return;
      }
      if (!this.isDevice) {
        resolve({ ok: false, code: 'forbidden' });
        return;
      }
      this.socket.emit('rpc', channel, args, (response: unknown) => {
        resolve(ToRpcResult<T>(response));
      });
    });
  }

  /**
   * What this session may mutate right now.
   *
   * Cached from the last read and refreshed on mode changes, so a UI can call it
   * per render without a round trip. It is a UI affordance only — the server
   * re-authorises every call regardless of what this reports.
   */
  getCapabilities(): Capabilities {
    const Edit = this.mode === 'EDIT';
    const Allowed = this.isDevice;
    const P = this.permissions;
    return {
      editMode: Edit,
      clientManagement: Allowed && Edit && (P?.clientManagement ?? true),
      groupManagement: Allowed && Edit && (P?.groupManagement ?? true),
      monitoringManagement: Allowed && Edit && (P?.monitoringManagement ?? true),
      alertManagement: Allowed && Edit && (P?.alertManagement ?? true),
      identify: Allowed && (P?.identify ?? true),
      monitoringActions: Allowed && (P?.monitoringActions ?? true),
      scripts: P?.scripts ?? true,
      remoteScripts: Allowed && (P?.remoteScripts ?? false),
      wol: P?.wol ?? true,
    };
  }

  /**
   * Probe what this session may actually do, by asking the server.
   *
   * The permission settings themselves are unreadable from a remote surface (they
   * live behind settings channels, which are deliberately unreachable), so the
   * only honest way to know is to try. Identify is probed with a slug that cannot
   * exist: an allowed call comes back as a handler error about the missing
   * client, a forbidden one never reaches the handler at all — which is exactly
   * the distinction being probed for.
   */
  async refreshCapabilities(): Promise<Capabilities> {
    if (!this.isDevice || this.state !== 'connected') {
      this.permissions = null;
      return this.getCapabilities();
    }
    const Previous = this.permissions;
    // `null` when the answer says nothing about the permission: in SHOW mode the
    // server refuses every management call with edit_mode_required BEFORE it
    // looks at the permission, so a probe made then cannot tell. The last known
    // answer (or the optimistic default) stands, and the probe runs again when
    // the server enters EDIT mode.
    const Probe = async (channel: RpcChannel, args: unknown[]): Promise<boolean | null> => {
      const Result = await this.rpc(channel, args);
      // Only an authorisation refusal means "not permitted". A handler that ran
      // and failed (bad id, missing client) proves the permission IS granted.
      if (Result.ok) return true;
      if (Result.code === 'edit_mode_required') return null;
      return Result.code !== 'forbidden';
    };
    const Known = (answer: boolean | null, key: keyof SurfacePermissionSnapshot): boolean =>
      answer ?? Previous?.[key] ?? true;
    const NoSuchSlug = '__showtrak_capability_probe__';
    this.permissions = {
      clientManagement: Known(
        await Probe(RPC_CHANNELS.UpdateClient, [NoSuchSlug, {}]),
        'clientManagement'
      ),
      groupManagement: Known(await Probe(RPC_CHANNELS.RenameGroup, [-1, '']), 'groupManagement'),
      monitoringManagement: Known(
        await Probe(RPC_CHANNELS.RunMonitoringCheckNow, [-1]),
        'monitoringManagement'
      ),
      alertManagement: Known(
        await Probe(RPC_CHANNELS.SetAlertRuleEnabled, [-1, false]),
        'alertManagement'
      ),
      identify: Known(await Probe(RPC_CHANNELS.IdentifyClient, [NoSuchSlug]), 'identify'),
      // No target -1 exists, so a permitted call fails in the handler instead.
      monitoringActions: Known(
        await Probe(RPC_CHANNELS.RunMonitoringAction, [[-1], '', '', {}, null]),
        'monitoringActions'
      ),
      scripts: true,
      // An empty event id fails the handler's validation, so a permitted call
      // changes nothing and a forbidden one never reaches it. Off until proven,
      // as the server's default is off.
      remoteScripts:
        (await Probe(RPC_CHANNELS.TriggerIntegratedEvent, ['', []])) ??
        Previous?.remoteScripts ??
        false,
      wol: true,
    };
    this.emit('capabilitiesChanged');
    return this.getCapabilities();
  }

  // Reads. Available to any session that may connect — no mode or permission
  // gate — so these are the safe things for a UI to call on first paint.
  //
  // The return shapes are NOT uniform, and the types below say so rather than
  // pretending otherwise: GetClient answers the client or null, while the
  // history readers answer their array directly. Typing a bare array as a
  // [Err, Data] tuple fails silently — the first sample becomes the "error".

  /** The full server-side client record, with every field the desktop shows. */
  getClientDetail = (uuid: string) => this.rpc<ClientDetail | null>(RPC_CHANNELS.GetClient, [uuid]);

  /** Online/degraded timeline, oldest first. The desktop's status blocks. */
  getClientHistory = (uuid: string) =>
    this.rpc<HistorySample[]>(RPC_CHANNELS.GetClientHistory, [uuid]);

  /** One series per USB device seen, whether or not it is connected now. */
  getClientUsbHistory = (uuid: string) =>
    this.rpc<NamedHistorySeries[]>(RPC_CHANNELS.GetClientUSBHistory, [uuid]);

  /** One series per watched application. */
  getClientApplicationHistory = (uuid: string) =>
    this.rpc<NamedHistorySeries[]>(RPC_CHANNELS.GetClientApplicationHistory, [uuid]);

  /** One series per display. */
  getClientDisplayHistory = (uuid: string) =>
    this.rpc<NamedHistorySeries[]>(RPC_CHANNELS.GetClientDisplayHistory, [uuid]);
  /** One series per audio endpoint, network interface, volume or system check. */
  getClientAudioHistory = (uuid: string) =>
    this.rpc<ClientHistorySeries[]>(RPC_CHANNELS.GetClientAudioHistory, [uuid]);
  getClientNetworkHistory = (uuid: string) =>
    this.rpc<ClientHistorySeries[]>(RPC_CHANNELS.GetClientNetworkHistory, [uuid]);
  getClientStorageHistory = (uuid: string) =>
    this.rpc<ClientHistorySeries[]>(RPC_CHANNELS.GetClientStorageHistory, [uuid]);
  getClientSystemCheckHistory = (uuid: string) =>
    this.rpc<ClientHistorySeries[]>(RPC_CHANNELS.GetClientSystemCheckHistory, [uuid]);
  /** CPU and RAM readings for the usage charts. */
  getClientVitalsHistory = (uuid: string) =>
    this.rpc<ClientVitalsHistory>(RPC_CHANNELS.GetClientVitalsHistory, [uuid]);
  /** Every show variable as this client resolves it. */
  getClientVariables = (uuid: string) =>
    this.rpc<ClientVariableView[]>(RPC_CHANNELS.GetClientVariables, [uuid]);
  getAllMonitoringTargets = () => this.rpc<ResultTuple>(RPC_CHANNELS.GetAllMonitoringTargets, []);

  // Entity views. Readers answer the value directly (null or [] when the id is
  // unknown), not a [Err, Data] tuple. Ids are the bare ones — see EntityAddress.

  /** A monitoring target with every check. */
  getMonitoringTarget = (targetId: number) =>
    this.rpc<MonitoringTargetView | null>(RPC_CHANNELS.GetMonitoringTarget, [targetId]);
  /** One check's online/degraded timeline. */
  getMonitoringCheckHistory = (checkId: number) =>
    this.rpc<HistorySample[]>(RPC_CHANNELS.GetMonitoringCheckHistory, [checkId]);
  /** Every check type, with the actions each declares. */
  getMonitoringMethods = () =>
    this.rpc<MonitoringMethodView[]>(RPC_CHANNELS.GetMonitoringMethods, []);
  getDummyClient = (uuid: string) =>
    this.rpc<DummyClientView | null>(RPC_CHANNELS.GetDummyClient, [uuid]);
  getDummyClientHistory = (uuid: string) =>
    this.rpc<HistorySample[]>(RPC_CHANNELS.GetDummyClientHistory, [uuid]);
  /** A terminal's readings, alarms and settings. Its API key is never included. */
  getFreeKioskTerminal = (uuid: string) =>
    this.rpc<FreeKioskTerminalView | null>(RPC_CHANNELS.GetFreeKioskTerminal, [uuid]);
  /** The reading registry: every metric, its section, unit and alarm operators. */
  getFreeKioskMetrics = () =>
    this.rpc<FreeKioskMetricCatalog | null>(RPC_CHANNELS.GetFreeKioskMetrics, []);
  getFreeKioskCommands = () =>
    this.rpc<FreeKioskCommandDef[]>(RPC_CHANNELS.GetFreeKioskCommands, []);
  /** Every reading's samples for a terminal, in one call. */
  getFreeKioskHistory = (uuid: string) =>
    this.rpc<FreeKioskMetricSeries[]>(RPC_CHANNELS.GetFreeKioskHistory, [uuid]);
  /** The last 24 hours of the audit log, newest first, filtered by `query`. */
  getAuditLog = (query: AuditLogQuery) => this.rpc<AuditLogPage>(RPC_CHANNELS.GetAuditLog, [query]);

  /**
   * Run a monitoring action on a target's checks of one type. `checkIds` null
   * means every check of that type on the targets.
   */
  runMonitoringAction = (
    targetIds: number[],
    method: string,
    actionId: string,
    params: Record<string, unknown> = {},
    checkIds: number[] | null = null
  ) =>
    this.rpc<ResultTuple<MonitoringActionSummary>>(RPC_CHANNELS.RunMonitoringAction, [
      targetIds,
      method,
      actionId,
      params,
      checkIds,
    ]);

  /** Send a FreeKiosk command, with `{ value }` for a slider. EDIT mode only. */
  freeKioskCommand = (uuids: string[], commandId: string, args?: Record<string, unknown>) =>
    this.rpc<ResultTuple<FreeKioskCommandSummary>>(
      RPC_CHANNELS.FreeKioskCommand,
      args ? [uuids, commandId, args] : [uuids, commandId]
    );
  /** A screenshot of a terminal's screen, as a data URL. EDIT mode only. */
  freeKioskCaptureScreenshot = (uuid: string) =>
    this.rpc<ResultTuple<FreeKioskCapture>>(RPC_CHANNELS.FreeKioskCaptureScreenshot, [uuid]);
  /**
   * Start streaming a monitor's live audio meters to this session, and answer
   * the current ones. Frames then arrive as `liveLevels` events until
   * closeLiveLevels, opening another monitor, or disconnecting. A server
   * reconnect ends the stream, so open it again on `connect`.
   *
   * Paired devices only. A monitor with no streaming checks answers an empty
   * Checks list. Servers predating the stream never answer; that resolves as
   * `failed` after a few seconds rather than hanging.
   */
  openLiveLevels(targetId: number): Promise<RpcResult<MonitorLiveLevelsSnapshot>> {
    return new Promise((resolve) => {
      if (!this.socket || this.state !== 'connected') {
        resolve({ ok: false, code: 'not_connected' });
        return;
      }
      if (!this.isDevice) {
        resolve({ ok: false, code: 'forbidden' });
        return;
      }
      let Settled = false;
      const Timer = setTimeout(() => {
        if (Settled) return;
        Settled = true;
        resolve({ ok: false, code: 'failed' });
      }, 5000);
      this.socket.emit('monitorlive:open', targetId, (response: unknown) => {
        if (Settled) return;
        Settled = true;
        clearTimeout(Timer);
        resolve(ToRpcResult<MonitorLiveLevelsSnapshot>(response));
      });
    });
  }

  /** Stop the live meters this session opened. Safe when none are open. */
  closeLiveLevels(): void {
    if (this.socket && this.state === 'connected') this.socket.emit('monitorlive:close');
  }

  /**
   * Retry these failed executions, by RequestID. Rows that cannot be retried are
   * left alone. Remote script permission (off by default). Server 3.32+.
   */
  retryExecutions = (requestIds: string[]) =>
    this.rpc<ResultTuple<{ Retried: number }>>(RPC_CHANNELS.RetryExecutions, [requestIds]);

  /**
   * An execution's console: the entries after `afterSeq` (0 for everything the
   * server kept). Poll with the answer's LastSeq while it is on screen; nothing
   * is pushed. Remote script permission. Server 3.32+.
   */
  getExecutionOutput = (requestId: string, afterSeq = 0) =>
    this.rpc<ResultTuple<ExecutionOutputView>>(RPC_CHANNELS.GetExecutionOutput, [
      requestId,
      afterSeq,
    ]);

  /** Re-poll terminals now rather than at their next interval. */
  freeKioskRunNow = (uuids: string[]) =>
    this.rpc<ResultTuple>(RPC_CHANNELS.FreeKioskRunNow, [uuids]);
  getAllAlertRules = () => this.rpc<ResultTuple>(RPC_CHANNELS.GetAllAlertRules, []);

  // Identify. Mutates nothing and is deliberately allowed in SHOW mode — it is
  // the reason to have a phone in your hand at a rack in the first place.
  identify = (slug: string): Promise<CommandResult> => this.command('identify.client', { slug });
  stopIdentify = (slug: string): Promise<CommandResult> => this.command('identify.stop', { slug });

  // Client management.
  updateClient = (uuid: string, changes: Record<string, unknown>) =>
    this.rpc<ResultTuple>(RPC_CHANNELS.UpdateClient, [uuid, changes]);
  unadoptClient = (uuid: string) => this.rpc<ResultTuple>(RPC_CHANNELS.UnadoptClient, [uuid]);
  adoptDevice = (uuid: string) => this.rpc<ResultTuple>(RPC_CHANNELS.AdoptDevice, [uuid]);

  // Group management.
  createGroup = (title: string) => this.rpc<ResultTuple>(RPC_CHANNELS.CreateGroup, [title]);
  renameGroup = (groupId: number, title: string) =>
    this.rpc<ResultTuple>(RPC_CHANNELS.RenameGroup, [groupId, title]);
  deleteGroup = (groupId: number) => this.rpc<ResultTuple>(RPC_CHANNELS.DeleteGroup, [groupId]);

  // Monitoring management.
  runMonitoringCheckNow = (targetId: number) =>
    this.rpc<ResultTuple>(RPC_CHANNELS.RunMonitoringCheckNow, [targetId]);
  deleteMonitoringTarget = (targetId: number) =>
    this.rpc<ResultTuple>(RPC_CHANNELS.DeleteMonitoringTarget, [targetId]);

  // Alert rules.
  setAlertRuleEnabled = (ruleId: number, enabled: boolean) =>
    this.rpc<ResultTuple>(RPC_CHANNELS.SetAlertRuleEnabled, [ruleId, enabled]);
  deleteAlertRule = (ruleId: number) =>
    this.rpc<ResultTuple>(RPC_CHANNELS.DeleteAlertRule, [ruleId]);

  // --- Internal: socket wiring + cache maintenance -----------------------

  private wire(socket: Socket): void {
    socket.on('connect', () => {
      this.setState('connected');
      this.emit('connect');
    });
    socket.on('disconnect', (reason: string) => {
      this.setState('disconnected');
      this.emit('disconnect', String(reason));
    });
    socket.on('connect_error', (err: Error) => {
      this.setState('error');
      this.emit('error', err?.message || 'Connection error');
    });

    socket.on('SetFullClientList', (clients: ClientView[], groups: GroupView[]) => {
      this.clientsBySlug.clear();
      this.clientsByUuid.clear();
      for (const client of clients || []) this.indexClient(client);
      this.groupsBySlug.clear();
      for (const group of groups || []) {
        if (group.Slug) this.groupsBySlug.set(group.Slug, group);
      }
      this.emit('clientsChanged');
    });

    socket.on('ClientUpdated', (client: ClientView) => {
      if (!client) return;
      this.indexClient(client);
      this.emit('clientsChanged');
    });

    // Every auxiliary entity kind, wired from one table. Each keeps its own map,
    // so a full-list replacement for one kind never touches another — and adding
    // a kind means adding a row to AUXILIARY_ENTITIES, with no handler to forget.
    for (const Entity of AUXILIARY_ENTITIES) {
      const Store = this.auxiliaryBySlug.get(Entity.Kind)!;

      socket.on(Entity.ListEvent, (entities: ClientView[]) => {
        Store.clear();
        for (const Received of entities || []) {
          if (Received && Received.Slug) Store.set(Received.Slug, Received);
        }
        this.emit('clientsChanged');
      });

      socket.on(Entity.UpdateEvent, (entity: ClientView) => {
        if (!entity || !entity.Slug) return;
        Store.set(entity.Slug, entity);
        this.emit('clientsChanged');
      });
    }

    socket.on('SetTagList', (tags: TagView[]) => {
      this.tagsBySlug.clear();
      for (const tag of tags || []) {
        if (tag.Slug) this.tagsBySlug.set(tag.Slug, tag);
      }
      this.emit('tagsChanged');
    });

    socket.on('SetScriptList', (scripts: ScriptView[]) => {
      this.scriptsById.clear();
      for (const script of scripts || []) {
        if (script.ID) this.scriptsById.set(script.ID, script);
      }
      this.emit('scriptsChanged');
    });

    socket.on('ModeUpdated', (mode: AppMode) => {
      this.mode = mode === 'EDIT' ? 'EDIT' : 'SHOW';
      this.emit('modeChanged', this.mode);
      // Mode is half of every management capability, so a UI driven by
      // getCapabilities() has to re-read when it flips.
      this.emit('capabilitiesChanged');
      // A probe made in SHOW mode could not see the management permissions
      // (see refreshCapabilities), so look again now that it can.
      if (this.mode === 'EDIT' && this.isDevice) void this.refreshCapabilities().catch(() => {});
    });

    // The device's pairing was revoked at the desk. Reconnecting will only be
    // refused, so surface it as its own event rather than letting the app spin
    // in a reconnect loop against a dead credential.
    socket.on('revoked', () => {
      this.emit('revoked');
    });

    // The whole list, every time it changes — so a device that connects
    // mid-run sees work already in flight instead of only what starts later.
    socket.on('UpdateScriptExecutions', (executions: ScriptExecutionView[]) => {
      this.scriptExecutions = Array.isArray(executions) ? executions : [];
      this.emit('scriptExecutionsChanged', this.scriptExecutions);
    });

    socket.on('MonitorLiveLevels:Frames', (snapshot: MonitorLiveLevelsSnapshot) => {
      if (snapshot && typeof snapshot === 'object') this.emit('liveLevels', snapshot);
    });

    socket.on('AlertActionsUpdated', (enabled: boolean) => {
      this.alertsEnabled = !!enabled;
      this.emit('alertsChanged', this.alertsEnabled);
    });

    // The whole list every time, so a device that connects late still sees the
    // devices already waiting.
    socket.on('SetDevicesPendingAdoption', (devices: PendingAdoptionView[]) => {
      this.pendingAdoption = Array.isArray(devices)
        ? devices.filter((Device) => Device && typeof Device.UUID === 'string')
        : [];
      this.emit('pendingAdoptionChanged', this.pendingAdoption);
    });

    socket.on('CreateShowTrakAlert', (alert: ShowTrakAlert) => {
      if (alert && typeof alert === 'object') this.emit('alert', alert);
    });
    socket.on('PlaySound', (name: AlertSoundName) => {
      if (typeof name === 'string') this.emit('playSound', name);
    });
    socket.on('PlayCustomAudio', (audio: CustomAlertAudio) => {
      if (audio && typeof audio === 'object') this.emit('playCustomAudio', audio);
    });
    socket.on('AudioAssetsUpdated', () => this.emit('audioAssetsChanged'));
    socket.on('SetFullMonitoringActionFavouriteList', (list: MonitoringActionFavouriteView[]) => {
      this.favourites = Array.isArray(list) ? list : [];
      this.emit('favouritesChanged', this.favourites);
    });
    socket.on('SetFullAlertRuleList', (rules: AlertRuleView[]) => {
      this.alertRules = Array.isArray(rules) ? rules : [];
      this.emit('alertRulesChanged', this.alertRules);
    });
    socket.on('AuditLogAppended', (entry: unknown) => this.emit('auditLogAppended', entry));
    socket.on('UpdateSettings', (settings: PublicSetting[]) => {
      this.publicSettings = Array.isArray(settings) ? settings : [];
      this.emit('settingsChanged', this.publicSettings);
    });

    socket.on('Notify', (message: string, type?: string, duration?: number) => {
      this.emit('notify', String(message ?? ''), String(type ?? 'info'), Number(duration ?? 0));
    });
  }

  private indexClient(client: ClientView): void {
    // A client may have been re-slugged: drop any stale slug entry pointing at
    // this UUID before re-indexing under its current slug.
    const previous = this.clientsByUuid.get(client.UUID);
    if (previous && previous.Slug && previous.Slug !== client.Slug) {
      this.clientsBySlug.delete(previous.Slug);
    }
    this.clientsByUuid.set(client.UUID, client);
    if (client.Slug) this.clientsBySlug.set(client.Slug, client);
  }
}
