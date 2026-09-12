'use client';

import * as React from 'react';

/**
 * Keep a Save button busy until the next page actually appears.
 *
 * `useTransition`'s pending flag ends when the server action resolves. But
 * saving a document then opens it, and rendering that page is a round trip of
 * its own — measured at four to five seconds against a database in Tokyo. For
 * those seconds the button had gone back to saying "Save", the form was still
 * on screen unchanged, and the only sign anything had happened was a toast
 * that had already begun to fade.
 *
 * The client reported that as the purchase order not saving. It had saved
 * every time.
 *
 * `busy` stays true from the moment a save succeeds until the component is
 * unmounted by the navigation, so the button never claims to be idle while the
 * user is waiting. It is deliberately one-way: there is nothing to reset,
 * because the only way out of this state is the page changing.
 */
export function useSaveAndOpen(): {
  busy: boolean;
  pending: boolean;
  /** Run a save; call `opening()` from inside it once the save has succeeded. */
  start: (work: () => Promise<void>) => void;
  opening: () => void;
} {
  const [pending, startTransition] = React.useTransition();
  const [opening, setOpening] = React.useState(false);

  return {
    busy: pending || opening,
    pending,
    start: (work) => startTransition(work),
    opening: () => setOpening(true),
  };
}
