import React from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider, Toasty } from '@cloudflare/kumo';
import AllEmailList from '../app/routes/all-email-list';

let read = false;
(window as any).fixtureQueries = [];
const email = { id: 'msg-1', mailbox_id: 'test@example.com', mailbox_email: 'test@example.com', subject: 'Fixture unread message', sender: 'sender@example.com', recipient: 'test@example.com', date: '2026-01-01T00:00:00.000Z', body: '<p>Fixture message body</p>', read: false, starred: false, folder_id: 'inbox', thread_count: 1 };
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, location.href);
  let data: unknown;
  if (url.pathname === '/api/v1/config') data = { domains: ['example.com'], emailAddresses: [] };
  else if (url.pathname === '/api/v1/all-emails') { (window as any).fixtureQueries.push(url.search); data = { emails: read && url.searchParams.get('status') === 'unread' ? [] : [email], totalCount: read ? 0 : 75 }; }
  else if (url.pathname.endsWith('/emails/msg-1') && init?.method === 'PUT') { read = true; data = { ...email, read: true }; }
  else if (url.pathname.endsWith('/emails/msg-1')) data = { ...email, read };
  else if (url.pathname.endsWith('/folders')) data = [];
  else if (url.pathname === '/api/v1/mailboxes/test@example.com') data = { id: 'test@example.com', email: 'test@example.com', name: 'Test', settings: {} };
  else if (url.pathname === '/api/v1/mailboxes') data = [];
  else return new Response(JSON.stringify({ error: `Unexpected fixture request ${url.pathname}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const router = createMemoryRouter([{ path: '/all/emails/:folder', element: <AllEmailList /> }], { initialEntries: ['/all/emails/inbox?status=unread&page=3'] });
(window as any).testRouter = router;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><TooltipProvider><Toasty><RouterProvider router={router} /></Toasty></TooltipProvider></QueryClientProvider>);
