// @polsia:user-owned — end-to-end password reset through the real Better Auth endpoints.
import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

type EmailProxyRequest = {
  to: string;
  subject: string;
  html: string;
  body: string;
  text?: string;
};

const prisma = new PrismaClient();
const email = `password-reset-${randomUUID()}@example.invalid`;
const oldPassword = 'Synthetic Existing Passphrase!23';
const newPassword = 'Synthetic Updated Passphrase!47';
const capturedMessages: EmailProxyRequest[] = [];
const deliveredMessages: EmailProxyRequest[] = [];
let nextMailResult: 'delivered' | 'throw' | 'suppressed' = 'delivered';
const emailProxy: Server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/api/proxy/email/send') {
    response.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (
        typeof payload.to !== 'string' ||
        typeof payload.subject !== 'string' ||
        typeof payload.html !== 'string' ||
        typeof payload.body !== 'string'
      ) {
        response.writeHead(400).end();
        return;
      }

      const message = {
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        body: payload.body,
        ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
      } satisfies EmailProxyRequest;
      capturedMessages.push(message);
      const outcome = nextMailResult;
      nextMailResult = 'delivered';

      if (outcome === 'throw') {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'synthetic proxy failure' }));
        return;
      }

      if (outcome === 'suppressed') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true }));
        return;
      }

      deliveredMessages.push(message);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ email_id: `stub-message-${capturedMessages.length}` }));
    } catch {
      response.writeHead(400).end();
    }
  });
});

let userId: string | undefined;

test.beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    emailProxy.once('error', reject);
    emailProxy.listen(4319, '127.0.0.1', resolve);
  });
});

test.afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  userId ??= user?.id;
  if (userId) {
    await prisma.verification.deleteMany({ where: { value: userId } });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.account.deleteMany({ where: { userId } });
    const membership = await prisma.membership.findUnique({
      where: { userId },
      select: { teamId: true },
    });
    await prisma.membership.deleteMany({ where: { userId } });
    await prisma.workspaceMember.deleteMany({ where: { userId } });
    if (membership?.teamId) {
      await prisma.trialWorkspace.deleteMany({ where: { teamId: membership.teamId } });
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: membership.teamId } });
      await prisma.workspace.deleteMany({ where: { id: membership.teamId } });
      await prisma.team.deleteMany({ where: { id: membership.teamId } });
    }
    await prisma.userSubscription.deleteMany({ where: { userId } });
    await prisma.dailyDigestPrefs.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  await prisma.$disconnect();
  await new Promise<void>((resolve, reject) => {
    emailProxy.close((error) => (error ? reject(error) : resolve()));
  });
});

test('password reset requests stay account-neutral and complete through the emailed link', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto('/signup');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(oldPassword);
  await page.getByLabel('Confirm password').fill(oldPassword);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });
  userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;

  // Signup may send its own verification email through the same configured helper.
  // Start reset-flow assertions with an empty capture window.
  capturedMessages.length = 0;
  deliveredMessages.length = 0;
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await page.getByRole('button', { name: 'Send reset link' }).waitFor();
  await page.getByLabel('Email address').fill(email);
  await expect(page.getByLabel('Email address')).toHaveValue(email);
  await expect
    .poll(() =>
      page.locator('form').evaluate((element) => {
        if (!(element instanceof HTMLFormElement)) throw new Error('Reset form was not rendered');
        return new FormData(element).get('email');
      }),
    )
    .toBe(email);
  const knownResponsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/auth/request-password-reset'),
    { timeout: 8_000 },
  );
  await page.getByRole('button', { name: 'Send reset link' }).click();
  const knownResponse = await knownResponsePromise.catch(async (error: Error) => {
    const bodyText = await page.locator('body').innerText();
    const inputValue = await page.getByLabel('Email address').inputValue();
    const submittedValue = await page.locator('form').evaluate((element) => {
      if (!(element instanceof HTMLFormElement)) throw new Error('Reset form was not rendered');
      return new FormData(element).get('email');
    });
    throw new Error(
      `${error.message}\nPage: ${bodyText}\nInput: ${inputValue}\nForm data: ${String(submittedValue)}\nBrowser errors: ${browserErrors.join(' | ')}`,
    );
  });
  const knownResult = await knownResponse.json();
  await expect(page.getByRole('status')).toHaveText(
    'If an account exists for this email, we’ll send a password reset link',
  );
  expect(knownResponse.status()).toBe(200);
  await expect.poll(() => capturedMessages.length).toBe(1);

  await page.goto('/forgot-password');
  await page.getByRole('button', { name: 'Send reset link' }).waitFor();
  await page.getByLabel('Email address').fill(`unknown-${randomUUID()}@example.invalid`);
  const unknownResponsePromise = page.waitForResponse((response) =>
    response.url().includes('/api/auth/request-password-reset'),
  );
  await page.getByRole('button', { name: 'Send reset link' }).click();
  const unknownResponse = await unknownResponsePromise;
  const unknownResult = await unknownResponse.json();
  await expect(page.getByRole('status')).toHaveText(
    'If an account exists for this email, we’ll send a password reset link',
  );
  expect(unknownResponse.status()).toBe(200);
  expect(unknownResult).toEqual(knownResult);
  expect(capturedMessages).toHaveLength(1);
  expect(deliveredMessages).toHaveLength(1);
  expect(capturedMessages[0]).toMatchObject({
    to: email,
    subject: 'Reset your password',
  });

  const resetLink = capturedMessages[0]?.body.match(/Reset password: (https?:\/\/\S+)/)?.[1];
  expect(resetLink).toBeTruthy();
  if (!resetLink) throw new Error('The captured reset email did not contain its reset URL');
  const resetToken = new URL(resetLink).pathname.split('/').at(-1);
  expect(resetToken).toBeTruthy();

  await page.goto(resetLink);
  await expect(page).toHaveURL(/\/reset-password\?token=/);
  await page.getByRole('button', { name: 'Update password' }).waitFor();
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByRole('status')).toContainText('Your password has been reset.');
  expect(
    await prisma.verification.count({ where: { identifier: `reset-password:${resetToken}` } }),
  ).toBe(0);

  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(oldPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/could not sign in|invalid/i)).toBeVisible();

  await page.getByLabel('Password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  for (const outcome of ['throw', 'suppressed'] as const) {
    nextMailResult = outcome;
    await page.goto('/forgot-password');
    await page.getByRole('button', { name: 'Send reset link' }).waitFor();
    await page.getByLabel('Email address').fill(email);
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes('/api/auth/request-password-reset'),
    );
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(knownResult);
    await expect(page.getByRole('status')).toContainText(
      'If an account exists for this email, we’ll send a password reset link',
    );
    await expect.poll(() => capturedMessages.length).toBe(outcome === 'throw' ? 2 : 3);
  }
  expect(deliveredMessages).toHaveLength(1);

  await page.goto('/reset-password');
  await expect(page.getByRole('status')).toContainText('invalid or has expired');

  const invalidToken = `invalid-${randomUUID()}`;
  await page.goto(`/api/auth/reset-password/${invalidToken}?callbackURL=${encodeURIComponent('http://127.0.0.1:3000/reset-password')}`);
  await expect(page).toHaveURL(/\/reset-password\?error=INVALID_TOKEN/);
  await expect(page.getByRole('status')).toContainText('invalid or has expired');

  const expiredToken = `expired-${randomUUID()}`;
  await prisma.verification.create({
    data: {
      id: randomUUID(),
      identifier: `reset-password:${expiredToken}`,
      value: userId,
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  await page.goto(`/api/auth/reset-password/${expiredToken}?callbackURL=${encodeURIComponent('http://127.0.0.1:3000/reset-password')}`);
  await expect(page).toHaveURL(/\/reset-password\?error=INVALID_TOKEN/);
  await expect(page.getByRole('status')).toContainText('invalid or has expired');
});
