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
import type {
  AppMode,
  ClientView,
  CommandArgs,
  CommandName,
  CommandResult,
  GroupView,
  ScriptView,
  TagScope,
  TagView,
} from './protocol.js';

export interface ConnectOptions {
  host: string;
  /** Defaults to DEFAULT_SERVER_PORT (3000). */
  port?: number;
  /** Required — the server refuses connections without a matching API key. */
  apiKey: string;
  /** Reconnect automatically (default true). */
  reconnect?: boolean;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

type Listener<T extends unknown[]> = (...args: T) => void;

interface Events {
  connect: [];
  disconnect: [reason: string];
  error: [message: string];
  stateChanged: [state: ConnectionState];
  clientsChanged: [];
  tagsChanged: [];
  modeChanged: [mode: AppMode];
  alertsChanged: [enabled: boolean];
  scriptsChanged: [];
  notify: [message: string, type: string, duration: number];
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

export class ShowTrakControlClient {
  private socket: Socket | null = null;
  private state: ConnectionState = 'disconnected';

  // Live caches, keyed by slug for O(1) feedback lookups. Monitors and dummies
  // are client-shaped and share the slug namespace with real clients, but are
  // kept in their own maps so a full-list replacement for one entity type never
  // disturbs the others. getAllClients()/getClient() read across all three.
  private clientsBySlug = new Map<string, ClientView>();
  private clientsByUuid = new Map<string, ClientView>();
  private monitorsBySlug = new Map<string, ClientView>();
  private dummiesBySlug = new Map<string, ClientView>();
  private groupsBySlug = new Map<string, GroupView>();
  private tagsBySlug = new Map<string, TagView>();
  private scriptsById = new Map<string, ScriptView>();
  private mode: AppMode = 'SHOW';
  private alertsEnabled = true;

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
    notify: new Set(),
  };

  // --- Lifecycle ---------------------------------------------------------

  connect(options: ConnectOptions): void {
    this.disconnect();
    const port = options.port ?? DEFAULT_SERVER_PORT;
    const url = `http://${options.host}:${port}${SDK_NAMESPACE}`;
    this.setState('connecting');
    this.socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: options.reconnect !== false,
      auth: { apiKey: options.apiKey },
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
    this.monitorsBySlug.clear();
    this.dummiesBySlug.clear();
    this.groupsBySlug.clear();
    this.tagsBySlug.clear();
    this.scriptsById.clear();
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

  // Look up an entity by slug across clients, monitors and dummies (one shared,
  // collision-free namespace). Real clients win if a slug ever appears twice.
  getClient(slug: string): ClientView | undefined {
    return (
      this.clientsBySlug.get(slug) ?? this.monitorsBySlug.get(slug) ?? this.dummiesBySlug.get(slug)
    );
  }

  // Every controllable entity: real clients + monitoring targets + dummies. Feeds
  // the summary counts and the per-entity status/label variables.
  getAllClients(): ClientView[] {
    return [
      ...this.clientsBySlug.values(),
      ...this.monitorsBySlug.values(),
      ...this.dummiesBySlug.values(),
    ];
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

  /** True when a client falls inside a tag's dynamic scope. Mirrors the server's
   *  ScriptWhitelistManager.IsClientAllowed so companion feedback matches dispatch. */
  private clientInTagScope(scope: TagScope | undefined, client: ClientView): boolean {
    if (!scope || scope.Workspace) return true;
    if (!client || !client.UUID) return false;
    if (scope.Clients.includes(client.UUID)) return true;
    if (client.GroupID != null && scope.Groups.includes(Number(client.GroupID))) return true;
    return false;
  }

  /** Aggregate status of a group's members (degraded > online > idle > offline). */
  getGroupStatus(slug: string): ClientStatus | undefined {
    const group = this.groupsBySlug.get(slug);
    if (!group) return undefined;
    const members = this.getAllClients().filter((c) => Number(c.GroupID) === group.GroupID);
    return this.aggregateStatus(members);
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

  // Expanded / Compact view
  enterCompactView = (): Promise<CommandResult> => this.command('view.set', { compact: true });
  enterExpandedView = (): Promise<CommandResult> => this.command('view.set', { compact: false });
  toggleView = (): Promise<CommandResult> => this.command('view.toggle', {});

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

    // Monitoring targets — client-shaped, kept in their own map so a full-list
    // replacement here never touches real clients or dummies.
    socket.on('SetFullMonitoringTargetList', (monitors: ClientView[]) => {
      this.monitorsBySlug.clear();
      for (const monitor of monitors || []) {
        if (monitor.Slug) this.monitorsBySlug.set(monitor.Slug, monitor);
      }
      this.emit('clientsChanged');
    });

    socket.on('MonitoringTargetUpdated', (monitor: ClientView) => {
      if (!monitor || !monitor.Slug) return;
      this.monitorsBySlug.set(monitor.Slug, monitor);
      this.emit('clientsChanged');
    });

    // Dummy clients — same treatment as monitoring targets.
    socket.on('SetFullDummyClientList', (dummies: ClientView[]) => {
      this.dummiesBySlug.clear();
      for (const dummy of dummies || []) {
        if (dummy.Slug) this.dummiesBySlug.set(dummy.Slug, dummy);
      }
      this.emit('clientsChanged');
    });

    socket.on('DummyClientUpdated', (dummy: ClientView) => {
      if (!dummy || !dummy.Slug) return;
      this.dummiesBySlug.set(dummy.Slug, dummy);
      this.emit('clientsChanged');
    });

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
    });

    socket.on('AlertActionsUpdated', (enabled: boolean) => {
      this.alertsEnabled = !!enabled;
      this.emit('alertsChanged', this.alertsEnabled);
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
