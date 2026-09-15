import { useState } from 'react';
import { api } from '../lib/api';
import { Button, ErrorBanner, Input, Modal } from './ui';

/** Self-service password change, reachable by every role from the header. Unlike Admin's
 *  ResetPasswordModal (a Leader/Admin forcing a reset on someone else), this always asks for the
 *  current password first. A successful change bumps the account's token_version just like an admin
 *  reset does, so the session making this very request goes stale too — the only clean way to handle
 *  that is to send the person back to Login rather than leave them on a page whose next API call would
 *  otherwise fail with a confusing 401. */
export default function ChangePasswordModal({ open, onClose }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function reset() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) return setError('New password must be at least 8 characters.');
    if (newPassword !== confirmPassword) return setError('New password and confirmation do not match.');

    setSaving(true);
    try {
      await api.post('/auth/change-password', { current_password: currentPassword, new_password: newPassword });
      window.location.href = '/login?password_changed=1';
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Change Password">
      <form onSubmit={submit} className="space-y-3">
        <Input label="Current password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoFocus />
        <Input label="New password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        <Input label="Confirm new password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
        <ErrorBanner message={error} />
        <p className="text-xs text-grey-400">Changing your password signs you out everywhere — you'll need to sign back in right after.</p>
        <Button type="submit" disabled={saving}>{saving ? 'Changing…' : 'Change Password'}</Button>
      </form>
    </Modal>
  );
}
