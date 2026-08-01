// Pairing — exchanging a workspace PIN (or a scanned code, or nothing) for a
// long-lived device token.
//
// Pairing is a one-shot handshake, not a session: it opens a socket, collects
// the token the server emits on connection, and closes. The caller then connects
// normally with that token. Keeping the two apart means a paired client is
// indistinguishable from one that was paired weeks ago — there is no "just
// paired" state for the rest of the SDK to special-case.
//
// The plaintext token exists exactly once, in the `paired` event. The server
// stores only its hash and cannot re-issue it, so a caller that drops it has to
// pair again.

import { io, type Socket } from 'socket.io-client';
import { DEFAULT_SERVER_PORT, SDK_NAMESPACE } from './constants.js';

export interface PairOptions {
  host: string;
  /** Defaults to DEFAULT_SERVER_PORT (3000). */
  port?: number;
  /** The workspace PIN. Omit when the server reports `pinRequired: false`. */
  pin?: string;
  /** A scanned pairing code. Takes precedence over `pin` when both are given. */
  pairingCode?: string;
  /** Shown in the server's paired-devices list. Give the operator something they can recognise. */
  deviceName?: string;
  platform?: 'ios' | 'android';
  /** How long to wait for the server before giving up. Defaults to 10s. */
  timeoutMs?: number;
}

export interface PairSuccess {
  ok: true;
  deviceId: string;
  deviceToken: string;
}

/**
 * Why a pairing attempt failed.
 *
 * A discriminated union rather than a message string because the app shows a
 * genuinely different screen for each: a wrong PIN shakes the keypad, a revoked
 * token must DROP the stored credential and start over, and a disabled feature
 * has to point the operator at a server setting they can go and change. Collapse
 * these into one `error` string and the app can only ever say "something went
 * wrong", which for a device that has stopped working mid-show is useless.
 */
export type PairErrorCode =
  | 'invalid_pin'
  | 'code_expired'
  | 'rate_limited'
  | 'pairing_disabled'
  | 'sdk_disabled'
  | 'token_revoked'
  | 'unreachable'
  | 'failed';

export interface PairFailure {
  ok: false;
  code: PairErrorCode;
  /** The server's own message, for logs and for the unrecognised-failure case. */
  detail: string;
  /** Present for `rate_limited` when the server said how long to wait. */
  retryAfterMs?: number;
}

export type PairResult = PairSuccess | PairFailure;

// Map a handshake error message onto a code the app can branch on. The server
// sends prose (it is also read by humans in logs), so this is pattern matching
// by necessity — hence the deliberate `failed` fallback rather than a guess.
export function ClassifyPairError(message: string): PairErrorCode {
  const Text = String(message || '').toLowerCase();
  if (Text.includes('device revoked')) return 'token_revoked';
  if (Text.includes('pairing is disabled')) return 'pairing_disabled';
  if (Text.includes('sdk api is disabled')) return 'sdk_disabled';
  if (Text.includes('api key not configured')) return 'sdk_disabled';
  if (Text.includes('pairing code')) return 'code_expired';
  if (Text.includes('too many failed attempts')) return 'rate_limited';
  if (Text.includes('unauthorized')) return 'invalid_pin';
  // Socket.IO reports a refused or unroutable host through its transport layer,
  // and the wording depends on which transport got there first — websocket on a
  // LAN, polling behind a proxy. All of them mean the same thing to the operator:
  // nothing is listening at that address.
  const Unreachable = [
    'xhr poll error',
    'websocket error',
    'transport error',
    'transport close',
    'timeout',
    'econnrefused',
    'enetunreach',
    'ehostunreach',
    'network',
  ];
  if (Unreachable.some((Needle) => Text.includes(Needle))) return 'unreachable';
  return 'failed';
}

// "Try again in 42s" → 42000. Absent or unparseable → undefined, so the app
// shows a generic retry rather than a countdown to a number it invented.
export function ParseRetryAfterMs(message: string): number | undefined {
  const Match = /try again in (\d+)s/i.exec(String(message || ''));
  if (!Match) return undefined;
  const Seconds = Number(Match[1]);
  return Number.isFinite(Seconds) ? Seconds * 1000 : undefined;
}

const DEFAULT_PAIR_TIMEOUT_MS = 10_000;

/**
 * Pair this device with a server and return its device token.
 *
 * Never throws: a caller in a pairing screen wants a result to render, not an
 * exception to catch. Every failure path resolves to a typed PairFailure.
 */
export function Pair(options: PairOptions): Promise<PairResult> {
  const Port = options.port ?? DEFAULT_SERVER_PORT;
  const Url = `http://${options.host}:${Port}${SDK_NAMESPACE}`;
  const TimeoutMs = options.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS;

  return new Promise<PairResult>((resolve) => {
    let Socket: Socket | null = null;
    let Settled = false;

    const Finish = (Result: PairResult) => {
      if (Settled) return;
      Settled = true;
      clearTimeout(Timer);
      try {
        Socket?.removeAllListeners();
        Socket?.disconnect();
      } catch {
        /* the result is already decided; teardown is best effort */
      }
      resolve(Result);
    };

    // A server that accepts the socket but never emits `paired` would otherwise
    // leave the pairing screen spinning forever.
    const Timer = setTimeout(() => {
      Finish({ ok: false, code: 'unreachable', detail: 'The server did not respond in time' });
    }, TimeoutMs);

    try {
      Socket = io(Url, {
        transports: ['websocket', 'polling'],
        // One attempt only. Retrying a pairing handshake would burn attempts
        // against the PIN throttle on the server, turning one fat-fingered PIN
        // into a lockout.
        reconnection: false,
        forceNew: true,
        timeout: TimeoutMs,
        auth: {
          pair: true,
          pin: options.pin,
          pairingCode: options.pairingCode,
          deviceName: options.deviceName,
          platform: options.platform,
        },
      });
    } catch (e) {
      Finish({ ok: false, code: 'failed', detail: (e as Error)?.message || 'Could not connect' });
      return;
    }

    Socket.on('paired', (payload: { deviceId?: string; deviceToken?: string } | undefined) => {
      const DeviceToken = String(payload?.deviceToken || '');
      const DeviceId = String(payload?.deviceId || '');
      if (!DeviceToken) {
        Finish({ ok: false, code: 'failed', detail: 'The server issued no device token' });
        return;
      }
      Finish({ ok: true, deviceId: DeviceId, deviceToken: DeviceToken });
    });

    Socket.on('connect_error', (err: Error) => {
      const Detail = err?.message || 'Connection refused';
      Finish({
        ok: false,
        code: ClassifyPairError(Detail),
        detail: Detail,
        retryAfterMs: ParseRetryAfterMs(Detail),
      });
    });
  });
}
