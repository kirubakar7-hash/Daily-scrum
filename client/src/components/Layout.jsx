import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import WelcomeBanner, { resetWelcomeBanner } from './WelcomeBanner';
import GuidedTour from './GuidedTour';
import ChangePasswordModal from './ChangePasswordModal';
import { useState } from 'react';
import {
  LayoutDashboard, History, ShieldCheck, ScrollText, ListTodo, Users,
  HelpCircle, LogOut, Menu, X, KeyRound,
} from 'lucide-react';
import logoColor from '../assets/brand/solidpro_logo_color.png';

const NAV_BY_ROLE = {
  employee: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/my-tasks', label: 'My Tasks', icon: ListTodo },
    { to: '/all-tasks', label: 'Team Tasks', icon: Users },
    { to: '/history', label: 'My History', icon: History },
  ],
  senior_management: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/my-tasks', label: 'My Tasks', icon: ListTodo },
    { to: '/all-tasks', label: 'Team Tasks', icon: Users },
    { to: '/history', label: 'History', icon: History },
  ],
  leader: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/my-tasks', label: 'My Tasks', icon: ListTodo },
    { to: '/all-tasks', label: 'Team Tasks', icon: Users },
    { to: '/history', label: 'Team History', icon: History },
  ],
  admin: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/my-tasks', label: 'My Tasks', icon: ListTodo },
    { to: '/all-tasks', label: 'Team Tasks', icon: Users },
    { to: '/history', label: 'Team History', icon: History },
    { to: '/admin', label: 'Admin', icon: ShieldCheck },
    { to: '/audit', label: 'Audit Log', icon: ScrollText },
  ],
  super_admin: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/my-tasks', label: 'My Tasks', icon: ListTodo },
    { to: '/all-tasks', label: 'Team Tasks', icon: Users },
    { to: '/history', label: 'Team History', icon: History },
    { to: '/admin', label: 'Admin', icon: ShieldCheck },
    { to: '/audit', label: 'Audit Log', icon: ScrollText },
  ],
};

function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((n) => n[0].toUpperCase()).join('');
}

export default function Layout() {
  const { user, logout } = useAuth();
  const [tourKey, setTourKey] = useState(0);
  const [tourActive, setTourActive] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  if (!user) return null;
  const items = NAV_BY_ROLE[user.role] || [];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-grey-100 sticky top-0 z-20 shadow-sm shadow-grey-900/[0.02]">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <Link to="/" className="shrink-0">
            <img src={logoColor} alt="Solidpro" className="h-8 w-auto select-none" draggable={false} />
          </Link>

          <nav className="hidden md:flex items-center gap-1 flex-1 justify-center">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                data-tour={`nav-${item.to.slice(1)}`}
                className={({ isActive }) =>
                  `relative flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold transition-colors ${
                    isActive ? 'text-brand-700 bg-brand-50' : 'text-grey-600 hover:text-brand-700 hover:bg-grey-50'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={`w-4 h-4 transition-colors ${isActive ? 'text-brand-600' : 'text-grey-400'}`} />
                    {item.label}
                    {isActive && <span className="absolute -bottom-[13px] left-3 right-3 h-0.5 rounded-full bg-brand-600" />}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { resetWelcomeBanner(); setTourKey((k) => k + 1); setTourActive(true); }}
              className="hidden sm:inline-flex items-center justify-center w-9 h-9 rounded-full text-grey-500 hover:text-brand-700 hover:bg-brand-50 transition-colors"
              title="Take a Guided Tour"
            >
              <HelpCircle className="w-5 h-5" />
            </button>
            <button
              onClick={logout}
              className="hidden sm:inline-flex items-center justify-center w-9 h-9 rounded-full text-grey-500 hover:text-accent-600 hover:bg-accent-50 transition-colors"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
            <button
              onClick={() => setChangePasswordOpen(true)}
              className="flex items-center gap-2 pl-2 border-l border-grey-100 rounded-xl hover:bg-grey-50 transition-colors py-1 pr-1"
              title="Change Password"
            >
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-white flex items-center justify-center text-xs font-bold shrink-0">
                {initials(user.full_name)}
              </div>
              <div className="text-right hidden sm:block">
                <div className="text-sm font-semibold text-grey-800 leading-tight">{user.full_name}</div>
                <div className="text-xs text-grey-400 leading-tight">{user.role_label}</div>
              </div>
            </button>
            <button
              onClick={() => setMobileOpen((v) => !v)}
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileOpen}
              className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-full text-grey-600 hover:bg-grey-50"
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <nav className="md:hidden flex flex-col gap-0.5 px-4 pb-3 animate-fade-in-up">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                data-tour={`nav-${item.to.slice(1)}`}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold ${
                    isActive ? 'text-brand-700 bg-brand-50' : 'text-grey-600'
                  }`
                }
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </NavLink>
            ))}
            <div className="flex gap-1 mt-1 pt-2 border-t border-grey-100">
              <button
                onClick={() => { resetWelcomeBanner(); setTourKey((k) => k + 1); setTourActive(true); setMobileOpen(false); }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-grey-600"
              >
                <HelpCircle className="w-4 h-4" /> Help
              </button>
              <button
                onClick={() => { setChangePasswordOpen(true); setMobileOpen(false); }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-grey-600"
              >
                <KeyRound className="w-4 h-4" /> Password
              </button>
              <button onClick={logout} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-accent-600">
                <LogOut className="w-4 h-4" /> Logout
              </button>
            </div>
          </nav>
        )}
      </header>
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
        <WelcomeBanner key={tourKey} role={user.role} name={user.full_name.split(' ')[0]} onStartTour={() => setTourActive(true)} />
        <Outlet />
      </main>
      <GuidedTour role={user.role} active={tourActive} onFinish={() => setTourActive(false)} />
      <ChangePasswordModal open={changePasswordOpen} onClose={() => setChangePasswordOpen(false)} />
    </div>
  );
}
