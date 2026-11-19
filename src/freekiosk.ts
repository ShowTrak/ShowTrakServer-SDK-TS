// The FreeKiosk terminal commands a ShowTrak Server accepts, by ID.
//
// A hand-kept mirror of the server's allowlist (src/Modules/FreeKiosk/commands.ts)
// with only what an integration needs to offer a command: its label, what it
// applies to and the value it takes. Paired devices can read the live catalog
// with getFreeKioskCommands(); an API-key session cannot, so integrations such
// as Companion build their pickers from this instead.
//
// It is a convenience, not the contract. The server checks every command
// against its own list, so a command added there and missing here still works
// when sent by ID, and one removed there is refused with "Unknown FreeKiosk
// command" rather than reaching a device.

import type { FreeKioskDisplayMode } from './entities.js';

export interface FreeKioskCommandInfo {
  ID: string;
  Label: string;
  Group: 'Power' | 'Display' | 'Content' | 'Audio' | 'Maintenance';
  /** The one value the command takes, or null for none. Sent as `value`. */
  Value: { Label: string; Min: number; Max: number; Default: number } | null;
  /** Display modes it applies in; absent means every mode. */
  Modes?: readonly FreeKioskDisplayMode[];
  /** Disruptive enough to deserve a confirmation (reboot, clear cache). */
  Destructive?: boolean;
  Note?: string;
}

const LEVEL = { Label: 'Level', Min: 0, Max: 100, Default: 50 } as const;

export const FREEKIOSK_COMMANDS: readonly FreeKioskCommandInfo[] = Object.freeze([
  { ID: 'wake', Label: 'Wake Screen', Group: 'Power', Value: null },
  { ID: 'screen.on', Label: 'Screen On', Group: 'Power', Value: null },
  { ID: 'screen.off', Label: 'Screen Off', Group: 'Power', Value: null },
  {
    ID: 'lock',
    Label: 'Lock Device',
    Group: 'Power',
    Value: null,
    Destructive: true,
    Note: 'Needs Device Owner, Device Admin or the accessibility service.',
  },
  {
    ID: 'reboot',
    Label: 'Reboot',
    Group: 'Power',
    Value: null,
    Destructive: true,
    Note: 'Device Owner only.',
  },
  { ID: 'brightness', Label: 'Brightness', Group: 'Display', Value: LEVEL },
  { ID: 'screensaver.on', Label: 'Enable Screensaver', Group: 'Display', Value: null },
  { ID: 'screensaver.off', Label: 'Disable Screensaver', Group: 'Display', Value: null },
  { ID: 'reload', Label: 'Reload Page', Group: 'Content', Value: null, Modes: ['webview'] },
  { ID: 'volume', Label: 'Volume', Group: 'Audio', Value: LEVEL },
  { ID: 'audio.beep', Label: 'Beep', Group: 'Audio', Value: null },
  {
    ID: 'clearCache',
    Label: 'Clear Cache',
    Group: 'Maintenance',
    Value: null,
    Destructive: true,
    Modes: ['webview'],
    Note: 'Clears the WebView cache, cookies and local storage, then reloads.',
  },
  {
    ID: 'restart-ui',
    Label: 'Restart Kiosk UI',
    Group: 'Maintenance',
    Value: null,
    Destructive: true,
  },
] satisfies FreeKioskCommandInfo[]);

/** A command by ID, or undefined for one this SDK does not know. */
export function GetFreeKioskCommandInfo(id: string): FreeKioskCommandInfo | undefined {
  return FREEKIOSK_COMMANDS.find((Command) => Command.ID === id);
}
