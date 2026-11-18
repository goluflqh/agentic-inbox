import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractQuickEmailMetadata } from '../workers/lib/quick-email-metadata.ts';

test('does not mistake digits in a magic link for a verification code', () => {
  const result = extractQuickEmailMetadata({ subject: 'Sign in with magic link', text: 'Click https://example.com/login?token=12345678 to sign in' });
  assert.equal(result.auth_code, null);
});

test('extracts a complete labeled code without merging unrelated numbers', () => {
  assert.equal(extractQuickEmailMetadata({ subject: 'Your verification code', text: 'Code: 123456\nExpires in 10 minutes' }).auth_code, '123456');
  assert.equal(extractQuickEmailMetadata({ text: 'Your code: 1234 5678\n2026' }).auth_code, '12345678');
  assert.equal(extractQuickEmailMetadata({ text: 'Your code: 987654321' }).auth_code, null);
});

test('avoids guessing codes from reference numbers and link-only emails', () => {
  assert.equal(extractQuickEmailMetadata({ subject: 'Verification link', text: 'Click the link. Reference 123456.' }).auth_code, null);
  assert.equal(extractQuickEmailMetadata({ text: 'Code: 123456 10 minutes' }).auth_code, '123456');
  assert.equal(extractQuickEmailMetadata({ text: 'Your OTP: 1 2 3 4 5 6' }).auth_code, '123456');
  assert.equal(extractQuickEmailMetadata({ text: 'Your code expires on 2026-12-01.' }).auth_code, null);
});

test('recognizes a standalone Notion signup code without including adjacent numbers', () => {
  const html = '<h1>Sign up for Notion</h1><p>You can sign up by entering the code on the sign up page in Notion, or simply by clicking the magic link.</p><div>628279</div><a href="https://example.com/login?token=12345678">Sign in</a>';
  assert.equal(extractQuickEmailMetadata({ subject: 'Your Notion signup code', html }).auth_code, '628279');
  assert.equal(extractQuickEmailMetadata({ subject: 'Your signup code', html: '<p>Code expires on 2026-12-01</p><a href="https://example.com/login?token=123456">Sign in</a>' }).auth_code, null);
  assert.equal(extractQuickEmailMetadata({ subject: 'Your signup code', html: '<div>123456</div><div>987654</div>' }).auth_code, null);
});

test('recognizes alphanumeric Notion login codes and inline sign-in codes', () => {
  const notionLoginHtml = `
    <h1>Login to Notion</h1>
    <div style="background:#f4f4f4;padding:16px;text-align:center;font-family:monospace;">f3EMVU</div>
    <a href="https://www.notion.so/magic-link?token=abcdef123456">Sign in with Magic Link</a>
    <p>Never share this code with anyone. If you didn't request this code, you can ignore this email.</p>
  `;
  const notionResult = extractQuickEmailMetadata({
    subject: 'Your temporary Notion login code',
    html: notionLoginHtml,
  });
  assert.equal(notionResult.auth_code, 'f3EMVU');
  assert.equal(notionResult.quick_link, 'https://www.notion.so/magic-link?token=abcdef123456');

  const koneResult = extractQuickEmailMetadata({
    subject: 'Kone Learning Space sign-in code',
    text: 'Your sign-in code is: 734812 It expires in 15 minutes. If you did not request this code, you can ignore this email.',
  });
  assert.equal(koneResult.auth_code, '734812');

  const labeledAlphanum = extractQuickEmailMetadata({
    subject: 'Your login code',
    text: 'Your temporary login code is: K9x4P2. Do not share this code.',
  });
  assert.equal(labeledAlphanum.auth_code, 'K9x4P2');

  const nestedTagsCode = extractQuickEmailMetadata({
    subject: 'Your temporary Notion login code',
    html: '<table><tr><td><span style="font-size:24px"><b>f3EMVU</b></span></td></tr></table>',
  });
  assert.equal(nestedTagsCode.auth_code, 'f3EMVU');

  const hyphenatedAlphanum = extractQuickEmailMetadata({
    subject: 'Security verification code',
    html: '<p>Enter your verification code:</p><div>AB3-9K2</div>',
  });
  assert.equal(hyphenatedAlphanum.auth_code, 'AB39K2');

  const vietnameseCode = extractQuickEmailMetadata({
    subject: 'Mã xác thực tài khoản',
    text: 'Mã xác nhận của bạn là: 849201. Mã có hiệu lực trong 5 phút.',
  });
  assert.equal(vietnameseCode.auth_code, '849201');
});

test('ignores CSS units, hex colors, and common English words in code emails', () => {
  assert.equal(
    extractQuickEmailMetadata({
      subject: 'Your login code',
      html: '<div>LOGIN</div><div>BUTTON</div><div>15mins</div>',
    }).auth_code,
    null,
  );
  assert.equal(
    extractQuickEmailMetadata({
      subject: 'Your login code',
      html: '<p>Your code is expired. Contact support.</p>',
    }).auth_code,
    null,
  );
});

test('does not mistake programming code snippets or max_tokens=1000 for an auth code', () => {
  const claudeWelcomeHtml = `
    <h1>Welcome to the Claude Platform</h1>
    <pre><code>
      const message = await client.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: <span>1000</span>,
        messages: [{ role: "user", content: "Hello" }]
      });
    </code></pre>
    <div><button>Add credits</button></div>
    <h3>Cookbooks</h3>
    <p>Build on the Claude Platform using ready-to-copy code snippets that you can integrate into your own projects.</p>
  `;
  assert.equal(
    extractQuickEmailMetadata({
      subject: 'Welcome to the Claude Platform',
      html: claudeWelcomeHtml,
    }).auth_code,
    null,
  );

  // Even if an email mentions "your code" in a programming context alongside max_tokens
  const devEmailHtml = `
    <p>Run your code with the following configuration:</p>
    <div>max_tokens =</div>
    <div>1000</div>
  `;
  assert.equal(
    extractQuickEmailMetadata({
      subject: 'Getting started with the API',
      html: devEmailHtml,
    }).auth_code,
    null,
  );
});

test('does not surface unrelated links as verification links', () => {
  assert.equal(extractQuickEmailMetadata({ html: '<a href="https://example.com/blog">Read our blog</a>' }).quick_link, null);
  assert.equal(extractQuickEmailMetadata({ html: '<a href="https://example.com/a/opaque">Sign in to your account</a>' }).quick_link, 'https://example.com/a/opaque');
});

test('extracts Mistral AI verification code alongside verification link in text and HTML', () => {
  const mistralText = [
    'Please verify your email address for your account',
    '',
    'Thank you for signing up. To ensure the security of your account, we need to verify your email address.',
    '',
    'Please use the following code to complete the verification process:',
    '',
    '039929',
    '',
    'or open the link below:',
    '',
    'https://auth.mistral.ai/self-service/verification?code=039929&flow=5ffa140f-f300-478f-82ff-8982de0f3f1f',
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const textResult = extractQuickEmailMetadata({
    subject: 'Please verify your email address for your account',
    text: mistralText,
  });
  assert.equal(textResult.auth_code, '039929');
  assert.equal(
    textResult.quick_link,
    'https://auth.mistral.ai/self-service/verification?code=039929&flow=5ffa140f-f300-478f-82ff-8982de0f3f1f',
  );

  const mistralHtml = `
    <p>Please use the following code</p>
    <p>to complete the verification process:</p>
    <pre style="font-size:28px;">039929</pre>
    <p>or open the link below:</p>
    <p>https://auth.mistral.ai/self-service/verification?code=039929&amp;flow=5ffa140f-f300-478f-82ff-8982de0f3f1f</p>
    <footer><span>MISTRAL</span> <span>TERMS</span> © <span>2026</span></footer>
  `;
  const htmlResult = extractQuickEmailMetadata({
    subject: 'Please verify your email address for your account',
    html: mistralHtml,
  });
  assert.equal(htmlResult.auth_code, '039929');
  assert.equal(
    htmlResult.quick_link,
    'https://auth.mistral.ai/self-service/verification?code=039929&flow=5ffa140f-f300-478f-82ff-8982de0f3f1f',
  );
});

test('extracts Notion signup code even with <pre>, zero-width chars, uppercase tags, and footer years/zips', () => {
  const notionHtml = `
    <div style="display:none">Your Notion signup code&#847;&zwnj;&nbsp;</div>
    <h1>Sign up for Notion</h1>
    <p>You can sign up by entering the code on the sign up page in Notion, or simply by clicking the magic link.</p>
    <pre style="background:#f4f4f4;padding:16px;">&#8203;628279&zwnj;</pre>
    <a href="https://www.notion.so/login/magic?token=abc123def456">Sign in with Magic Link</a>
    <footer>
      <span>NOTES</span> <span>TASKS</span> <span>TERMS</span>
      <span>© </span><span>2026</span> Notion Labs, Inc. San Francisco, CA <span>94107</span>
    </footer>
  `;
  const result = extractQuickEmailMetadata({
    subject: 'Your Notion signup code',
    html: notionHtml,
  });
  assert.equal(result.auth_code, '628279');
  assert.equal(result.quick_link, 'https://www.notion.so/login/magic?token=abc123def456');
});

test('keeps Grok code extraction and Bolt link-only behavior intact without fake codes', () => {
  const grokResult = extractQuickEmailMetadata({
    subject: 'Grok confirmation code: 085-451',
    html: `
      <h1>Validate your email</h1>
      <p>Please use the code below to validate your email address.</p>
      <div>085-451</div>
      <footer>© <span>2026</span> SpaceX Super Intelligence LLC, Austin, TX <span>78701</span>, USA</footer>
    `,
  });
  assert.equal(grokResult.auth_code, '085451');
  assert.equal(grokResult.quick_link, null);

  const boltResult = extractQuickEmailMetadata({
    subject: 'Confirmation instructions',
    html: `
      <h1>Please confirm your email address</h1>
      <p>Hey there - we're so excited to welcome you to Bolt! Please confirm this email address by clicking the link below.</p>
      <a href="https://bolt.new/confirm?token=xyz987654">Confirm your email</a>
      <footer>© <span>2026</span> StackBlitz</footer>
    `,
  });
  assert.equal(boltResult.auth_code, null);
  assert.equal(boltResult.quick_link, 'https://bolt.new/confirm?token=xyz987654');
});
