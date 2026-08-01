// mDNS/Bonjour discovery — the shapes and the parsing, not the browsing.
//
// The SDK deliberately does NOT browse for services itself. There is no portable
// mDNS implementation across Node, React Native and the browser, so every host
// brings its own (`bonjour-service` on Node, `react-native-zeroconf` on mobile).
// What the SDK owns is the part that would otherwise be reimplemented — and
// subtly differently — by each of them: the service name, the TXT keys, and the
// rules for reading them.
//
// Everything published in TXT is ADVISORY. mDNS is unauthenticated and trivially
// spoofed on a hostile network, so these values may only shape a UI — "this one
// will ask for a PIN", "that one will refuse you". The server re-reads all of it
// at the handshake and remains the sole authority.

/** Bonjour service type the server publishes (`_showtrak._tcp`). */
export const SERVICE_TYPE = 'showtrak';

/** Subtype the server publishes alongside the type. */
export const SERVICE_SUBTYPE = 'showtrakv3server';

/**
 * A ShowTrak Server found on the local network.
 *
 * `identity` is the stable primary key, NOT the host. The server mints it once
 * per install and it survives restarts and address changes; a DHCP lease does
 * not. Anything that remembers a server between sessions — a connection history,
 * a stored device token — must key on this or it will lose track of a server
 * that merely moved.
 */
export interface DiscoveredServer {
  identity: string;
  /** Friendly name, falling back to the parsed service name. */
  name: string;
  host: string;
  port: number;
  /** Server version, empty when an older server did not publish one. */
  version: string;
  /** Whether pairing will ask for the workspace PIN. */
  pinRequired: boolean;
  /** Whether the control API is enabled at all. */
  sdkEnabled: boolean;
  /** Whether new devices may pair right now. */
  pairingEnabled: boolean;
}

/** The raw service record a host's mDNS browser hands back. */
export interface ServiceRecord {
  name?: string | null;
  host?: string | null;
  port?: number | null;
  addresses?: string[] | null;
  txt?: Record<string, unknown> | null;
}

// TXT values arrive as strings, Buffers, or (on some hosts) already-coerced
// booleans, depending on the mDNS library. Normalise before comparing.
function ReadFlag(txt: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const Raw = txt[key];
  if (Raw === undefined || Raw === null) return fallback;
  const Value = String(Raw).trim().toLowerCase();
  if (Value === '1' || Value === 'true' || Value === 'yes') return true;
  if (Value === '0' || Value === 'false' || Value === 'no') return false;
  return fallback;
}

function ReadString(txt: Record<string, unknown>, key: string): string {
  const Raw = txt[key];
  if (Raw === undefined || Raw === null) return '';
  return String(Raw).trim();
}

// The server publishes "<Hostname> - ShowTrak Server V3". Older servers publish
// no Name key, so the suffix is stripped back off rather than shown to a user.
const SERVICE_NAME_SUFFIX = / - ShowTrak Server V\d+$/i;

/**
 * Turn a raw mDNS service record into a DiscoveredServer, or null if it is not
 * a usable ShowTrak server.
 *
 * Returns null rather than a partial record when `identity` is missing: without
 * it there is no stable key, so the entry could not be remembered, deduplicated
 * against a stored token, or told apart from the same server on a new address.
 * A row that cannot be acted on is worse than no row.
 *
 * Flags default to TRUE for an older server that publishes none of them. The
 * alternative — defaulting to "SDK disabled" — would grey out every server
 * running a build older than the one that added these keys.
 */
export function ParseServiceTxt(
  service: ServiceRecord | null | undefined
): DiscoveredServer | null {
  if (!service) return null;
  const Txt = (service.txt || {}) as Record<string, unknown>;

  const Identity = ReadString(Txt, 'ServerIdentity');
  if (!Identity) return null;

  // Prefer a numeric IP over the .local hostname: mDNS name resolution is an
  // extra failure point on exactly the networks where discovery is already
  // marginal, and the address is right there in the record.
  const Address = (service.addresses || []).find((Candidate) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(Candidate)
  );
  const Host = Address || String(service.host || '').trim();
  if (!Host) return null;

  const Port = Number(service.port);
  if (!Number.isInteger(Port) || Port <= 0) return null;

  const PublishedName = ReadString(Txt, 'Name');
  const ServiceName = String(service.name || '')
    .replace(SERVICE_NAME_SUFFIX, '')
    .trim();

  return {
    identity: Identity,
    name: PublishedName || ServiceName || Host,
    host: Host,
    port: Port,
    version: ReadString(Txt, 'Version'),
    pinRequired: ReadFlag(Txt, 'PinRequired', false),
    sdkEnabled: ReadFlag(Txt, 'SdkEnabled', true),
    pairingEnabled: ReadFlag(Txt, 'Pairing', true),
  };
}
