import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import TeamToday from './pages/TeamToday';
import Dashboard from './pages/Dashboard';
import History from './pages/History';
import MyTasks from './pages/MyTasks';
import AllTasks from './pages/AllTasks';

// Admin and Audit Log are the two least-frequently-used, most role-restricted pages (admin/super_admin
// only) — splitting them out of the main bundle means the other 3 roles never download this code at all.
const Admin = lazy(() => import('./pages/Admin'));
const AuditLog = lazy(() => import('./pages/AuditLog'));

function LazyPageFallback() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 rounded-full border-[3px] border-brand-100 border-t-brand-600 animate-spin" />
    </div>
  );
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-grey-50">
        <div className="w-8 h-8 rounded-full border-[3px] border-brand-100 border-t-brand-600 animate-spin" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequireRole({ roles, children }) {
  const { user } = useAuth();
  if (!roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function Home() {
  const { user } = useAuth();
  if (user.role === 'employee' || user.role === 'senior_management') return <Navigate to="/my-tasks" replace />;
  return <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Home />} />
            <Route path="/my-tasks" element={<MyTasks />} />
            <Route path="/all-tasks" element={<AllTasks />} />
            <Route
              path="/team"
              element={
                <RequireRole roles={['leader', 'admin', 'super_admin', 'senior_management']}>
                  <TeamToday />
                </RequireRole>
              }
            />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/history" element={<History />} />
            <Route
              path="/admin"
              element={
                <RequireRole roles={['admin', 'super_admin']}>
                  <Suspense fallback={<LazyPageFallback />}><Admin /></Suspense>
                </RequireRole>
              }
            />
            <Route
              path="/audit"
              element={
                <RequireRole roles={['super_admin', 'admin']}>
                  <Suspense fallback={<LazyPageFallback />}><AuditLog /></Suspense>
                </RequireRole>
              }
            />
            <Route path="/search" element={<Navigate to="/history?tab=search" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
