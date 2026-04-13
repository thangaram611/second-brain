import { describe, it, expect, beforeAll } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { extractRust } from '../ast/languages/rust.js';
import type { EntitySource } from '@second-brain/types';

const RUST_SOURCE = `
use std::collections::HashMap;
use crate::config::Settings;

pub const MAX_RETRIES: u32 = 3;
const DEFAULT_TIMEOUT: u32 = 30;
pub static VERSION: &str = "1.0";

pub fn handle_request(req: &Request) -> Response {
    Response::new()
}

fn helper() -> i32 {
    42
}

pub struct Server {
    pub port: u16,
    host: String,
}

struct Internal;

pub enum Status {
    Ok,
    Err,
}

pub trait Handler {
    fn handle(&self);
}

pub type RequestId = u64;

impl Server {
    pub fn new(port: u16) -> Self {
        Self { port, host: String::new() }
    }

    fn shutdown(&self) {}
}
`;

let parser: Parser;
let language: Language;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  const require = createRequire(import.meta.url);
  const wasmDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  language = await Language.load(path.join(wasmDir, 'out', 'tree-sitter-rust.wasm'));
  parser.setLanguage(language);
});

function parseRust(source: string) {
  const tree = parser.parse(source);
  if (tree === null) throw new Error('Rust source failed to parse');
  const testSource: EntitySource = { type: 'ast', ref: 'test' };
  return extractRust(tree, 'main.rs', 'test-ns', testSource);
}

describe('extractRust', () => {
  it('extracts pub vs private functions', () => {
    const result = parseRust(RUST_SOURCE);
    const fns = result.symbols.filter(
      (s) => s.properties?.kind === 'function' && !s.properties.receiver,
    );
    const names = fns.map((s) => s.name);
    expect(names).toContain('handle_request');
    expect(names).toContain('helper');

    const handle = fns.find((s) => s.name === 'handle_request');
    expect(handle?.properties?.exported).toBe(true);

    const helper = fns.find((s) => s.name === 'helper');
    expect(helper?.properties?.exported).toBe(false);
  });

  it('extracts structs as kind=class and enums as kind=enum', () => {
    const result = parseRust(RUST_SOURCE);
    const structs = result.symbols.filter((s) => s.properties?.kind === 'class');
    const enums = result.symbols.filter((s) => s.properties?.kind === 'enum');
    expect(structs.map((s) => s.name)).toEqual(expect.arrayContaining(['Server', 'Internal']));
    expect(enums.map((s) => s.name)).toContain('Status');

    const server = structs.find((s) => s.name === 'Server');
    expect(server?.properties?.exported).toBe(true);
    const internal = structs.find((s) => s.name === 'Internal');
    expect(internal?.properties?.exported).toBe(false);
  });

  it('extracts traits as kind=interface', () => {
    const result = parseRust(RUST_SOURCE);
    const traits = result.symbols.filter((s) => s.properties?.kind === 'interface');
    expect(traits.map((s) => s.name)).toContain('Handler');
    expect(traits[0].properties?.exported).toBe(true);
  });

  it('extracts type aliases as kind=type', () => {
    const result = parseRust(RUST_SOURCE);
    const types = result.symbols.filter((s) => s.properties?.kind === 'type');
    expect(types.map((s) => s.name)).toContain('RequestId');
  });

  it('extracts const and static as kind=const / variable', () => {
    const result = parseRust(RUST_SOURCE);
    const consts = result.symbols.filter((s) => s.properties?.kind === 'const');
    const vars = result.symbols.filter((s) => s.properties?.kind === 'variable');
    expect(consts.map((s) => s.name)).toEqual(
      expect.arrayContaining(['MAX_RETRIES', 'DEFAULT_TIMEOUT']),
    );
    expect(vars.map((s) => s.name)).toContain('VERSION');

    const maxRetries = consts.find((s) => s.name === 'MAX_RETRIES');
    expect(maxRetries?.properties?.exported).toBe(true);
    const defTimeout = consts.find((s) => s.name === 'DEFAULT_TIMEOUT');
    expect(defTimeout?.properties?.exported).toBe(false);
  });

  it('extracts impl methods with receiver', () => {
    const result = parseRust(RUST_SOURCE);
    const methods = result.symbols.filter(
      (s) => s.properties?.kind === 'function' && s.properties.receiver === 'Server',
    );
    const names = methods.map((s) => s.name);
    expect(names).toContain('new');
    expect(names).toContain('shutdown');

    const newMethod = methods.find((s) => s.name === 'new');
    expect(newMethod?.properties?.exported).toBe(true);
    const shutdown = methods.find((s) => s.name === 'shutdown');
    expect(shutdown?.properties?.exported).toBe(false);
  });

  it('extracts use declarations as depends_on relations', () => {
    const result = parseRust(RUST_SOURCE);
    const deps = result.relations.filter((r) => r.type === 'depends_on');
    const targets = deps.map((r) => r.targetName);
    // Rust paths use `::` separator — we capture the path up to the use tree.
    expect(targets.some((t) => t.includes('std::collections'))).toBe(true);
    expect(targets.some((t) => t.includes('crate::config'))).toBe(true);
  });

  it('creates contains relations for every symbol', () => {
    const result = parseRust(RUST_SOURCE);
    const contains = result.relations.filter((r) => r.type === 'contains');
    expect(contains.length).toBe(result.symbols.length);
    for (const rel of contains) {
      expect(rel.sourceName).toBe('main.rs');
      expect(rel.sourceType).toBe('file');
      expect(rel.targetType).toBe('symbol');
    }
  });
});
