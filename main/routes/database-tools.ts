import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { resetDatabaseWithBackup, resetDatabaseForCurrencyChange, getCurrencyResetImpact, listBackups, deleteBackup, getCurrentSchemaVersion, getDatabase } from '../db';
import { clearInMemoryRevokedTokens, clearUserAuthCache, requireRole, authRateLimit } from '../middleware/security';
import { requireMasterPin } from '../middleware/master-pin';
import { asyncHandler } from '../middleware/async-handler';
import { runHealthCheck, applySafeFixes } from '../services/schema-health';
import { isMasterPinAvailable, isMasterPinSet, resetMasterPin } from '../services/master-pin';
import { clearJWTSecretCache } from './auth';
import { getHttpRequestSignal } from '../shutdown';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { googleDrive } from '../services/google-drive';
import { isSupportedCurrencyCode } from '../../shared/currencies';

type AuthenticatedRequest = Request & { user?: { userId?: string; role?: string } };

const router = Router();

// Read-only / additive-only — not master-PIN gated, only owner-gated.
router.get('/health-check', requireRole(...ROLE_ACCESS.owner), (_req: Request, res: Response) => {
  try {
    res.json(runHealthCheck());
  } catch (error: any) {
    console.error('[DB Tools] health-check error:', error);
    res.status(500).json({ error: 'Health check failed' });
  }
});

router.post('/apply-safe-fixes', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { findingIds?: unknown };
    const { findingIds } = body;
    if (findingIds !== undefined && (!Array.isArray(findingIds) || findingIds.some((id) => typeof id !== 'string'))) {
      return res.status(400).json({ error: 'findingIds must be an array of finding id strings' });
    }
    res.json(applySafeFixes(findingIds as string[] | undefined));
  } catch (error: any) {
    console.error('[DB Tools] apply-safe-fixes error:', error);
    res.status(500).json({ error: 'Applying fixes failed' });
  }
});

// Read-only listing of the managed backups/ directory (#120). Not master-PIN
// gated — same read-only rationale as /health-check.
router.get('/backups', requireRole(...ROLE_ACCESS.owner), (_req: Request, res: Response) => {
  try {
    res.json({ backups: listBackups() });
  } catch (error: any) {
    console.error('[DB Tools] list backups error:', error);
    res.status(500).json({ error: 'Listing backups failed' });
  }
});

// Deletes one backup from the managed backups directory, protected by Master PIN.
router.post('/backups/:fileName/delete', requireRole(...ROLE_ACCESS.owner), requireMasterPin, (req: Request, res: Response) => {
  try {
    deleteBackup(req.params.fileName as string);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[DB Tools] delete backup error:', error);
    if (error?.code === 'ERR_INVALID_BACKUP_NAME') {
      return res.status(400).json({ error: 'Invalid backup file name' });
    }
    if (error?.code === 'ERR_BACKUP_NOT_FOUND') {
      return res.status(404).json({ error: 'Backup not found' });
    }
    res.status(500).json({ error: 'Deleting backup failed' });
  }
});

router.get('/master-pin/status', requireRole(...ROLE_ACCESS.owner), (_req: Request, res: Response) => {
  res.json({ available: isMasterPinAvailable(), isSet: isMasterPinSet(), schemaVersion: getCurrentSchemaVersion() });
});

// Overwriting the Master PIN rewrites the secret that gates every destructive
// operation on this device, so a valid owner JWT alone is not sufficient: the
// owner must re-authenticate with the account password. Password recovery
// stays available through /auth/recover-password (master-PIN gated), so an
// owner who forgets either factor still has a supported path back.
router.post('/master-pin/reset', authRateLimit(), requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  const { pin, confirm_pin, password } = req.body as { pin?: string; confirm_pin?: string; password?: unknown };
  const cleanPin = String(pin || '').trim();
  if (!/^\d{4}$/.test(cleanPin)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  }
  if (cleanPin !== confirm_pin) {
    return res.status(400).json({ error: 'PINs do not match' });
  }
  if (!isMasterPinAvailable()) {
    return res.status(409).json({ error: 'Master PIN is not available on this device' });
  }
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'Current password is required' });
  }
  const actorUserId = String((req as AuthenticatedRequest).user?.userId || '');
  const owner = getDatabase()
    .prepare('SELECT password FROM users WHERE id = ? AND role = ? AND is_active = 1')
    .get(actorUserId, 'owner') as { password: string } | undefined;
  if (!owner || !bcrypt.compareSync(password, owner.password)) {
    // Never log the submitted or stored credential; actor + timestamp only.
    console.error(`[DB Tools] master-pin reset rejected: owner re-authentication failed (user ${actorUserId}, ${new Date().toISOString()})`);
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  try {
    resetMasterPin(cleanPin);
    console.log(`[DB Tools] master-pin reset completed after owner re-authentication (user ${actorUserId}, ${new Date().toISOString()})`);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[DB Tools] set Master PIN error:', error);
    res.status(500).json({ error: 'Failed to set Master PIN' });
  }
});

const INITIALIZE_CONFIRM_PHRASE = 'INITIALIZE';

router.get('/currency-reset-impact', requireRole(...ROLE_ACCESS.owner), (_req: Request, res: Response) => {
  try {
    res.json(getCurrencyResetImpact());
  } catch (error: unknown) {
    console.error('[DB Tools] currency reset impact error:', error);
    res.status(500).json({ error: 'Could not inspect currency reset impact' });
  }
});

router.post('/currency-reset', requireRole(...ROLE_ACCESS.owner), requireMasterPin, asyncHandler(async (req: Request, res: Response) => {
  const currency = typeof req.body?.currency === 'string' ? req.body.currency.trim().toUpperCase() : '';
  if (!isSupportedCurrencyCode(currency)) {
    return res.status(400).json({ error: 'Invalid or unsupported currency' });
  }

  const impact = getCurrencyResetImpact();
  if (!impact.currentCurrency) {
    return res.status(409).json({ error: 'Store currency is not configured' });
  }
  if (impact.currentCurrency === currency) {
    return res.status(409).json({ error: 'The selected currency is already active' });
  }
  if (req.body?.current_currency !== impact.currentCurrency) {
    return res.status(409).json({ error: 'The active currency changed. Reload settings and try again.' });
  }

  const confirmationPhrase = `CHANGE TO ${currency}`;
  if (req.body?.confirmation_phrase !== confirmationPhrase) {
    return res.status(400).json({ error: `Type "${confirmationPhrase}" to confirm` });
  }

  try {
    await googleDrive.prepareForDatabaseRestore();
    const result = await resetDatabaseForCurrencyChange(currency, impact.currentCurrency, getHttpRequestSignal(req));

    // ── Post-commit side effects ────────────────────────────────────────────
    // The currency change is already committed here (the reset replaced and
    // re-seeded the database). A failure while releasing Drive restore state,
    // refreshing the auth cache, or emitting the response must NOT be reported
    // as a failed currency reset: there is nothing left to roll back and the
    // user must never be invited to repeat a destructive operation.
    let cleanupPending = result.cleanupPending === true;
    try {
      const cleanup = googleDrive.completeDatabaseRestore();
      cleanupPending = cleanupPending || cleanup?.cleanupPending === true;
    } catch (cleanupError) {
      cleanupPending = true;
      console.error('[DB Tools] Post-commit restore cleanup failed (currency reset is committed):', cleanupError);
    }
    try {
      clearUserAuthCache();
      clearInMemoryRevokedTokens();
      clearJWTSecretCache();
    } catch (cacheError) {
      console.error('[DB Tools] Post-commit cache cleanup failed:', cacheError);
    }
    try {
      res.json({
        success: true,
        currency,
        backupPath: result.backupPath,
        cleanupPending,
      });
    } catch (responseError) {
      console.error('[DB Tools] Post-commit response emission failed (currency reset is committed):', responseError);
    }
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_CURRENCY_CHANGED') {
      return res.status(409).json({ error: 'The active currency changed. Reload settings and try again.' });
    }
    console.error('[DB Tools] currency reset error:', error);
    res.status(500).json({ error: 'Currency reset failed' });
  } finally {
    try {
      googleDrive.releaseDatabaseRestore();
    } catch (releaseError) {
      // The operation is already committed and acknowledged; re-throwing here
      // would surface as a contradictory second response on the sent 200.
      console.error('[DB Tools] Post-response Drive restore release failed (currency reset is committed):', releaseError);
    }
  }
}));

router.post('/initialize', requireRole(...ROLE_ACCESS.owner), requireMasterPin, asyncHandler(async (req: Request, res: Response) => {
  if (req.body?.confirmation_phrase !== INITIALIZE_CONFIRM_PHRASE) {
    return res.status(400).json({ error: `Type "${INITIALIZE_CONFIRM_PHRASE}" to confirm` });
  }
  try {
    await googleDrive.prepareForDatabaseRestore();
    const result = await resetDatabaseWithBackup(getHttpRequestSignal(req));

    // ── Post-commit side effects ────────────────────────────────────────────
    // The initialize (database wipe + re-seed) is already committed here. A
    // failure in Drive restore cleanup, auth-cache refresh, or response emission
    // must not be reported as a failed initialize: there is nothing to roll back
    // and repeating it would destroy a fresh, valid database.
    let cleanupPending = result.cleanupPending === true;
    try {
      const cleanup = googleDrive.completeDatabaseRestore();
      cleanupPending = cleanupPending || cleanup?.cleanupPending === true;
    } catch (cleanupError) {
      cleanupPending = true;
      console.error('[DB Tools] Post-commit restore cleanup failed (initialize is committed):', cleanupError);
    }
    try {
      clearUserAuthCache();
      clearInMemoryRevokedTokens();
      clearJWTSecretCache();
    } catch (cacheError) {
      console.error('[DB Tools] Post-commit cache cleanup failed:', cacheError);
    }
    try {
      res.json({ success: true, backupPath: result.backupPath, cleanupPending });
    } catch (responseError) {
      console.error('[DB Tools] Post-commit response emission failed (initialize is committed):', responseError);
    }
  } catch (error: any) {
    console.error('[DB Tools] initialize error:', error);
    res.status(500).json({ error: 'Initialize failed' });
  } finally {
    try {
      googleDrive.releaseDatabaseRestore();
    } catch (releaseError) {
      // The operation is already committed and acknowledged; re-throwing here
      // would surface as a contradictory second response on the sent 200.
      console.error('[DB Tools] Post-response Drive restore release failed (initialize is committed):', releaseError);
    }
  }
}));

export const databaseToolsRoutes = router;
