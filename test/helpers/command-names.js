// The set of command names the protocol declares, read out of the TypeScript
// source at test time.
//
// `CommandName` / `CommandArgs` are types — they vanish at runtime, so there is
// nothing to import. Parsing the `CommandArgs` interface instead of hand-copying
// the list means adding a command to the protocol without adding an SDK method
// (or a test) fails the coverage check rather than passing unnoticed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROTOCOL_SOURCE = fileURLToPath(new URL('../../src/protocol.ts', import.meta.url));

function parseCommandArgsKeys(source) {
  const start = source.indexOf('export interface CommandArgs {');
  if (start === -1) {
    throw new Error('Could not find the CommandArgs interface in src/protocol.ts');
  }
  const end = source.indexOf('\n}', start);
  if (end === -1) throw new Error('Unterminated CommandArgs interface in src/protocol.ts');

  const body = source.slice(start, end);
  // Every member is a quoted, dotted key: 'select.client': { slug: string };
  const names = [...body.matchAll(/^\s*'([a-z]+\.[A-Za-z]+)'\s*:/gm)].map((match) => match[1]);
  if (names.length === 0) throw new Error('Parsed no command names from CommandArgs');
  return names;
}

export const CommandNames = parseCommandArgsKeys(readFileSync(PROTOCOL_SOURCE, 'utf8'));
