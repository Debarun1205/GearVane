/**
 * Spaces and chat sessions: the dashboard's navigation state.
 *
 * Eigent organises work into Spaces holding Sessions. Here a space is a
 * named container and a session is one chat transcript; switching never
 * touches the router or the config, it only swaps which messages the
 * transcript renders. Everything is pure over an injected store shape so
 * the rules pin in unit tests without a DOM; the renderer persists the
 * board to localStorage.
 */

import type { Message } from '@gearvane/app-core';

export interface Space {
  id: string;
  name: string;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  spaceId: string;
  title: string;
  messages: Message[];
  draft: string;
  createdAt: number;
  updatedAt: number;
}

export interface Board {
  spaces: Space[];
  sessions: ChatSession[];
  activeSpaceId: string;
  activeSessionId: string;
}

/** Caps: localStorage is small and transcripts grow without one. */
export const MAX_SESSIONS = 30;
export const MAX_MESSAGES_PER_SESSION = 100;

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Test seam: reset the suffix counter so ids are predictable. */
export function resetBoardIds(): void {
  counter = 0;
}

export function untitledSpaceName(): string {
  return 'Untitled Space';
}

export function createBoard(): Board {
  const space: Space = { id: nextId('space'), name: untitledSpaceName(), createdAt: Date.now() };
  const session = blankSession(space.id);
  return {
    spaces: [space],
    sessions: [session],
    activeSpaceId: space.id,
    activeSessionId: session.id,
  };
}

function blankSession(spaceId: string): ChatSession {
  const now = Date.now();
  return {
    id: nextId('session'),
    spaceId,
    title: 'New chat',
    messages: [],
    draft: '',
    createdAt: now,
    updatedAt: now,
  };
}

/** Sessions visible in a space, newest first. */
export function sessionsInSpace(board: Board, spaceId: string): ChatSession[] {
  return board.sessions
    .filter((session) => session.spaceId === spaceId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function activeSession(board: Board): ChatSession | undefined {
  return board.sessions.find((session) => session.id === board.activeSessionId);
}

export function activeSpace(board: Board): Space | undefined {
  return board.spaces.find((space) => space.id === board.activeSpaceId);
}

export function createSpace(board: Board, name: string): Board {
  const trimmed = name.trim() || untitledSpaceName();
  const space: Space = { id: nextId('space'), name: trimmed, createdAt: Date.now() };
  const session = blankSession(space.id);
  return {
    spaces: [...board.spaces, space],
    sessions: pruneSessions([...board.sessions, session]),
    activeSpaceId: space.id,
    activeSessionId: session.id,
  };
}

export function renameSpace(board: Board, spaceId: string, name: string): Board {
  const trimmed = name.trim();
  if (!trimmed) return board;
  return {
    ...board,
    spaces: board.spaces.map((space) =>
      space.id === spaceId ? { ...space, name: trimmed } : space,
    ),
  };
}

export function createSession(board: Board, spaceId: string): Board {
  const space = board.spaces.some((entry) => entry.id === spaceId)
    ? spaceId
    : board.activeSpaceId;
  const session = blankSession(space);
  return {
    ...board,
    sessions: pruneSessions([...board.sessions, session]),
    activeSpaceId: space,
    activeSessionId: session.id,
  };
}

export function switchSession(board: Board, sessionId: string): Board {
  const session = board.sessions.find((entry) => entry.id === sessionId);
  if (!session) return board;
  return { ...board, activeSpaceId: session.spaceId, activeSessionId: session.id };
}

/**
 * Snapshot the live transcript into its session before leaving it.
 *
 * Title comes from the first user message, so the Sessions list reads
 * like history instead of timestamps.
 */
export function snapshotSession(
  board: Board,
  sessionId: string,
  messages: Message[],
  draft: string,
): Board {
  return {
    ...board,
    sessions: board.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      const title = titleFor(messages) ?? session.title;
      return {
        ...session,
        title,
        messages: messages.slice(-MAX_MESSAGES_PER_SESSION),
        draft,
        updatedAt: Date.now(),
      };
    }),
  };
}

export function titleFor(messages: Message[]): string | undefined {
  const first = messages.find((message) => message.role === 'user');
  const text = first?.content.trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length > 42 ? `${text.slice(0, 42)}...` : text;
}

function pruneSessions(sessions: ChatSession[]): ChatSession[] {
  if (sessions.length <= MAX_SESSIONS) return sessions;
  return sessions
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);
}

export interface BoardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const BOARD_STORAGE_KEY = 'gearvane.board';

/** Read the persisted board; anything odd falls back to a fresh one. */
export function loadBoard(storage: BoardStorage): Board {
  try {
    const raw = storage.getItem(BOARD_STORAGE_KEY);
    if (!raw) return createBoard();
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return createBoard();
    const record = parsed as Partial<Board>;
    if (!Array.isArray(record.spaces) || !Array.isArray(record.sessions)) {
      return createBoard();
    }
    const board: Board = {
      spaces: record.spaces.filter(
        (space): space is Space =>
          typeof space === 'object' && space !== null &&
          typeof (space as Space).id === 'string' &&
          typeof (space as Space).name === 'string',
      ),
      sessions: record.sessions.filter(
        (session): session is ChatSession =>
          typeof session === 'object' && session !== null &&
          typeof (session as ChatSession).id === 'string' &&
          typeof (session as ChatSession).spaceId === 'string' &&
          Array.isArray((session as ChatSession).messages),
      ),
      activeSpaceId: typeof record.activeSpaceId === 'string' ? record.activeSpaceId : '',
      activeSessionId: typeof record.activeSessionId === 'string' ? record.activeSessionId : '',
    };
    if (board.spaces.length === 0 || board.sessions.length === 0) return createBoard();
    if (!board.spaces.some((space) => space.id === board.activeSpaceId)) {
      board.activeSpaceId = (board.spaces[0] as Space).id;
    }
    if (!board.sessions.some((session) => session.id === board.activeSessionId)) {
      const first = sessionsInSpace(board, board.activeSpaceId)[0] ?? board.sessions[0];
      board.activeSessionId = (first as ChatSession).id;
    }
    return board;
  } catch {
    return createBoard();
  }
}

export function saveBoard(storage: BoardStorage, board: Board): void {
  try {
    storage.setItem(BOARD_STORAGE_KEY, JSON.stringify(board));
  } catch {
    // A lost board only means a fresh workspace next launch.
  }
}
