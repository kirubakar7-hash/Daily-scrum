import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

/** Catches a render error anywhere below it and shows a plain "something went wrong" message instead of
 *  leaving the whole app as a blank white screen — the only recovery a non-technical user had before was
 *  guessing to reload the page, with zero indication anything had actually broken. */
class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Unhandled render error:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'system-ui, sans-serif', background: '#f9fafb' }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: '#111827', marginBottom: 8 }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 16 }}>
              This page hit an unexpected error. Your data is safe — reloading usually fixes this.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{ background: '#16469D', color: 'white', border: 'none', borderRadius: 12, padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
