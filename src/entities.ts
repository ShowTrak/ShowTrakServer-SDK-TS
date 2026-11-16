// The full views behind each entity's screen — what the desktop's view modal
// reads for a monitoring target, a dummy client, a FreeKiosk terminal, and the
// audit log every kind of entity has a slice of.
//
// The pushed ClientView projections of these entities carry almost nothing
// (identity and status). Everything a detail screen shows comes from the rpc
// readers below, so these shapes are the server's own views, trimmed to the
// fields a screen actually displays. Index signatures stay where the server's
// object carries more than is declared, so a newer server's extra columns are
// tolerated rather than a type error.

import type { HistorySample } from './management.js';

// --- Monitoring targets ----------------------------------------------------

export interface MonitoringCheckView {
  CheckID: number;
  TargetID: number;
  Name: string;
  Address: string;
  /** The check type: `ping`, `http`, `qlab5`, … */
  Method: string;
  Settings: Record<string, unknown>;
  DegradedThresholdMs: number;
  FailureThreshold: number | null;
  EffectiveFailureThreshold: number;
  ConsecutiveFailures: number;
  Weight: number;
  Online: boolean;
  Degraded: boolean;
  /** Null until the check has run once. */
  LastChecked: number | null;
  LastLatencyMs: number | null;
  LastError: string | null;
  LastSuccessAt: number | null;
  /** Choices the device itself reported for an action parameter, by parameter key. */
  ActionOptions?: Record<string, Array<{ value: string; label: string }>>;
  [key: string]: unknown;
}

export interface MonitoringTargetView {
  TargetID: number;
  Nickname: string;
  Interval: number;
  GroupID: number | null;
  Slug: string | null;
  FailureThreshold: number | null;
  Address: string;
  Method: string;
  Online: boolean;
  Degraded: boolean;
  LastChecked: number | null;
  LastLatencyMs: number | null;
  LastError: string | null;
  LastSuccessAt: number | null;
  CheckCount: number;
  Checks: MonitoringCheckView[];
  [key: string]: unknown;
}

export interface MonitoringActionParam {
  Key: string;
  Label: string;
  Type: string;
  Default?: unknown;
  Options?: Array<string | { value: string; label?: string }>;
}

/** A control a check type declares, such as "Start" on a QLab check. */
export interface MonitoringActionDef {
  ID: string;
  Label: string;
  /** Bootstrap Icons name without the `bi-` prefix. */
  Icon: string;
  Group: string;
  Params?: MonitoringActionParam[];
  Destructive?: boolean;
  /** May be sent even when every check of its type is offline. */
  AllowedWhileOffline?: boolean;
  Note?: string;
}

/** A check type, as GetMonitoringMethods lists them. */
export interface MonitoringMethodView {
  ID: string;
  Name: string;
  Actions: MonitoringActionDef[];
  [key: string]: unknown;
}

export interface MonitoringActionSummary {
  Total: number;
  Succeeded: number;
  Failed: number;
  Results: Array<{
    TargetID: number;
    CheckID: number;
    Nickname: string;
    Success: boolean;
    Error: string | null;
    Detail: string | null;
  }>;
}

// --- Dummy clients ---------------------------------------------------------

export type EntityState = 'IDLE' | 'ONLINE' | 'DEGRADED' | 'OFFLINE';

export interface DummyClientView {
  UUID: string;
  /** Its slug: the API / OSC address. */
  DummyID: string;
  Nickname: string;
  Hostname: string;
  IP: string | null;
  Interval: number;
  GroupID: number | null;
  State: EntityState;
  Online: boolean;
  Degraded: boolean;
  DegradedWarnings: string[];
  LastSeen: number | null;
  [key: string]: unknown;
}

// --- FreeKiosk terminals ---------------------------------------------------

export type FreeKioskMetricValue = string | number | boolean | null;

export interface FreeKioskAlarm {
  Key: string;
  Label: string;
  Value: FreeKioskMetricValue;
  Reason: string;
}

export interface FreeKioskTerminalView {
  UUID: string;
  Slug: string | null;
  Nickname: string;
  Hostname: string;
  Address: string;
  Port: number;
  /** The key itself never leaves the server for a remote surface. */
  HasApiKey: boolean;
  IP: string | null;
  Interval: number;
  TimeoutMs: number;
  GroupID: number | null;
  /** Monitoring switches and alarm conditions, keyed `G_<Section>_On`, `A_<Key>_On|Op|V|V2`. */
  Settings: Record<string, unknown>;
  State: EntityState;
  Online: boolean;
  Degraded: boolean;
  DegradedWarnings: string[];
  Alarms: FreeKioskAlarm[];
  Metrics: Record<string, FreeKioskMetricValue>;
  LastError: string | null;
  LastChecked: number | null;
  LastSuccessAt: number | null;
  LastLatencyMs: number | null;
  ControlEnabled: boolean | null;
  [key: string]: unknown;
}

export type FreeKioskDisplayMode = 'webview' | 'external_app' | 'media_player';

export interface FreeKioskMetricView {
  Key: string;
  Label: string;
  Type: 'number' | 'boolean' | 'enum' | 'string';
  Section: string;
  Chart: 'line' | 'blocks' | 'none';
  RequiresMode?: FreeKioskDisplayMode[];
  Unit?: string;
  Decimals?: number;
  Min?: number;
  Max?: number;
  Options?: string[];
  /** Breach operators this reading can alarm on. Empty: a reading only. */
  Operators: string[];
  DefaultOperator?: string;
  ThresholdUnit?: string;
  ThresholdScale?: number;
  Format?: 'duration' | 'dbm' | 'url' | 'megabytes' | 'raw';
  Advanced?: boolean;
  Note?: string;
}

export interface FreeKioskMetricGroup {
  Key: string;
  Label: string;
  DefaultOn: boolean;
  /** Always monitored; cannot be switched off. */
  Fixed?: boolean;
  Note?: string;
}

export interface FreeKioskMetricCatalog {
  Metrics: FreeKioskMetricView[];
  Sections: string[];
  Groups: FreeKioskMetricGroup[];
  [key: string]: unknown;
}

export interface FreeKioskMetricSample {
  ts: number;
  ok: boolean;
  n: number | null;
  s: string | null;
  breach: boolean;
}

export interface FreeKioskMetricSeries {
  MetricKey: string;
  Samples: FreeKioskMetricSample[];
}

export interface FreeKioskCommandDef {
  ID: string;
  Label: string;
  Icon?: string;
  Group: string;
  /** Display modes it applies in; absent means every mode. */
  Modes?: FreeKioskDisplayMode[];
  Destructive?: boolean;
  ExpectDisconnect?: boolean;
  /** May be sent to a selection of terminals at once. */
  Bulk?: boolean;
  /** Inputs it needs; a command with any is not offered in bulk. */
  Params?: unknown[];
  /** A slider command carries the metric it sets, for its starting value. */
  Metric?: string;
  [key: string]: unknown;
}

export interface FreeKioskCommandSummary {
  Total: number;
  Succeeded: number;
  Failed: number;
  Results: Array<{ UUID: string; Success: boolean; Error: string | null }>;
}

/** A capture from a terminal's screen or camera. */
export interface FreeKioskCapture {
  DataUrl: string;
  Bytes: number;
  Mime: string;
  CapturedAt: number;
}

// --- Live levels -------------------------------------------------------------
// A monitor's audio meters, streamed while a device has the monitor open. Only
// check types that can read meters stream them (the TASCAM MX-8A, with live
// levels turned on in its check).

export interface MonitorLiveLevelsChannel {
  /** The channel's id on the device, e.g. `in:3`. */
  ID: string;
  /** The block it belongs to, e.g. "Inputs" or "Outputs". */
  Group: string;
  Label: string;
  /** dBFS; null for no signal (−∞) or not read yet. */
  Db: number | null;
  /** Shown in the monitor view: its group is switched on there. */
  View?: boolean;
  /** Shown on the dashboard tile. */
  Tile?: boolean;
  /** The view may move this channel's fader and mute. */
  Control?: boolean;
  /** The fader in dB, null for −∞; absent until read. */
  Fader?: number | null;
  Muted?: boolean;
}

export interface MonitorLiveLevelsCheck {
  CheckID: number;
  Name: string;
  /** `connecting` until the first meters arrive; `unavailable` carries Message. */
  State: 'connecting' | 'live' | 'unavailable';
  Message: string | null;
  Channels: MonitorLiveLevelsChannel[];
}

/** Every streaming check on one monitor, sent in full on each update. */
export interface MonitorLiveLevelsSnapshot {
  TargetID: number;
  Checks: MonitorLiveLevelsCheck[];
}

// --- Alerts, sounds, favourites, settings -------------------------------------
// What the Web UI's alerts tray, sounds and editors live on. Paired devices are
// sent these on connect (rules, favourites, settings) and on every change.

/** An alert rule fired a "ShowTrak alert" action: a line for the alerts tray. */
export interface ShowTrakAlert {
  Title: string;
  Message: string;
  Severity: 'info' | 'success' | 'warning' | 'error';
  TriggerType?: string;
  /** The entity it is about, when there is one. */
  UUID?: string | null;
}

/** One of the built-in alert sounds, by name. */
export type AlertSoundName = 'Notification' | 'Alert' | 'Warning' | (string & {});

/** A custom alert sound, with its audio inline. */
export interface CustomAlertAudio {
  ID: string;
  Label: string;
  /** 0–200, where 100 is the file's own level. */
  Volume: number;
  DataURL: string;
}

/** A starred monitoring action, offered on a selection of monitors. */
export interface MonitoringActionFavouriteView {
  FavouriteID: number;
  Method: string;
  ActionID: string;
  Params: Record<string, unknown>;
  Label: string;
  Icon: string;
  Weight: number;
}

/** An alert rule, as the server lists them. */
export interface AlertRuleView {
  RuleID: number;
  Title: string;
  Enabled: boolean;
  TriggerTypes: string[];
  TriggerConfig?: Record<string, unknown>;
  Actions: Array<{ Type: string; Title?: string; Settings: Record<string, unknown> }>;
  Scope: { Workspace: boolean; Groups: number[]; Clients: string[]; Tags?: number[] };
  [key: string]: unknown;
}

/**
 * A setting a remote surface may read. Only the display keys ever reach a
 * device: UI_GROUP_COLUMN_COUNT, UI_DEFAULT_VIEW, UI_CLEAR_SELECTION_AFTER_ACTION
 * and UI_EXECUTION_PANEL_DWELL_SECONDS.
 */
export interface PublicSetting {
  Key: string;
  Value: unknown;
}

// --- Audit log ---------------------------------------------------------------

export type AuditEntityType = 'client' | 'monitor' | 'dummy' | 'freekiosk' | (string & {});
export type AuditCategory = 'status' | 'edit' | 'action';

export interface AuditLogQuery {
  EntityType?: AuditEntityType;
  EntityID?: string;
  Category?: AuditCategory;
  /** Case-insensitive substring over name, summary, details, changes and source. */
  Search?: string;
  /** Page backwards from this entry. */
  BeforeID?: number;
  /** 1–500; the server defaults to 200. */
  Limit?: number;
}

export interface AuditLogEntry {
  ID: number;
  Timestamp: number;
  EntityType: AuditEntityType;
  EntityID: string | null;
  EntityName: string | null;
  Category: AuditCategory;
  Severity: 'info' | 'success' | 'warning' | 'error';
  /** The sentence, as segments; `H` marks the ones to highlight. */
  Summary: Array<{ T: string; H?: 'entity' | 'device' | 'value' }>;
  Changes: Array<{ Field: string; From: string | null; To: string | null }>;
  Details: string[];
  /** Who did it: "ShowTrak Remote (iPad)", "SDK", the desk. */
  Source: string | null;
}

export interface AuditLogPage {
  /** Newest first. The server keeps the last 24 hours. */
  Entries: AuditLogEntry[];
  HasMore: boolean;
}

/**
 * How the audit log and the rpc readers address an entity, from the uuid its
 * ClientView projection is pushed with (`monitor:<id>`, `dummy:<uuid>`,
 * `kiosk:<uuid>`, or a bare client uuid).
 */
export function EntityAddress(uuid: string): { type: AuditEntityType; id: string } {
  if (uuid.startsWith('monitor:')) return { type: 'monitor', id: uuid.slice('monitor:'.length) };
  if (uuid.startsWith('dummy:')) return { type: 'dummy', id: uuid.slice('dummy:'.length) };
  if (uuid.startsWith('kiosk:')) return { type: 'freekiosk', id: uuid.slice('kiosk:'.length) };
  return { type: 'client', id: uuid };
}

export type { HistorySample };

// --- Client telemetry --------------------------------------------------------
// What a real client's hardware tabs read. All of it arrives on the pushed
// ClientView (and on GetClient), except the histories, which are rpc readers.

/** A collector's own health: whether it could read anything at all. */
export interface CollectorStatus {
  State: 'unknown' | 'ok' | 'error' | 'unsupported' | 'permission_denied' | (string & {});
  Message: string | null;
  Platform?: string;
  Backend?: string | null;
}

export interface TelemetryIssue<K extends string = string> {
  Kind: K;
  Message: string;
}

export interface StorageVolumeView {
  MountPoint: string;
  Name: string | null;
  FileSystem: string | null;
  Kind: 'internal' | 'external' | 'network' | 'unknown';
  TotalBytes: number;
  FreeBytes: number;
  ReadOnly: boolean | null;
  Health: 'ok' | 'warning' | 'failing' | null;
  IsConnected: boolean;
  IsCritical: boolean;
  Missing: boolean;
  Issues: TelemetryIssue[];
  Critical: {
    Name: string | null;
    MinFreePercent: number | null;
    MinFreeGB: number | null;
    RequireWritable: boolean;
    RequireHealthy: boolean;
  } | null;
}

export interface StorageStatusView {
  SampledAt: number | null;
  Status: CollectorStatus | null;
  Volumes: StorageVolumeView[];
}

export interface AudioEndpointView {
  EndpointID: string;
  Direction: 'input' | 'output';
  Name: string;
  Manufacturer: string | null;
  Transport: string | null;
  Channels: number | null;
  SampleRate: number | null;
  IsDefault: boolean;
  Volume: number | null;
  Muted: boolean | null;
  IsConnected: boolean;
  IsCritical: boolean;
  Missing: boolean;
  Issues: TelemetryIssue[];
  Critical: {
    Channels: number | null;
    SampleRate: number | null;
    RequireDefault: boolean;
    RequireUnmuted: boolean;
    MinVolume: number | null;
    MaxVolume: number | null;
  } | null;
}

export interface AudioDevicesView {
  SampledAt: number | null;
  Status: CollectorStatus | null;
  Capabilities: Record<string, unknown> | null;
  Endpoints: AudioEndpointView[];
}

export interface NetworkAddressStatus {
  family: string | number;
  address: string;
  netmask: string | null;
  cidr?: string | null;
  mac?: string | null;
  internal: boolean;
}

export interface NetworkInterfaceStatus {
  Name: string;
  MAC: string | null;
  Internal: boolean;
  Addresses: NetworkAddressStatus[];
  Gateway: string | null;
  IsConnected: boolean;
  IsCritical: boolean;
  Missing: boolean;
  Issues: TelemetryIssue[];
  Critical: {
    Family: 'IPv4' | 'IPv6' | null;
    Address: string | null;
    RangeStart: string | null;
    RangeEnd: string | null;
    Netmask: string | null;
    Gateway: string | null;
  } | null;
}

export interface NetworkStatusView {
  SampledAt: number | null;
  Capabilities: { Router: boolean } | null;
  Interfaces: NetworkInterfaceStatus[];
}

export interface PowerStatusSnapshot {
  SampledAt: number | null;
  Status: CollectorStatus | null;
  Battery: {
    Percent: number | null;
    Charging: boolean | null;
    TimeRemainingMinutes: number | null;
  } | null;
  OnBattery: boolean | null;
  LastSuspendAt: number | null;
  LastResumeAt: number | null;
}

export interface TemperaturesSnapshot {
  SampledAt: number | null;
  Status: CollectorStatus | null;
  Sensors: Array<{ Name: string; Kind: string; Celsius: number }>;
  ThermalState: 'nominal' | 'fair' | 'serious' | 'critical' | null;
}

/** Which system checks are monitored, and their limits. Null: not monitored. */
export interface ClientSystemChecks {
  Cpu: { MaxPercent: number | null; SustainSeconds: number } | null;
  Ram: { MaxPercent: number | null; SustainSeconds: number } | null;
  Uptime: { MaxDays: number | null } | null;
  Power: {
    RequireMains?: boolean;
    MinBatteryPercent?: number | null;
    ChargingBelowPercent?: number | null;
  } | null;
  Thermal: { MaxCelsius?: number | null; MaxThermalState?: string | null } | null;
}

export interface ClientResourceAlarm {
  Key: 'cpu' | 'ram' | 'uptime' | 'power' | 'battery' | 'charging' | 'temperature' | 'thermal';
  Value: number | string | null;
  Threshold: number | string | null;
  Since: number;
}

/** A client's per-client view of a show variable. */
export interface ClientVariableView {
  VariableID: number;
  Key: string;
  EnvironmentKey: string;
  Description: string;
  DefaultValue: string;
  ExportToSystem: boolean;
  /** This client's override; null when it inherits the default. */
  Value: string | null;
  ResolvedValue: string;
}

/**
 * One series from a client history reader. Each reader names its id field
 * differently (Serial, DisplayID, EndpointID, …); SeriesId reads whichever is
 * present.
 */
export interface ClientHistorySeries {
  Name: string;
  samples: HistorySample[];
  Key?: string;
  Serial?: string;
  DisplayID?: string;
  EndpointID?: string;
  InterfaceName?: string;
  MountPoint?: string;
  CheckKey?: 'cpu' | 'ram' | 'uptime' | 'power' | 'thermal';
}

export function SeriesId(series: ClientHistorySeries): string {
  return String(
    series.Key ??
      series.Serial ??
      series.DisplayID ??
      series.EndpointID ??
      series.InterfaceName ??
      series.MountPoint ??
      series.CheckKey ??
      series.Name
  );
}

/** CPU and RAM averaged every 10 seconds over the last hour or so. */
export interface ClientVitalsHistory {
  Cpu: FreeKioskMetricSample[];
  Ram: FreeKioskMetricSample[];
}
