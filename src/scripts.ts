// Which clients a script may be offered on, and how firmly to ask first.
//
// The same rules the ShowTrak desktop applies when it builds its context menu
// (its script-targeting.ts), so a script offered by an integration is a script
// the desk would offer too. They are a usability guard, not the security
// boundary: the server re-checks the whitelist on dispatch. They still matter,
// because a script offered against the wrong machine is a script an operator
// will run on the wrong machine.

import { ScopeCoversClient } from './client.js';
import type { ClientView, ScriptConfirmationLevel, ScriptView, TagView } from './protocol.js';

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
