import { describe, it, expect, beforeAll } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { extractJava } from '../ast/languages/java.js';
import type { EntitySource } from '@second-brain/types';

const JAVA_SOURCE = `
package com.example.app;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import static java.lang.Math.PI;

public class Server {
    public int port;
    private String host;

    public Server(int port) {
        this.port = port;
    }

    public void start() {}

    private void shutdown() {}
}

class InternalHelper {
    void compute() {}
}

public interface Handler {
    void handle();
}

public enum Status {
    OK,
    ERR
}

record Point(int x, int y) {}
`;

let parser: Parser;
let language: Language;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  const require = createRequire(import.meta.url);
  const wasmDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  language = await Language.load(path.join(wasmDir, 'out', 'tree-sitter-java.wasm'));
  parser.setLanguage(language);
});

function parseJava(source: string) {
  const tree = parser.parse(source);
  if (tree === null) throw new Error('Java source failed to parse');
  const testSource: EntitySource = { type: 'ast', ref: 'test' };
  return extractJava(tree, 'Server.java', 'test-ns', testSource);
}

describe('extractJava', () => {
  it('extracts classes with public/package-private distinction', () => {
    const result = parseJava(JAVA_SOURCE);
    const classes = result.symbols.filter((s) => s.properties?.kind === 'class');
    const names = classes.map((s) => s.name);
    expect(names).toContain('Server');
    expect(names).toContain('InternalHelper');
    expect(names).toContain('Point'); // record → class

    const server = classes.find((s) => s.name === 'Server');
    expect(server?.properties?.exported).toBe(true);
    const internal = classes.find((s) => s.name === 'InternalHelper');
    expect(internal?.properties?.exported).toBe(false);
  });

  it('extracts interfaces as kind=interface', () => {
    const result = parseJava(JAVA_SOURCE);
    const ifaces = result.symbols.filter((s) => s.properties?.kind === 'interface');
    expect(ifaces.map((s) => s.name)).toContain('Handler');
    expect(ifaces[0].properties?.exported).toBe(true);
  });

  it('extracts enums as kind=enum', () => {
    const result = parseJava(JAVA_SOURCE);
    const enums = result.symbols.filter((s) => s.properties?.kind === 'enum');
    expect(enums.map((s) => s.name)).toContain('Status');
    expect(enums[0].properties?.exported).toBe(true);
  });

  it('extracts methods and constructors with class receiver', () => {
    const result = parseJava(JAVA_SOURCE);
    const methods = result.symbols.filter(
      (s) => s.properties?.kind === 'function' && s.properties.receiver === 'Server',
    );
    const names = methods.map((s) => s.name);
    expect(names).toContain('Server'); // constructor
    expect(names).toContain('start');
    expect(names).toContain('shutdown');

    const start = methods.find((s) => s.name === 'start');
    expect(start?.properties?.exported).toBe(true);
    const shutdown = methods.find((s) => s.name === 'shutdown');
    expect(shutdown?.properties?.exported).toBe(false);
  });

  it('extracts fields as variables with class receiver', () => {
    const result = parseJava(JAVA_SOURCE);
    const fields = result.symbols.filter(
      (s) => s.properties?.kind === 'variable' && s.properties.receiver === 'Server',
    );
    const names = fields.map((s) => s.name);
    expect(names).toContain('port');
    expect(names).toContain('host');

    const port = fields.find((s) => s.name === 'port');
    expect(port?.properties?.exported).toBe(true);
    const host = fields.find((s) => s.name === 'host');
    expect(host?.properties?.exported).toBe(false);
  });

  it('extracts imports as depends_on relations (including static)', () => {
    const result = parseJava(JAVA_SOURCE);
    const deps = result.relations.filter((r) => r.type === 'depends_on');
    const targets = deps.map((r) => r.targetName);
    expect(targets).toContain('java.util.List');
    expect(targets).toContain('java.util.concurrent.ConcurrentHashMap');
    expect(targets).toContain('java.lang.Math.PI');
  });

  it('creates contains relations for every symbol', () => {
    const result = parseJava(JAVA_SOURCE);
    const contains = result.relations.filter((r) => r.type === 'contains');
    expect(contains.length).toBe(result.symbols.length);
    for (const rel of contains) {
      expect(rel.sourceName).toBe('Server.java');
      expect(rel.sourceType).toBe('file');
      expect(rel.targetType).toBe('symbol');
    }
  });
});
