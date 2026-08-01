// The management surface — reads and mutations that go through the server's
// `rpc` bridge rather than its command dispatcher.
//
// Two different things travel over one socket, and the split is not arbitrary:
//
//   COMMANDS are show-time verbs. "Wake this group", "run that script". They are
//   available to every authenticated session, including integrations holding an
//   API key, and they never need EDIT mode.
//
//   RPC is the workspace itself. Renaming a client, creating a group, editing an
//   alert rule. It reaches the same IPC handlers the ShowTrak desktop app calls,
//   so there is exactly one implementation of every mutation — and it is
//   available to PAIRED DEVICES ONLY, behind EDIT mode and a per-category
//   permission.
//
// Everything below is a typed wrapper over one `rpc` channel name. The channel
// strings live here and nowhere else, so a consumer never types one.

/**
 * The `[Err, Data]` tuple MOST ShowTrak IPC handlers return.
 *
 * Not all of them: the history readers return their array directly, and
 * `GetClient` returns the client or null. The typed wrappers below say which is
 * which, because guessing wrong is silent — destructuring an array as a tuple
 * hands you the first sample as an "error" and the second as the data.
 */
export type ResultTuple<T = unknown> = [string | null, T | null];

/**
 * One point on a client's status timeline.
 *
 * The desktop draws these as the coloured blocks above the client info panel;
 * `online`/`degraded` map onto the same status colours a tile uses.
 */
export interface HistorySample {
  ts: number;
  online: boolean;
  degraded: boolean;
  latencyMs: number | null;
}

/** A named series — one running application, USB device, or display. */
export interface NamedHistorySeries {
  Key: string;
  Name: string;
  samples: HistorySample[];
}

/** Why the server refused an rpc call. */
export type RpcErrorCode =
  | 'forbidden'
  | 'edit_mode_required'
  | 'unknown_channel'
  | 'invalid_channel'
  | 'not_connected'
  | 'failed';

export interface RpcFailure {
  ok: false;
  code: RpcErrorCode;
}

export interface RpcSuccess<T> {
  ok: true;
  result: T;
}

export type RpcResult<T> = RpcSuccess<T> | RpcFailure;

/**
 * What this session may mutate right now.
 *
 * A UI affordance, never a security boundary — the server re-authorises every
 * single call regardless of what this says. Its purpose is to let an app hide a
 * control it cannot use instead of offering it and failing, which is the
 * difference between a considered interface and one that punishes you for
 * tapping the wrong thing during a show.
 *
 * `editMode` is reported separately from the permissions because the two are
 * fixable by different people: the operator holding the phone can leave SHOW
 * mode themselves, but only someone at the desk can grant a permission.
 */
export interface Capabilities {
  editMode: boolean;
  clientManagement: boolean;
  groupManagement: boolean;
  monitoringManagement: boolean;
  alertManagement: boolean;
  identify: boolean;
  scripts: boolean;
  wol: boolean;
}

/** Channels grouped the way the server's capability model groups them. */
export const RPC_CHANNELS = {
  // Reads — allowed for any authenticated session, no mode or permission gate.
  GetClient: 'GetClient',
  GetClientHistory: 'GetClientHistory',
  GetClientApplicationHistory: 'GetClientApplicationHistory',
  GetClientUSBHistory: 'GetClientUSBHistory',
  GetClientDisplayHistory: 'GetClientDisplayHistory',
  GetAllGroups: 'GetAllGroups',
  GetAllMonitoringTargets: 'GetAllMonitoringTargets',
  GetMonitoringTarget: 'GetMonitoringTarget',
  GetMonitoringCheckHistory: 'GetMonitoringCheckHistory',
  GetAllDummyClients: 'GetAllDummyClients',
  GetDummyClient: 'GetDummyClient',
  GetAllFreeKioskTerminals: 'GetAllFreeKioskTerminals',
  GetFreeKioskTerminal: 'GetFreeKioskTerminal',
  GetAllAlertRules: 'GetAllAlertRules',
  GetAlertRule: 'GetAlertRule',
  GetAllTags: 'Tags:GetAll',
  GetMode: 'Mode:Get',

  // Client management.
  UpdateClient: 'UpdateClient',
  UnadoptClient: 'UnadoptClient',
  AdoptDevice: 'AdoptDevice',
  AddClientMacAddress: 'AddClientMacAddress',
  RemoveClientMacAddress: 'RemoveClientMacAddress',

  // Group management.
  CreateGroup: 'CreateGroup',
  RenameGroup: 'RenameGroup',
  DeleteGroup: 'DeleteGroup',
  SetGroupOrder: 'Groups:SetOrder',

  // Monitoring management.
  CreateMonitoringTarget: 'CreateMonitoringTarget',
  UpdateMonitoringTarget: 'UpdateMonitoringTarget',
  DeleteMonitoringTarget: 'DeleteMonitoringTarget',
  RunMonitoringCheckNow: 'RunMonitoringCheckNow',

  // Alert rules.
  CreateAlertRule: 'CreateAlertRule',
  UpdateAlertRule: 'UpdateAlertRule',
  DeleteAlertRule: 'DeleteAlertRule',
  SetAlertRuleEnabled: 'SetAlertRuleEnabled',

  // Identify — safe in SHOW mode; it draws an overlay and mutates nothing.
  IdentifyClient: 'IdentifyClient',
  StopIdentifyingClient: 'StopIdentifyingClient',
} as const;

export type RpcChannel = (typeof RPC_CHANNELS)[keyof typeof RPC_CHANNELS];

/** Normalise whatever the server acked into a typed result. */
export function ToRpcResult<T>(response: unknown): RpcResult<T> {
  if (!response || typeof response !== 'object') return { ok: false, code: 'failed' };
  const Payload = response as { error?: unknown; result?: unknown };
  if (Payload.error !== undefined) {
    const Code = String(Payload.error);
    const Known: RpcErrorCode[] = [
      'forbidden',
      'edit_mode_required',
      'unknown_channel',
      'invalid_channel',
      'failed',
    ];
    return {
      ok: false,
      code: (Known as string[]).includes(Code) ? (Code as RpcErrorCode) : 'failed',
    };
  }
  return { ok: true, result: Payload.result as T };
}
