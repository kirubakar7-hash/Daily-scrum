import { useState } from 'react';
import { Check, KeyRound } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Button, ErrorBanner, Input, Modal } from './ui';

/** "My Profile", opened from the name/avatar in the header — every role can change the name shown for
 *  them across the app. Email and role are shown but stay Admin-only (Admin → Users). Password changes
 *  keep their own window (ChangePasswordModal), since that one signs the person out afterwards. */
export default function ProfileModal({ open, onClose, onChangePassword }) {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user.full_name);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function close() {
    setName(user.full_name);
    setError('');
    setSaved(false);
    onClose();
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaved(false);
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (!trimmed) return setError('Please enter your name.');
    if (trimmed.length > 100) return setError('Your name must be 100 characters or fewer.');
    setSaving(true);
    try {
      const { user: updated } = await api.patch('/auth/me', { full_name: trimmed });
      setUser(updated);
      setName(updated.full_name);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const unchanged = name.trim().replace(/\s+/g, ' ') === user.full_name;

  return (
    <Modal open={open} onClose={close} title="My Profile">
      <form onSubmit={save} className="space-y-3">
        <Input label="Your name" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={100} required autoFocus />
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div>
            <span className="block text-xs font-medium text-grey-500 mb-0.5">Email</span>
            <span className="text-grey-700 break-all">{user.email}</span>
          </div>
          <div>
            <span className="block text-xs font-medium text-grey-500 mb-0.5">Role</span>
            <span className="text-grey-700">{user.role_label}</span>
          </div>
        </div>
        <p className="text-xs text-grey-400">Your email and role can only be changed by an Admin.</p>
        <ErrorBanner message={error} />
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={() => { close(); onChangePassword(); }}>
            <KeyRound className="w-4 h-4" /> Change password
          </Button>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 animate-scale-in">
                <Check className="w-3.5 h-3.5" /> Saved
              </span>
            )}
            <Button type="submit" disabled={saving || unchanged}>{saving ? 'Saving…' : 'Save name'}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
