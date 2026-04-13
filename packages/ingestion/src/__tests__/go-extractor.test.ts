import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'web-tree-sitter';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { extractGo } from '../ast/languages/go.js';
import type { EntitySource } from '@second-brain/types';

const GO_SOURCE = `
package main

import (
	"fmt"
	"os"
)

// Exported function
func HandleRequest(w Writer, r Reader) {
	fmt.Println("hello")
}

// Unexported function
func helperFunc() int {
	return 42
}

// Method with receiver
func (s *Server) Start() error {
	return nil
}

// Unexported method
func (s *Server) shutdown() {
}

// Struct
type Server struct {
	Port int
	host string
}

// Interface
type Handler interface {
	Handle()
}

// Type alias
type RequestID string

// unexported type
type internalState int

// Exported const
const MaxRetries = 3

// Unexported const
const defaultTimeout = 30

// Exported var
var GlobalConfig = "config"

// Unexported var
var debugMode = false

// Grouped const
const (
	StatusOK    = 200
	statusError = 500
)
`;

let parser: Parser;
let goLanguage: Parser.Language;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();

  const require = createRequire(import.meta.url);
  const wasmPkgDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  const grammarPath = path.join(wasmPkgDir, 'out', 'tree-sitter-go.wasm');
  goLanguage = await Parser.Language.load(grammarPath);
  parser.setLanguage(goLanguage);
});

function parseGo(source: string) {
  const tree = parser.parse(source);
  const testSource: EntitySource = { type: 'ast', ref: 'test' };
  return extractGo(tree, 'main.go', 'test-ns', testSource);
}

describe('extractGo', () => {
  it('extracts exported and unexported functions', () => {
    const result = parseGo(GO_SOURCE);
    const fns = result.symbols.filter(
      (s) => s.properties?.kind === 'function' && !s.properties.receiver,
    );
    const names = fns.map((s) => s.name);
    expect(names).toContain('HandleRequest');
    expect(names).toContain('helperFunc');

    const handleReq = fns.find((s) => s.name === 'HandleRequest');
    expect(handleReq?.properties?.exported).toBe(true);
    expect(handleReq?.tags).toContain('exported');

    const helper = fns.find((s) => s.name === 'helperFunc');
    expect(helper?.properties?.exported).toBe(false);
    expect(helper?.tags).not.toContain('exported');
  });

  it('extracts methods with receiver type', () => {
    const result = parseGo(GO_SOURCE);
    const methods = result.symbols.filter(
      (s) => s.properties?.kind === 'function' && s.properties.receiver,
    );
    expect(methods.length).toBe(2);

    const start = methods.find((s) => s.name === 'Start');
    expect(start?.properties?.receiver).toBe('Server');
    expect(start?.properties?.exported).toBe(true);

    const shutdown = methods.find((s) => s.name === 'shutdown');
    expect(shutdown?.properties?.receiver).toBe('Server');
    expect(shutdown?.properties?.exported).toBe(false);
  });

  it('extracts structs as kind=class', () => {
    const result = parseGo(GO_SOURCE);
    const structs = result.symbols.filter((s) => s.properties?.kind === 'class');
    expect(structs.length).toBe(1);
    expect(structs[0].name).toBe('Server');
    expect(structs[0].properties?.exported).toBe(true);
  });

  it('extracts interfaces', () => {
    const result = parseGo(GO_SOURCE);
    const ifaces = result.symbols.filter((s) => s.properties?.kind === 'interface');
    expect(ifaces.length).toBe(1);
    expect(ifaces[0].name).toBe('Handler');
    expect(ifaces[0].properties?.exported).toBe(true);
  });

  it('extracts type aliases as kind=type', () => {
    const result = parseGo(GO_SOURCE);
    const types = result.symbols.filter((s) => s.properties?.kind === 'type');
    const names = types.map((s) => s.name);
    expect(names).toContain('RequestID');
    expect(names).toContain('internalState');

    const reqId = types.find((s) => s.name === 'RequestID');
    expect(reqId?.properties?.exported).toBe(true);

    const internal = types.find((s) => s.name === 'internalState');
    expect(internal?.properties?.exported).toBe(false);
  });

  it('extracts const declarations', () => {
    const result = parseGo(GO_SOURCE);
    const consts = result.symbols.filter((s) => s.properties?.kind === 'const');
    const names = consts.map((s) => s.name);
    expect(names).toContain('MaxRetries');
    expect(names).toContain('defaultTimeout');
    expect(names).toContain('StatusOK');
    expect(names).toContain('statusError');

    const maxRetries = consts.find((s) => s.name === 'MaxRetries');
    expect(maxRetries?.properties?.exported).toBe(true);

    const defTimeout = consts.find((s) => s.name === 'defaultTimeout');
    expect(defTimeout?.properties?.exported).toBe(false);
  });

  it('extracts var declarations', () => {
    const result = parseGo(GO_SOURCE);
    const vars = result.symbols.filter((s) => s.properties?.kind === 'variable');
    const names = vars.map((s) => s.name);
    expect(names).toContain('GlobalConfig');
    expect(names).toContain('debugMode');

    const gc = vars.find((s) => s.name === 'GlobalConfig');
    expect(gc?.properties?.exported).toBe(true);

    const dm = vars.find((s) => s.name === 'debugMode');
    expect(dm?.properties?.exported).toBe(false);
  });

  it('extracts import paths as depends_on relations', () => {
    const result = parseGo(GO_SOURCE);
    const deps = result.relations.filter((r) => r.type === 'depends_on');
    const targets = deps.map((r) => r.targetName);
    expect(targets).toContain('fmt');
    expect(targets).toContain('os');
    expect(deps[0].sourceName).toBe('main.go');
    expect(deps[0].sourceType).toBe('file');
    expect(deps[0].targetType).toBe('file');
  });

  it('creates contains relations for every symbol', () => {
    const result = parseGo(GO_SOURCE);
    const contains = result.relations.filter((r) => r.type === 'contains');
    expect(contains.length).toBe(result.symbols.length);
    for (const rel of contains) {
      expect(rel.sourceName).toBe('main.go');
      expect(rel.sourceType).toBe('file');
      expect(rel.targetType).toBe('symbol');
    }
  });

  it('sets correct namespace on symbols and relations', () => {
    const result = parseGo(GO_SOURCE);
    for (const sym of result.symbols) {
      expect(sym.namespace).toBe('test-ns');
    }
    for (const rel of result.relations) {
      expect(rel.namespace).toBe('test-ns');
    }
  });
});
