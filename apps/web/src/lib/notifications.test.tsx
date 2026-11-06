import { AlertBanner } from '@foodstack/ui/components/alert-banner';
import { ConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { FormFieldError } from '@foodstack/ui/components/form-field-error';
import { ToastProvider } from '@foodstack/ui/components/toast';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/** Server-rendered markup checks for the shared notification components (no DOM needed). */
describe('AlertBanner', () => {
  it('announces warnings and dangers, and keeps info/success polite', () => {
    expect(renderToStaticMarkup(<AlertBanner variant="danger" title="Limit reached" />)).toContain(
      'role="alert"',
    );
    expect(renderToStaticMarkup(<AlertBanner variant="warning" title="Trial ends" />)).toContain(
      'role="alert"',
    );
    expect(renderToStaticMarkup(<AlertBanner variant="info">Note</AlertBanner>)).toContain(
      'role="status"',
    );
  });

  it('renders the title, message, action and a labelled dismiss button', () => {
    const html = renderToStaticMarkup(
      <AlertBanner
        variant="warning"
        title="Payment pending"
        action={<a href="/pay">Pay now</a>}
        onDismiss={() => undefined}
      >
        Waiting for confirmation.
      </AlertBanner>,
    );
    expect(html).toContain('Payment pending');
    expect(html).toContain('Waiting for confirmation.');
    expect(html).toContain('href="/pay"');
    expect(html).toContain('aria-label="Dismiss"');
  });
});

describe('FormFieldError', () => {
  it('renders nothing without a message', () => {
    expect(renderToStaticMarkup(<FormFieldError message={null} />)).toBe('');
  });

  it('renders an announced message that a field can reference', () => {
    const html = renderToStaticMarkup(<FormFieldError id="name-error" message="Enter a name" />);
    expect(html).toContain('id="name-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Enter a name');
  });
});

describe('ConfirmDialog', () => {
  it('renders nothing on the server or while closed (it portals into the page)', () => {
    expect(
      renderToStaticMarkup(
        <ConfirmDialog
          open
          onClose={() => undefined}
          onConfirm={() => undefined}
          title="Archive?"
        />,
      ),
    ).toBe('');
  });
});

describe('ToastProvider', () => {
  it('renders its children and one polite live region for toasts', () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <main>app</main>
      </ToastProvider>,
    );
    expect(html).toContain('<main>app</main>');
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
  });
});
