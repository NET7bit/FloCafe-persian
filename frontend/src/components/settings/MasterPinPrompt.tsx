'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslations } from 'use-intl';

interface MasterPinPromptProps {
  open: boolean;
  mode: 'verify' | 'set';
  title?: string;
  description?: string;
  onCancel: () => void;
  onSubmit: (pin: string, password?: string) => Promise<{ success: boolean; error?: string }>;
}

const PIN_REGEX = /^\d{4}$/;

export function MasterPinPrompt({ open, mode, title, description, onCancel, onSubmit }: MasterPinPromptProps) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setPin('');
    setConfirmPin('');
    setPassword('');
    setError(null);
    setSubmitting(false);
  };

  const handleCancel = () => {
    reset();
    onCancel();
  };

  const handleSubmit = async () => {
    setError(null);

    if (!PIN_REGEX.test(pin)) {
      setError(t('pinFourDigits'));
      return;
    }
    if (mode === 'set' && pin !== confirmPin) {
      setError(t('pinMismatch'));
      setConfirmPin('');
      return;
    }
    // Changing the master PIN requires re-authenticating with the account
    // password; the backend rejects a valid session without it.
    if (mode === 'set' && password.length === 0) {
      setError(t('currentPasswordRequired'));
      return;
    }

    setSubmitting(true);
    const result = await onSubmit(pin, mode === 'set' ? password : undefined);
    setSubmitting(false);

    if (result.success) {
      reset();
    } else {
      setError(result.error || tCommon('somethingWrong'));
      setPin('');
      setConfirmPin('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleCancel()}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title || t('masterPin')}</DialogTitle>
          <DialogDescription>
            {description || (mode === 'set'
              ? t('setPinDescription')
              : t('verifyPinDescription'))}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="master-pin">{mode === 'set' ? t('newPin') : t('masterPin')}</Label>
            <Input
              id="master-pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              onKeyDown={(e) => e.key === 'Enter' && mode === 'verify' && handleSubmit()}
              placeholder="••••"
              className="text-center text-lg tracking-[0.5em]"
            />
          </div>

          {mode === 'set' && (
            <div className="space-y-2">
              <Label htmlFor="master-pin-confirm">{t('confirmPin')}</Label>
              <Input
                id="master-pin-confirm"
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                placeholder="••••"
                className="text-center text-lg tracking-[0.5em]"
              />
            </div>
          )}

          {mode === 'set' && (
            <div className="space-y-2">
              <Label htmlFor="master-pin-password">{t('currentPassword')}</Label>
              <Input
                id="master-pin-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              />
              <p className="text-xs text-muted-foreground">{t('currentPasswordHint')}</p>
            </div>
          )}

          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || pin.length !== 4 || (mode === 'set' && password.length === 0)}>
            {submitting ? tCommon('loading') : mode === 'set' ? t('setPinButton') : t('confirmButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
