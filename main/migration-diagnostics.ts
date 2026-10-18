/**
 * Structured diagnostic for a blocked migration.
 *
 * A blocked migration is an operator-facing condition rather than an internal
 * fault: the database is left untouched and someone has to reconcile drift, so
 * the failure carries serializable details instead of prose a UI would have to
 * parse. This module deliberately imports nothing, so the startup-error path can
 * consume it without pulling in the database engine.
 */

export type MigrationProblemObjectType =
  | 'table' | 'column' | 'index' | 'foreign_key' | 'check_constraint' | 'setting';

export interface MigrationConvergenceProblem {
  objectType: MigrationProblemObjectType;
  /** Table, table.column, index or setting key the problem was detected on. */
  object: string;
  /** Concise, stable description of what is wrong. */
  problem: string;
  /** Optional expected-vs-found context. Never contains row data. */
  detail?: string;
}

export const MIGRATION_CONVERGENCE_BLOCKED = 'MIGRATION_CONVERGENCE_BLOCKED';

export interface MigrationConvergenceDiagnostic {
  code: string;
  migrationVersion?: number;
  migrationName?: string;
  problems: MigrationConvergenceProblem[];
  guidance: string;
}

export const MIGRATION_BLOCKED_GUIDANCE =
  'Your data has not been changed. Keep the automatic pre-upgrade backup, then ask an authorized maintainer to reconcile the schema drift before installing Flo Cafe again — do not delete or rebuild the database file.';

export function describeMigrationProblem(problem: MigrationConvergenceProblem): string {
  return `${problem.object}: ${problem.problem}${problem.detail ? ` (${problem.detail})` : ''}`;
}

/**
 * Thrown when a migration refuses to proceed because the database does not match
 * the schema it requires. The transaction it runs in rolls back, so neither a
 * partial change nor an advanced `user_version` survives this error.
 */
export class MigrationConvergenceError extends Error {
  readonly code = MIGRATION_CONVERGENCE_BLOCKED;

  constructor(
    readonly problems: MigrationConvergenceProblem[],
    readonly migrationVersion?: number,
    readonly migrationName?: string,
  ) {
    super(MigrationConvergenceError.buildMessage(problems, migrationVersion, migrationName));
    this.name = 'MigrationConvergenceError';
  }

  /** Safe next step for an operator; never suggests an automatic repair. */
  get guidance(): string {
    return MIGRATION_BLOCKED_GUIDANCE;
  }

  toDiagnostic(): MigrationConvergenceDiagnostic {
    return {
      code: this.code,
      migrationVersion: this.migrationVersion,
      migrationName: this.migrationName,
      problems: this.problems,
      guidance: this.guidance,
    };
  }

  private static buildMessage(
    problems: MigrationConvergenceProblem[],
    migrationVersion?: number,
    migrationName?: string,
  ): string {
    const subject = migrationVersion === undefined
      ? 'Schema upgrade blocked'
      : `Migration v${migrationVersion}${migrationName ? ` (${migrationName})` : ''} is blocked`;
    return `${subject}: the database does not match the schema this build requires. ${problems.map(describeMigrationProblem).join('; ')}`;
  }
}
