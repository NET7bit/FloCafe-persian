/**
 * Guards the lazy-loading invariant for optional startup dependencies.
 *
 * `qrcode` (~57 modules together with `pngjs`) and `@googleapis/drive` (~56
 * modules together with google-auth-library, googleapis-common and gaxios) are
 * only needed inside request handlers and Drive operations, but both used to be
 * static imports — so every cold start paid for them. They are now resolved on
 * first use. These assertions fail if a static import, or any other eager
 * reference, reappears and silently puts them back on the startup graph.
 *
 * The static half parses `main/` with the TypeScript compiler API instead of
 * matching source text, so quote style, line breaks, formatting and comments
 * cannot decide the verdict. A specifier only counts when it is a real import
 * declaration, a `require(...)` call or an `import(...)` call.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { toPosixPath } from './helpers/posix-path';

const root = path.resolve(__dirname, '..');

/** The only module allowed to load `qrcode`; it resolves the package on first use. */
const QRCODE_OWNER = 'main/lib/qrcode.ts';
/** The only module allowed to load `@googleapis/drive`. */
const DRIVE_OWNER = 'main/services/google-drive.ts';

type LoadKind = 'import' | 'export' | 'dynamic' | 'require';

interface ModuleLoad {
  specifier: string;
  kind: LoadKind;
  line: number;
}

function sourceFilesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(fullPath);
    return entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function parse(relativePath: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every module a file actually loads at runtime, with the form that loads it. */
export function moduleLoadsOf(source: ts.SourceFile): ModuleLoad[] {
  const loads: ModuleLoad[] = [];
  const record = (specifier: ts.StringLiteral, kind: LoadKind) => {
    loads.push({
      specifier: specifier.text,
      kind,
      line: source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        record(node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 'export');
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression)) record(expression, 'require');
    } else if (ts.isCallExpression(node)) {
      const [firstArgument] = node.arguments;
      if (firstArgument && ts.isStringLiteral(firstArgument)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) record(firstArgument, 'dynamic');
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') record(firstArgument, 'require');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return loads;
}

/** Files under `main/` that load the given package, with the loads they perform. */
function filesLoading(packageName: string): Array<{ file: string; loads: ModuleLoad[] }> {
  return sourceFilesUnder(path.join(root, 'main'))
    .map((file) => toPosixPath(path.relative(root, file)))
    // A specifier is always a string literal, so a file that never spells the package name
    // cannot load it. Skipping those keeps the parse to the few files that matter.
    .filter((file) => fs.readFileSync(path.join(root, file), 'utf8').includes(packageName))
    .map((file) => ({ file, loads: moduleLoadsOf(parse(file)).filter((load) => load.specifier === packageName) }))
    .filter((entry) => entry.loads.length > 0)
    .sort((left, right) => left.file.localeCompare(right.file));
}

function isZeroArgumentCallTo(node: ts.Node, name: string): boolean {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === name
    && node.arguments.length === 0;
}

/** Lines where `drive()` is invoked with the module object as its receiver. */
export function driveCallsOnModuleObject(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (callee.name.text === 'drive' && isZeroArgumentCallTo(callee.expression, 'driveApi')) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

/** Lines where `drive` is destructured out of a zero-argument `driveApi()` call. */
export function detachedDriveBindings(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && isZeroArgumentCallTo(node.initializer, 'driveApi')
    ) {
      const bindsDrive = node.name.elements.some(
        (element) => ts.isBindingElement(element) && !element.propertyName && ts.isIdentifier(element.name) && element.name.text === 'drive',
      );
      if (bindsDrive) lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function assertStaticImports() {
  const qrcodeLoads = filesLoading('qrcode');
  assert.deepEqual(
    qrcodeLoads.map((entry) => entry.file),
    [QRCODE_OWNER],
    `${QRCODE_OWNER} must be the only main/ source that loads qrcode; a static import anywhere else puts it back on the startup graph`,
  );
  assert.deepEqual(
    qrcodeLoads[0].loads.map((load) => load.kind),
    ['dynamic'],
    'the qrcode helper must load the package with import(), never with a static import or require()',
  );

  const driveLoads = filesLoading('@googleapis/drive');
  assert.deepEqual(
    driveLoads.map((entry) => entry.file),
    [DRIVE_OWNER],
    `${DRIVE_OWNER} must be the only main/ source that loads @googleapis/drive`,
  );
  assert.deepEqual(
    driveLoads[0].loads.map((load) => load.kind),
    ['require'],
    'google-drive must resolve @googleapis/drive exactly once, lazily',
  );

  // `drive()` forwards its own `this` into `getAPI(..., context)`, so calling it as
  // `driveApi().drive(...)` hands the module exports to `parameters.context.google`.
  // The static-import form passed `undefined`; keep that receiver.
  const driveSource = parse(DRIVE_OWNER);
  assert.deepEqual(
    driveCallsOnModuleObject(driveSource),
    [],
    'drive() must never be called off the module object; it would pass the module exports as `this`',
  );
  assert.notDeepEqual(
    detachedDriveBindings(driveSource),
    [],
    'drive() must be destructured out of driveApi() so `this` stays undefined',
  );
}

function cachedModuleFiles(packageName: string): string[] {
  const marker = new RegExp(`[\\\\/]node_modules[\\\\/]${packageName}[\\\\/]`);
  return Object.keys(require.cache).filter((file) => marker.test(file));
}

async function assertQrcodeResolvesOnFirstUse() {
  assert.deepEqual(cachedModuleFiles('qrcode'), [], 'qrcode must not be in the module cache before it is used');

  const { loadQRCode } = require('../main/lib/qrcode') as typeof import('../main/lib/qrcode');
  assert.deepEqual(cachedModuleFiles('qrcode'), [], 'importing the helper must not resolve qrcode');

  const first = await loadQRCode();
  assert.equal(typeof first.toDataURL, 'function', 'loadQRCode() must resolve the qrcode module');
  const resolved = cachedModuleFiles('qrcode');
  assert.ok(resolved.length > 0, 'the first loadQRCode() call must resolve the package');

  const second = await loadQRCode();
  assert.equal(second, first, 'loadQRCode() must return the memoised module');
  assert.deepEqual(cachedModuleFiles('qrcode'), resolved, 'a second call must not resolve anything new');
}

async function run(): Promise<void> {
  assertStaticImports();
  await assertQrcodeResolvesOnFirstUse();
  console.log('Lazy startup module audit passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
