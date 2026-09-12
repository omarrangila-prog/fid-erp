'use client';

import * as React from 'react';

/**
 * The last boundary.
 *
 * `(app)/error.tsx` catches anything a page throws, but it renders inside the
 * root layout — so it cannot catch a failure in the layout itself. This can.
 * It replaces the whole document, which means the stylesheet is gone too, so
 * every rule here is inline: a page that appears when styling has failed must
 * not depend on styling.
 *
 * It also gives Next a global boundary of its own to build. The framework
 * default could not be prerendered — the build stopped on
 * `/_global-error` with `Cannot read properties of null (reading 'useContext')`
 * — and a build that does not finish is a deploy that does not happen.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error('[global-error]', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#f7f4ec', color: '#1c1917', fontFamily: 'system-ui, sans-serif' }}>
        <main
          style={{
            maxWidth: '32rem',
            margin: '0 auto',
            padding: '5rem 1.5rem',
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>The system could not load this page</h1>
          <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', lineHeight: 1.7, color: '#57534e' }}>
            Nothing has been saved or lost. Reload, and if it happens again send the reference below to whoever
            supports this system.
          </p>

          {error.digest ? (
            <p
              style={{
                marginTop: '1.5rem',
                fontFamily: 'ui-monospace, monospace',
                fontSize: '0.8125rem',
                color: '#1c1917',
              }}
            >
              Reference {error.digest}
            </p>
          ) : null}

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: 0,
              background: '#1b3a2f',
              color: '#fff',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
