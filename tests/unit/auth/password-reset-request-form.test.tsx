// @polsia:user-owned — focused behavior coverage for the Better Auth reset request island.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordResetRequestForm } from '@/components/custom/password-reset-request-form';

const { requestPasswordReset } = vi.hoisted(() => ({ requestPasswordReset: vi.fn() }));

vi.mock('@/lib/auth-client', () => ({
  authClient: { requestPasswordReset },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const confirmation = 'If an account exists for this email, we’ll send a password reset link';
let container: HTMLDivElement;
let root: Root;

function renderForm(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(<PasswordResetRequestForm />);
  });
}

async function fillEmail(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('#password-reset-email');
  if (!input) throw new Error('Email input was not rendered');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Input value setter is unavailable');
  setter.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitForm(): Promise<void> {
  const form = container.querySelector('form');
  if (!form) throw new Error('Reset request form was not rendered');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  requestPasswordReset.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PasswordResetRequestForm', () => {
  it('shows identical generic confirmation for successful known and unknown address requests', async () => {
    requestPasswordReset.mockResolvedValue({ error: null });
    const confirmations: string[] = [];

    for (const email of ['known@example.invalid', 'unknown@example.invalid']) {
      renderForm();
      await fillEmail(email);
      await submitForm();
      confirmations.push(container.querySelector('output')?.textContent?.trim() ?? '');
      act(() => root.unmount());
      container.remove();
    }

    expect(confirmations).toEqual([confirmation, confirmation]);
    expect(requestPasswordReset).toHaveBeenNthCalledWith(1, {
      email: 'known@example.invalid',
      redirectTo: `${window.location.origin}/reset-password`,
    });
    expect(requestPasswordReset).toHaveBeenNthCalledWith(2, {
      email: 'unknown@example.invalid',
      redirectTo: `${window.location.origin}/reset-password`,
    });
  });

  it('rejects malformed email without calling Better Auth', async () => {
    renderForm();
    await fillEmail('not-an-email');
    await submitForm();

    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter a valid email address.');
  });

  it('shows a neutral transport error when the request fails', async () => {
    requestPasswordReset.mockRejectedValue(new Error('transport detail must stay private'));
    renderForm();
    await fillEmail('known@example.invalid');
    await submitForm();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'We couldn’t submit your request. Please try again.',
    );
    expect(container.textContent).not.toContain('transport detail');
  });

  it('keeps the form pending until Better Auth responds', async () => {
    let resolveRequest: (result: { error: null }) => void = () => {};
    requestPasswordReset.mockImplementation(
      () => new Promise<{ error: null }>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    renderForm();
    await fillEmail('known@example.invalid');
    await submitForm();

    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe('Sending…');

    await act(async () => {
      resolveRequest({ error: null });
      await Promise.resolve();
    });
    expect(container.querySelector('output')?.textContent).toContain(confirmation);
  });
});
