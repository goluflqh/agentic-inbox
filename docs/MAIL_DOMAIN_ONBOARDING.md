# Mail Domain Onboarding Runbook

This runbook adds a domain to the live Agentic Inbox without guessing about DNS ownership or replacing working website/mail records.

## Fixed architecture

- Live repository: `D:\mail-domain`
- Inbox: `https://inbox.quanghuylee.cyou`
- Worker: `agentic-inbox`
- Inbound: Cloudflare Email Routing catch-all -> `agentic-inbox`
- Outbound: selected per sender domain with `OUTBOUND_PROVIDER_BY_DOMAIN`
- Resend is sending-only. Keep Resend Receiving disabled.

## Inputs to establish first

Record these before changing anything:

- Domain
- Desired mailbox and display name
- Current authoritative nameservers
- Current website A/AAAA/CNAME records and HTTP status
- Existing MX, SPF, DKIM, DMARC, CAA, and DNSSEC/DS records
- Cloudflare zone/account ownership
- Outbound provider (`resend`, `smtp2go`, `brevo`, or `cloudflare`)

Never infer that a domain is already on Cloudflare from its registrar or website host. Query the public authoritative DNS.

## Choose exactly one path

### Path A: domain is already active on Cloudflare

Use this path only when the public authoritative nameservers are Cloudflare and the zone is accessible in the intended account.

1. Snapshot public DNS and verify the website before making changes.
2. Confirm the Cloudflare zone is `Active`.
3. Enable Cloudflare Email Routing.
4. Review the generated mail DNS records. Do not overwrite unrelated existing MX or SPF records without an explicit migration decision.
5. Configure the catch-all rule:
   - Matcher: all addresses
   - Action: Send to Worker
   - Worker: `agentic-inbox`
   - Enabled: yes
6. Add the domain to Worker configuration:

   ```powershell
   npm run domain:add -- example.com -Provider resend -Scenario Cloudflare
   ```

7. Update the production Worker variables to match `wrangler.jsonc`, then deploy. If the Wrangler token lacks permission, use the authenticated Cloudflare Dashboard and verify the live values afterward.
8. Create the requested mailbox in Agentic Inbox.
9. Configure and verify the outbound provider.
10. Run inbound, outbound, DNS, and website verification from the final checklist.

### Path B: domain is still managed at a registrar or another DNS provider

This path includes the extra DNS migration used for `minhhongdanang.page`.

1. Snapshot the current authoritative DNS:
   - A, AAAA, CNAME
   - MX
   - TXT, especially SPF and site verification
   - DKIM and DMARC
   - CAA
   - NS and SOA
   - DNSSEC/DS at the registrar
2. Verify the website and record its current HTTP status and origin IP.
3. Create the Cloudflare zone without changing nameservers yet.
4. Copy all required records into Cloudflare.
   - Keep website records **DNS only** unless proxying is explicitly requested and tested.
   - Preserve site-verification TXT records.
   - Preserve existing mail records until a migration decision is made.
5. Compare the Cloudflare record set with the snapshot. Stop if any production record is missing or ambiguous.
6. Check DNSSEC. Remove or replace stale DS records before nameserver cutover when required by the registrar/Cloudflare instructions.
7. Show the exact old and new nameservers and obtain explicit approval for the registrar change.
8. Change nameservers at the registrar.
9. Wait until Cloudflare reports the zone `Active`, then verify publicly:
   - NS resolves to the assigned Cloudflare nameservers.
   - Website A/AAAA/CNAME still resolves to the original destination.
   - Website returns the expected HTTP response.
10. Only after the website verification passes, continue with Path A from Email Routing onward:

   ```powershell
   npm run domain:add -- example.com -Provider resend -Scenario Registrar
   ```

## Outbound provider rules

### Resend

- Add the domain as a sending domain.
- Prefer Resend's generated sending/bounce subdomain records.
- Add the exact DKIM and CNAME/TXT records shown by Resend.
- Keep Resend Receiving disabled.
- Do not replace Cloudflare Email Routing root MX records.
- Do not create a second SPF TXT record at the same hostname. Merge only when the provider explicitly requires the same hostname and the result remains one valid SPF record.
- Add DMARC if absent. Initial monitoring policy:

  ```text
  _dmarc TXT v=DMARC1; p=none;
  ```

- Treat outbound as pending until Resend reports `Verified`.

### SMTP2GO or Brevo

- Verify the sending domain/sender in the provider dashboard.
- Add only the provider's exact DNS records.
- Store API keys as Worker secrets, never in Git.
- Confirm the production secret exists before mapping a domain to the provider.

### Cloudflare Email Sending

- Confirm the account and sender are eligible for the Email Sending binding.
- Keep the `EMAIL` binding configured.
- Do not map a domain to `cloudflare` until a real send succeeds.

## Production configuration

`DOMAINS` and `OUTBOUND_PROVIDER_BY_DOMAIN` must agree in both places:

1. `wrangler.jsonc`
2. Live Worker production variables

The helper script changes local configuration only. It intentionally does not edit registrar DNS, Cloudflare routing rules, secrets, or live Worker variables.

## Final verification checklist

Run every check; do not declare completion from dashboard state alone.

1. Public NS is expected.
2. Website records still resolve to the expected origin.
3. Website returns the expected HTTP status.
4. Cloudflare Email Routing MX/SPF/DKIM are public.
5. Catch-all is enabled and points to `agentic-inbox`.
6. Live Worker variables include the new domain and outbound mapping.
7. Agentic Inbox lists the domain and requested mailbox.
8. Send an external inbound message to the mailbox and confirm it appears.
9. Wait for the outbound provider to report verified.
10. Send a message from the new mailbox to an external inbox.
11. Inspect received headers for SPF, DKIM, and DMARC results.
12. Run:

    ```powershell
    npm run typecheck
    npm run build
    git diff --check
    ```

## Failure and safety rules

- Never request or display account passwords, API keys, cookies, or browser storage.
- Prefer user-completed authentication and an already authenticated dashboard session.
- Do not change nameservers before copying and comparing production DNS.
- Do not enable Cloudflare proxy for an existing VPS website unless explicitly requested.
- Do not replace working MX/SPF records by assumption.
- When an API token lacks permission, use the dashboard and verify the resulting live state.
- Preserve unrelated worktree changes. Do not stage or push browser captures, `.agent/`, `.playwright-cli/`, secrets, or session checkpoints.
