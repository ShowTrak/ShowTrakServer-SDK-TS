// Centralised, cross-application constants for every ShowTrak Server integration.
//
// This file is the single place integrations read shared values from (ports,
// colours, status colours, the control namespace). It is a deliberate, hand-
// maintained MIRROR of the server's authoritative values — the SDK is a
// standalone package that the server does not consume, so when a value changes
// on the server (src/Modules/Config/constants.ts, ScriptManager/schema.ts,
// UI/css/parts/01-base.css) it must be updated here too. See README.

/** Default HTTP + Socket.IO port the ShowTrak Server binds (APP_PORT). */
export const DEFAULT_SERVER_PORT = 3000;

/** UDP port the server's inbound OSC control listener binds. */
export const OSC_PORT = 3333;

/** Socket.IO namespace the WebSocket control API is exposed on. */
export const SDK_NAMESPACE = '/sdk';

/** Wire event a client emits to invoke a command; ack returns {ok, detail}. */
export const COMMAND_EVENT = 'command';

// --- Script / tag colour palette -----------------------------------------
// The 8-colour palette scripts, tags and integrated actions index into
// (ColourIndex 0..7). Mirrors SCRIPT_COLOURS in the server.

export interface PaletteColour {
  index: number;
  hex: string;
  name: string;
}

export const COLOUR_PALETTE: readonly PaletteColour[] = [
  { index: 0, hex: '#e74c3c', name: 'Red' },
  { index: 1, hex: '#e67e22', name: 'Orange' },
  { index: 2, hex: '#f1c40f', name: 'Yellow' },
  { index: 3, hex: '#2ecc71', name: 'Green' },
  { index: 4, hex: '#3498db', name: 'Blue' },
  { index: 5, hex: '#9b59b6', name: 'Purple' },
  { index: 6, hex: '#bdc3c7', name: 'Light grey' },
  { index: 7, hex: '#7f8c8d', name: 'Dark grey' },
] as const;

/** Default palette index (used by scripts/actions when none is set). */
export const DEFAULT_COLOUR_INDEX = 7;

/** Resolve a palette index to its hex, falling back for out-of-range input. */
export function ScriptColourHex(index: unknown): string {
  // Only genuine numbers and numeric strings may index the palette. Number()
  // maps null, '' and false to 0, which would paint an *unset* colour red
  // instead of falling back to grey — and would disagree with the server's
  // SCRIPT_COLOURS[Index] lookup, where those all miss. Reject them up front.
  const indexable =
    typeof index === 'number' || (typeof index === 'string' && index.trim() !== '');
  const i = indexable ? Number(index) : Number.NaN;
  if (Number.isInteger(i) && i >= 0 && i < COLOUR_PALETTE.length) {
    return COLOUR_PALETTE[i]!.hex;
  }
  return COLOUR_PALETTE[6]!.hex;
}

// --- Client / monitor status -------------------------------------------------

export type ClientStatus = 'ONLINE' | 'DEGRADED' | 'IDLE' | 'OFFLINE';

export const CLIENT_STATUSES: readonly ClientStatus[] = [
  'ONLINE',
  'DEGRADED',
  'IDLE',
  'OFFLINE',
] as const;

/**
 * Tile background colours per status, as rgba() strings — the exact values the
 * server UI paints client tiles with (--status-* custom properties).
 */
export const STATUS_COLOURS: Record<ClientStatus, string> = {
  ONLINE: 'rgba(18, 255, 0, 0.32)',
  DEGRADED: 'rgba(255, 140, 0, 0.32)',
  IDLE: 'rgba(64, 64, 64, 0.5)',
  OFFLINE: 'rgba(255, 0, 0, 0.24)',
};

/**
 * Opaque RGB for each status, as [r, g, b]. Integrations that need a solid
 * colour (e.g. a Companion button background, which has no alpha) use these —
 * the alpha-blended STATUS_COLOURS above assume a dark UI behind them, so these
 * are pre-flattened against the ShowTrak near-black tile background.
 */
export const STATUS_RGB: Record<ClientStatus, [number, number, number]> = {
  ONLINE: [30, 120, 20],
  DEGRADED: [150, 90, 10],
  IDLE: [60, 60, 60],
  OFFLINE: [120, 25, 25],
};

/** rgba() tile colour for a status. */
export function StatusColour(status: ClientStatus): string {
  return STATUS_COLOURS[status] ?? STATUS_COLOURS.OFFLINE;
}

/** Solid [r, g, b] for a status (for surfaces without alpha, e.g. Companion). */
export function StatusRgb(status: ClientStatus): [number, number, number] {
  return STATUS_RGB[status] ?? STATUS_RGB.OFFLINE;
}
