// ShowTrak Server TypeScript SDK — public surface.
//
// Standalone package published to npm as @showtrak/server-sdk. It carries the
// shared constants, the control-API wire protocol types, and a high-level
// client for driving a ShowTrak Server instance in real time.

export * from './constants.js';
export * from './protocol.js';
export * from './discovery.js';
export * from './management.js';
export {
  Pair,
  ClassifyPairError,
  ParseRetryAfterMs,
  type PairOptions,
  type PairResult,
  type PairSuccess,
  type PairFailure,
  type PairErrorCode,
} from './pairing.js';
export * from './scripts.js';
export * from './entities.js';
export {
  ShowTrakControlClient,
  DeriveClientStatus,
  ClientLabel,
  ScopeCoversClient,
  type ConnectOptions,
  type ConnectionState,
} from './client.js';
