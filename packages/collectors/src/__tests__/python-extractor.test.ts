import { describe, it, expect, beforeAll } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { extractPython } from '../ast/languages/python.js';
import type { EntitySource } from '@second-brain/types';

const PYTHON_SOURCE = `
import os
import sys as system
from collections import defaultdict, OrderedDict

MAX_RETRIES = 3
_internal_state = 0

def handle_request(req):
    return req.data

def _private_helper():
    pass

@decorator
def decorated_fn():
    pass

class Server:
    def __init__(self, port):
        self.port = port

    def start(self):
        pass

    def _shutdown(self):
        pass

class _Internal:
    pass
`;

let parser: Parser;
let language: Language;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  const require = createRequire(import.meta.url);
  const wasmDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  language = await Language.load(path.join(wasmDir, 'out', 'tree-sitter-python.wasm'));
  parser.setLanguage(language);
});

function parsePython(source: string) {
  const tree = parser.parse(source);
  if (tree === null) throw new Error('Python source failed to parse');
  const testSource: EntitySource = { type: 'ast', ref: 'test' };
  return extractPython(tree, 'app.py', 'test-ns', testSource);
}

describe('extractPython', () => {
  it('extracts module-level functions and applies underscore-prefix export rule', () => {
    const result = parsePython(PYTHON_SOURCE);
    const fns = result.symbols.filter(
      (s) => s.properties?.kind === 'function' && !s.properties.receiver,
    );
    const names = fns.map((s) => s.name);
    expect(names).toContain('handle_request');
    expect(names).toContain('_private_helper');
    expect(names).toContain('decorated_fn');

    const handle = fns.find((s) => s.name === 'handle_request');
    expect(handle?.properties?.exported).toBe(true);

    const priv = fns.find((s) => s.name === '_private_helper');
    expect(priv?.properties?.exported).toBe(false);
  });

  it('extracts classes with exported/private based on name', () => {
    const result = parsePython(PYTHON_SOURCE);
    const classes = result.symbols.filter((s) => s.properties?.kind === 'class');
    const names = classes.map((s) => s.name);
    expect(names).toContain('Server');
    expect(names).toContain('_Internal');

    const server = classes.find((s) => s.name === 'Server');
    expect(server?.properties?.exported).toBe(true);
    const internal = classes.find((s) => s.name === '_Internal');
    expect(internal?.properties?.exported).toBe(false);
  });

  it('extracts methods with class as receiver', () => {
    const result = parsePython(PYTHON_SOURCE);
    const methods = result.symbols.filter(
      (s) => s.properties?.kind === 'function' && s.properties.receiver === 'Server',
    );
    const names = methods.map((s) => s.name);
    expect(names).toContain('__init__');
    expect(names).toContain('start');
    expect(names).toContain('_shutdown');

    const shutdown = methods.find((s) => s.name === '_shutdown');
    expect(shutdown?.properties?.exported).toBe(false);
  });

  it('extracts module-level constant-style assignments as variables', () => {
    const result = parsePython(PYTHON_SOURCE);
    const vars = result.symbols.filter((s) => s.properties?.kind === 'variable');
    const names = vars.map((s) => s.name);
    expect(names).toContain('MAX_RETRIES');
    expect(names).toContain('_internal_state');
  });

  it('extracts imports as depends_on relations', () => {
    const result = parsePython(PYTHON_SOURCE);
    const deps = result.relations.filter((r) => r.type === 'depends_on');
    const targets = deps.map((r) => r.targetName);
    expect(targets).toContain('os');
    expect(targets).toContain('sys');
    expect(targets).toContain('collections');
  });

  it('creates contains relations for every symbol', () => {
    const result = parsePython(PYTHON_SOURCE);
    const contains = result.relations.filter((r) => r.type === 'contains');
    expect(contains.length).toBe(result.symbols.length);
    for (const rel of contains) {
      expect(rel.sourceName).toBe('app.py');
      expect(rel.sourceType).toBe('file');
      expect(rel.targetType).toBe('symbol');
    }
  });
});
