import { describe, expect, it } from 'vitest';

import {
  activeSession,
  createBoard,
  createSession,
  createSpace,
  loadBoard,
  renameSpace,
  resetBoardIds,
  saveBoard,
  sessionsInSpace,
  snapshotSession,
  switchSession,
  titleFor,
  type BoardStorage,
} from '../src/board.js';

function memoryStorage(seed?: string): BoardStorage {
  let value: string | null = seed ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
}

const userMessage = (content: string) => ({
  id: 'u1',
  role: 'user' as const,
  content,
  at: 0,
});

describe('board', () => {
  it('starts with one space and one session', () => {
    resetBoardIds();
    const board = createBoard();
    expect(board.spaces).toHaveLength(1);
    expect(board.spaces[0]?.name).toBe('Untitled Space');
    expect(board.sessions).toHaveLength(1);
    expect(activeSession(board)?.id).toBe(board.activeSessionId);
  });

  it('creates and renames spaces, and scopes sessions to them', () => {
    resetBoardIds();
    let board = createBoard();
    board = createSpace(board, 'Research');
    expect(board.spaces).toHaveLength(2);
    expect(board.activeSpaceId).toBe(board.spaces[1]?.id);

    board = renameSpace(board, board.activeSpaceId, '  ');
    expect(board.spaces[1]?.name).toBe('Research');
    board = renameSpace(board, board.activeSpaceId, 'Deep work');
    expect(board.spaces[1]?.name).toBe('Deep work');

    board = createSession(board, board.activeSpaceId);
    expect(sessionsInSpace(board, board.activeSpaceId)).toHaveLength(2);
    expect(sessionsInSpace(board, board.spaces[0]?.id ?? '')).toHaveLength(1);
  });

  it('snapshots transcripts with titles from the first prompt', () => {
    resetBoardIds();
    let board = createBoard();
    const id = board.activeSessionId;
    board = snapshotSession(board, id, [userMessage('Refactor the router for scale please')], '');
    expect(activeSession(board)?.title).toBe('Refactor the router for scale please');

    const other = createSession(board, board.activeSpaceId);
    const switched = switchSession(other, id);
    expect(switched.activeSessionId).toBe(id);
    expect(switchSession(other, 'missing').activeSessionId).toBe(other.activeSessionId);
  });

  it('derives short titles and persists round-trips', () => {
    expect(titleFor([])).toBeUndefined();
    expect(titleFor([userMessage('   ')])).toBeUndefined();
    expect(titleFor([userMessage('a'.repeat(100))])).toBe(`${'a'.repeat(42)}...`);

    resetBoardIds();
    const storage = memoryStorage();
    saveBoard(storage, createBoard());
    const loaded = loadBoard(storage);
    expect(loaded.spaces).toHaveLength(1);
    expect(loadBoard(memoryStorage('junk{'))).toBeTruthy();
  });
});
