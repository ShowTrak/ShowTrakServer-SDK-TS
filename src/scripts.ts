// Which clients a script may be offered on, and how firmly to ask first.
//
// The same rules the ShowTrak desktop applies when it builds its context menu
// (its script-targeting.ts), so a script offered by an integration is a script
// the desk would offer too. They are a usability guard, not the security
// boundary: the server re-checks the whitelist on dispatch. They still matter,
// because a script offered against the wrong machine is a script an operator
// will run on the wrong machine.

import { ScopeCoversClient } from './client.js';
import type {
  ClientView,
  ScriptConfirmationLevel,
  ScriptExecutionView,
  ScriptView,
  TagView,
} from './protocol.js';

/** The script fields the targeting rules read. */
type TargetableScript = Pick<ScriptView, 'CompatiblePlatforms' | 'Whitelist' | 'isEnabled'>;

/** The client fields the targeting rules read. */
type TargetableClient = Pick<ClientView, 'UUID' | 'GroupID' | 'OperatingSystem'>;

/**
 * Why a client won't run a script, as the desktop words it.
 *
 * `Unsupported` is its OS, `Disabled` is the whitelist and `Offline` is the
 * machine itself.
 */
export type ScriptSkipReason = 'Disabled' | 'Unsupported' | 'Offline';

function SupportsPlatform(script: TargetableScript, client: TargetableClient): boolean {
  const Compatible = Array.isArray(script.CompatiblePlatforms) ? script.CompatiblePlatforms : [];
  return !!client.OperatingSystem && Compatible.includes(client.OperatingSystem);
}

/**
 * Whether a script can run on this client at all: it must be enabled, support
 * the client's OS AND be admitted by the whitelist.
 *
 * All three are required. Dropping any produces an entry the author switched
 * off, one that fails on execution (wrong OS), or one that runs somewhere it was
 * explicitly restricted away from. Only an explicit `isEnabled: false` hides a
 * script. `tags` is the full tag list, needed to expand a tag-based whitelist;
 * omitting it hides a script from clients only a tag admits.
 */
export function IsScriptTargetable(
  script: TargetableScript,
  client: TargetableClient | null | undefined,
  tags: readonly TagView[] = []
): boolean {
  if (!script || script.isEnabled === false) return false;
  if (!client || !SupportsPlatform(script, client)) return false;
  return ScopeCoversClient(script.Whitelist, client, tags);
}

/**
 * The subset of clients a script may be dispatched to.
 *
 * An empty result means the script should not be offered at all, rather than
 * offered and then silently doing nothing.
 */
export function ResolveScriptTargets<T extends TargetableClient>(
  script: TargetableScript,
  clients: readonly T[],
  tags: readonly TagView[] = []
): T[] {
  return clients.filter((Client) => IsScriptTargetable(script, Client, tags));
}

/**
 * Why a script won't run on a client, or null when it will.
 *
 * The first that applies wins, so a client that is both offline and outside the
 * whitelist reads as Disabled: coming back online won't help it.
 */
export function GetScriptSkipReason(
  script: TargetableScript,
  client: (TargetableClient & Pick<ClientView, 'Online'>) | null | undefined,
  tags: readonly TagView[] = []
): ScriptSkipReason | null {
  if (!client || !SupportsPlatform(script, client)) return 'Unsupported';
  if (!ScopeCoversClient(script.Whitelist, client, tags)) return 'Disabled';
  if (!client.Online) return 'Offline';
  return null;
}

/**
 * How firmly to confirm before running a script.
 *
 * Servers predating levels send only the `Confirmation` boolean, which reads as
 * Standard.
 */
export function ScriptConfirmation(
  script: Pick<ScriptView, 'Confirmation' | 'ConfirmationLevel'>
): ScriptConfirmationLevel {
  if (script.ConfirmationLevel) return script.ConfirmationLevel;
  return script.Confirmation ? 'Standard' : 'None';
}

// --- Script executions -------------------------------------------------------

/** Name prefix the server gives an integrated client's event when it runs as an execution. */
const INTEGRATED_EVENT_PREFIX = 'Integrated Event: ';

/**
 * Whether the server would retry this execution (retryFailedExecutions, or the
 * desktop panel's Retry button).
 *
 * Mirrors the server's rule: a failed script run, or a failed integrated-client
 * event. Script deployments retry themselves, and other internal work (Wake on
 * LAN, shutdown, updates) does not record what it sent, so neither is offered.
 */
export function IsRetryableExecution(
  execution:
    Pick<ScriptExecutionView, 'Status' | 'Internal' | 'Client' | 'Script'> | null | undefined
): boolean {
  if (!execution || execution.Status !== 'Failed') return false;
  if (!execution.Client || !execution.Client.UUID || !execution.Script) return false;
  if (!execution.Internal) return !!execution.Script.ID;
  const Name = typeof execution.Script.Name === 'string' ? execution.Script.Name : '';
  return Name.startsWith(INTEGRATED_EVENT_PREFIX) && Name.length > INTEGRATED_EVENT_PREFIX.length;
}

/** Counts across an execution list, as the desktop panel's header reads them. */
export interface ExecutionSummary {
  /** Queued or running: the server does not tell the two apart by status. */
  Pending: number;
  Completed: number;
  Failed: number;
  /** Failures the server would retry. */
  Retryable: number;
  Total: number;
}

/**
 * Count an execution list by status.
 *
 * Internal executions (script deployments, Wake on LAN and other housekeeping)
 * are left out unless `includeInternal` is set, because an operator did not ask
 * for them; integrated-client events are internal too, but are always counted,
 * since they are an operator's own action.
 */
export function SummariseExecutions(
  executions: readonly ScriptExecutionView[],
  options: { includeInternal?: boolean } = {}
): ExecutionSummary {
  const Summary: ExecutionSummary = { Pending: 0, Completed: 0, Failed: 0, Retryable: 0, Total: 0 };
  for (const Execution of executions || []) {
    if (!Execution) continue;
    const IsEvent =
      typeof Execution.Script?.Name === 'string' &&
      Execution.Script.Name.startsWith(INTEGRATED_EVENT_PREFIX);
    if (Execution.Internal && !IsEvent && !options.includeInternal) continue;
    Summary.Total++;
    if (Execution.Status === 'Pending') Summary.Pending++;
    else if (Execution.Status === 'Completed') Summary.Completed++;
    else if (Execution.Status === 'Failed') {
      Summary.Failed++;
      if (IsRetryableExecution(Execution)) Summary.Retryable++;
    }
  }
  return Summary;
}
