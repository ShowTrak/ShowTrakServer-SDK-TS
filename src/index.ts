// ShowTrak Server TypeScript SDK — public surface.
//
// Standalone package published to npm as @showtrak/server-sdk. It carries the
// shared constants, the control-API wire protocol types, and a high-level
// client for driving a ShowTrak Server instance in real time.

export * from './constants.js';
export * from './protocol.js';
export {
  ShowTrakControlClient,
  DeriveClientStatus,
  ClientLabel,
  type ConnectOptions,
  type ConnectionState,
} from './client.js';
