/**
 * The whole router, which is twelve lines of regular expression and a `hashchange` listener.
 *
 * A hash route is the right call here and not a compromise: the client is a static bundle served by
 * a Worker, and `#/t/ABC123` needs no server-side rewrite, survives a hard refresh, and can be
 * pasted into a chat window by someone who has never heard of a single-page app.
 *
 * `CardSpriteMount` lives at the root because every card in the app is a `<use href="#card-XX">`
 * pointing into that one injected sprite.
 */

import { useEffect, useState } from 'react';
import { CardSpriteMount } from './components/PlayingCard';
import { ArtSpriteMount } from './components/Art';
import { Lobby } from './Lobby';
import { Table } from './Table';
import './styles/app.css';

/** `#/t/ABC123` -> `ABC123`. Anything else -> null, which means the lobby. */
function roomFromHash(hash: string): string | null {
  const match = /^#\/t\/([a-z0-9]{4,12})\/?$/i.exec(hash);
  return match !== null ? match[1].toUpperCase() : null;
}

function currentRoom(): string | null {
  return typeof window === 'undefined' ? null : roomFromHash(window.location.hash);
}

export function App(): JSX.Element {
  const [room, setRoom] = useState<string | null>(currentRoom);

  useEffect(() => {
    function onHashChange(): void {
      setRoom(currentRoom());
    }
    window.addEventListener('hashchange', onHashChange);
    // The hash can already have changed between the first render and this effect.
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <>
      <CardSpriteMount />
      <ArtSpriteMount />
      {/* Keying by room code guarantees a brand-new socket and brand-new state per table. */}
      {room !== null ? <Table roomCode={room} key={room} /> : <Lobby />}
    </>
  );
}
