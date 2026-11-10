import React from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider, Toasty } from '@cloudflare/kumo';
import ComposePanel from '../app/components/ComposePanel';

(window as any).fixtureRequests = [];
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, location.href);
  (window as any).fixtureRequests.push({ path: url.pathname, method: init?.method, body: init?.body });
  let data: unknown;
  if (url.pathname === '/api/v1/mailboxes/test@example.com') data = { id: 'test@example.com', email: 'test@example.com', name: 'Test', settings: {} };
  else if (url.pathname.endsWith('/emails') && init?.method === 'POST') data = { id: 'sent', status: new URL(location.href).searchParams.has('warning') ? 'sent_save_failed' : 'sent' };
  else if (url.pathname.endsWith('/folders') || url.pathname === '/api/v1/mailboxes') data = [];
  else return new Response('{}', { status: 404 });
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const router = createMemoryRouter([{ path: '/mailbox/:mailboxId/emails/:folder', element: <ComposePanel /> }], { initialEntries: ['/mailbox/test@example.com/emails/inbox'] });
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><TooltipProvider><Toasty><RouterProvider router={router} /></Toasty></TooltipProvider></QueryClientProvider>);
