/**
 * Turns a fatal startup error into what the operator sees in the native startup
 * dialog, plus the structured fields worth reporting to telemetry.
 *
 * The health screen cannot describe this class of failure: `initDatabase()` runs
 * before the first window exists, so a blocked migration leaves no renderer to
 * render a page with. The startup dialog is the channel the operator actually
 * sees, so a blocked migration is described here in full — which migration, which
 * database objects, and the safe next step — instead of the raw error dump.
 */
import {
  MIGRATION_CONVERGENCE_BLOCKED,
  MIGRATION_BLOCKED_GUIDANCE,
  describeMigrationProblem,
} from './migration-diagnostics';
import type { MigrationConvergenceProblem, MigrationProblemObjectType } from './migration-diagnostics';

export interface StartupFailureDialog {
  title: string;
  body: string;
}

export interface MigrationBlockedDiagnostic {
  code: string;
  migrationVersion?: number;
  migrationName?: string;
  problems: MigrationConvergenceProblem[];
  guidance: string;
}

const MAX_LISTED_PROBLEMS = 12;

const PROBLEM_OBJECT_TYPES: MigrationProblemObjectType[] = [
  'table', 'column', 'index', 'foreign_key', 'check_constraint', 'setting',
];

/** Keeps the dialog honest if a diagnostic arrives from outside this process. */
function asProblems(value: unknown): MigrationConvergenceProblem[] {
  if (!Array.isArray(value)) return [];
  const problems: MigrationConvergenceProblem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const problem = entry as Partial<MigrationConvergenceProblem>;
    if (typeof problem.object !== 'string' || typeof problem.problem !== 'string') continue;
    const objectType = PROBLEM_OBJECT_TYPES.includes(problem.objectType as MigrationProblemObjectType)
      ? (problem.objectType as MigrationProblemObjectType)
      : 'table';
    problems.push({
      objectType,
      object: problem.object,
      problem: problem.problem,
      ...(typeof problem.detail === 'string' ? { detail: problem.detail } : {}),
    });
  }
  return problems;
}

/**
 * Recognizes the blocked-migration diagnostic by its code instead of `instanceof`,
 * which is unreliable when the database module is instantiated more than once.
 */
export function asMigrationBlockedDiagnostic(error: unknown): MigrationBlockedDiagnostic | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as Partial<MigrationBlockedDiagnostic>;
  if (candidate.code !== MIGRATION_CONVERGENCE_BLOCKED) return null;
  const problems = asProblems(candidate.problems);
  if (problems.length === 0) return null;
  return {
    code: candidate.code,
    migrationVersion: typeof candidate.migrationVersion === 'number' ? candidate.migrationVersion : undefined,
    migrationName: typeof candidate.migrationName === 'string' ? candidate.migrationName : undefined,
    problems,
    guidance: typeof candidate.guidance === 'string' && candidate.guidance.trim()
      ? candidate.guidance
      : MIGRATION_BLOCKED_GUIDANCE,
  };
}

function describeMigrationBlocked(diagnostic: MigrationBlockedDiagnostic): StartupFailureDialog {
  const lines = [
    'Flo Cafe cannot open the database until its schema is reconciled.',
    '',
    diagnostic.migrationVersion === undefined
      ? 'A database upgrade was blocked.'
      : `Blocked upgrade: v${diagnostic.migrationVersion}${diagnostic.migrationName ? ` (${diagnostic.migrationName})` : ''}`,
    '',
    `What was found (${diagnostic.problems.length} problem${diagnostic.problems.length === 1 ? '' : 's'}):`,
    ...diagnostic.problems
      .slice(0, MAX_LISTED_PROBLEMS)
      .map((problem) => `  • [${problem.objectType}] ${describeMigrationProblem(problem)}`),
  ];
  const unreported = diagnostic.problems.length - MAX_LISTED_PROBLEMS;
  if (unreported > 0) lines.push(`  …and ${unreported} more`);
  lines.push('', diagnostic.guidance);
  return { title: 'Flo Cafe — database upgrade blocked', body: lines.join('\n') };
}

/**
 * Title and body for the native startup dialog. Unrelated failures keep the
 * original generic message so their established behavior is unchanged.
 */
export function describeStartupFailure(error: unknown): StartupFailureDialog {
  const blocked = asMigrationBlockedDiagnostic(error);
  if (blocked) return describeMigrationBlocked(blocked);
  return { title: 'Initialization Error', body: `Failed to start Flo: ${error}` };
}

/** Extra telemetry fields for a blocked migration; empty for any other failure. */
export function startupFailureTelemetryFields(error: unknown): Record<string, unknown> {
  const blocked = asMigrationBlockedDiagnostic(error);
  if (!blocked) return {};
  return {
    error_code: blocked.code,
    ...(blocked.migrationVersion === undefined ? {} : { migration_version: blocked.migrationVersion }),
    ...(blocked.migrationName ? { migration_name: blocked.migrationName } : {}),
    blocked_object_count: blocked.problems.length,
    blocked_objects: blocked.problems
      .slice(0, MAX_LISTED_PROBLEMS)
      .map((problem) => `${problem.objectType}:${problem.object}`)
      .join(', ')
      .slice(0, 300),
  };
}
