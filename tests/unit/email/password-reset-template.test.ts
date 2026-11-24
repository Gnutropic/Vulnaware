// @polsia:user-owned — password reset email content remains usable in HTML and plain text.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/brand', () => ({ brand: { name: 'VulnAware' } }));

import { passwordResetEmail } from '@/lib/email/templates';

describe('passwordResetEmail', () => {
  it('includes the escaped usable reset link in HTML and the original URL in text', () => {
    const resetUrl = 'https://vulnaware.app/reset-password/token?callbackURL=%2Freset-password&source=email';
    const email = passwordResetEmail({ resetUrl });

    expect(email.subject).toBe('Reset your password');
    expect(email.html).toContain(
      'href="https://vulnaware.app/reset-password/token?callbackURL=%2Freset-password&amp;source=email"',
    );
    expect(email.text).toContain(`Reset password: ${resetUrl}`);
    expect(email.text).toContain('This link expires in one hour and can only be used once.');
  });
});
