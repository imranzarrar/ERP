import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import PrintInvoiceView from './PrintInvoiceView.tsx';
import './index.css';
import { debugAuth } from './debug.ts';

// Global Fetch Interceptor to automatically append X-User-ID, Authorization and X-Session-ID headers to all /api requests
const originalFetch = window.fetch;
const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const userId = localStorage.getItem('erp_session_user_id');
  const sessionId = localStorage.getItem('erp_session_id');
  
  if (userId || sessionId) {
    let isApi = false;
    if (typeof input === 'string') {
      isApi = input.startsWith('/api') || input.includes('/api/');
    } else if (input instanceof URL) {
      isApi = input.pathname.startsWith('/api') || input.pathname.includes('/api/');
    } else if (input && typeof (input as any).url === 'string') {
      isApi = (input as any).url.startsWith('/api') || (input as any).url.includes('/api/');
    }

    if (isApi) {
      if (input instanceof Request) {
        try {
          const newHeaders = new Headers(input.headers);
          if (userId) {
            newHeaders.set('X-User-ID', userId);
            newHeaders.set('Authorization', `Bearer ${userId}`);
          }
          if (sessionId) {
            newHeaders.set('X-Session-ID', sessionId);
          }
          input = new Request(input, { headers: newHeaders });
        } catch (e) {
          console.error("Failed to inject headers into Request object:", e);
        }
      } else {
        init = init ? { ...init } : {};
        let headers = init.headers;
        if (headers instanceof Headers) {
          try {
            if (userId) {
              headers.set('X-User-ID', userId);
              headers.set('Authorization', `Bearer ${userId}`);
            }
            if (sessionId) {
              headers.set('X-Session-ID', sessionId);
            }
          } catch (e) {
            const newHeaders = new Headers(headers);
            if (userId) {
              newHeaders.set('X-User-ID', userId);
              newHeaders.set('Authorization', `Bearer ${userId}`);
            }
            if (sessionId) {
              newHeaders.set('X-Session-ID', sessionId);
            }
            init.headers = newHeaders;
          }
        } else if (Array.isArray(headers)) {
          const extra: [string, string][] = [];
          if (userId) {
            extra.push(['X-User-ID', userId], ['Authorization', `Bearer ${userId}`]);
          }
          if (sessionId) {
            extra.push(['X-Session-ID', sessionId]);
          }
          headers = [...headers, ...extra];
          init.headers = headers;
        } else if (headers) {
          const extra: Record<string, string> = {};
          if (userId) {
            extra['X-User-ID'] = userId;
            extra['Authorization'] = `Bearer ${userId}`;
          }
          if (sessionId) {
            extra['X-Session-ID'] = sessionId;
          }
          headers = {
            ...headers,
            ...extra
          };
          init.headers = headers;
        } else {
          const extra: Record<string, string> = {};
          if (userId) {
            extra['X-User-ID'] = userId;
            extra['Authorization'] = `Bearer ${userId}`;
          }
          if (sessionId) {
            extra['X-Session-ID'] = sessionId;
          }
          init.headers = extra;
        }
      }
    }
  }
  return originalFetch(input, init);
};

try {
  Object.defineProperty(window, 'fetch', {
    value: customFetch,
    configurable: true,
    writable: true
  });
} catch (e) {
  try {
    (window as any).fetch = customFetch;
  } catch (err2) {
    console.error("Failed to assign customFetch to window.fetch:", err2);
  }
}

(window as any).debugAuth = debugAuth;

// /print/invoice/:id is a dedicated, chrome-less render target used only by
// server/lib/pdfGenerator.ts's headless Chromium (see PrintInvoiceView.tsx) — never a
// route a real user navigates to. Checked here, before <App/> ever mounts, so none of
// the normal login-gate/localStorage-session-restoration bootstrapping in App.tsx runs
// for it at all.
const printInvoiceMatch = window.location.pathname.match(/^\/print\/invoice\/([^/]+)$/);

createRoot(document.getElementById('root')!).render(
 <StrictMode>
 {printInvoiceMatch ? <PrintInvoiceView invoiceId={printInvoiceMatch[1]} /> : <App />}
 </StrictMode>,
);
