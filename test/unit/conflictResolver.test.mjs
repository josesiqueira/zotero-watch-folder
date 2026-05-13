/**
 * Unit tests for conflictResolver.mjs
 * Covers: UT-028 through UT-032
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConflictResolver,
  ResolutionStrategy,
} from '../../content/conflictResolver.mjs';

// conflictResolver.mjs imports getPref from utils.mjs, which calls Zotero.Prefs.get.
// That is mocked in geckoMocks.js, so imports work without modification.

describe('ConflictResolver', () => {
  let resolver;

  beforeEach(() => {
    resolver = new ConflictResolver();
    vi.clearAllMocks();
  });

  // UT-028 — detectConflict
  describe('detectConflict', () => {
    // UT-028a: Zotero unchanged since sync → no conflict
    it('UT-028a: returns null when Zotero unchanged since last sync', () => {
      const result = resolver.detectConflict(
        { timestamp: 100 },  // zoteroState: <= lastSync
        { timestamp: 200 },  // diskState: > lastSync
        { timestamp: 150 }   // lastSyncState
      );
      expect(result).toBeNull();
    });

    // UT-028b: disk unchanged since sync → no conflict
    it('UT-028b: returns null when disk unchanged since last sync', () => {
      const result = resolver.detectConflict(
        { timestamp: 200 },  // zoteroState: > lastSync
        { timestamp: 100 },  // diskState: <= lastSync
        { timestamp: 150 }   // lastSyncState
      );
      expect(result).toBeNull();
    });

    // UT-028c: both changed → conflict
    it('UT-028c: returns conflict object when both sides changed since last sync', () => {
      const zotero = { timestamp: 200, value: 'z' };
      const disk = { timestamp: 200, value: 'd' };
      const sync = { timestamp: 100 };
      const result = resolver.detectConflict(zotero, disk, sync);
      expect(result).not.toBeNull();
      expect(result.zoteroState).toBe(zotero);
      expect(result.diskState).toBe(disk);
      expect(result.lastSyncState).toBe(sync);
      expect(typeof result.detectedAt).toBe('number');
    });

    // UT-028d: both equal but both changed → conflict
    it('UT-028d: returns conflict when both timestamps equal but both changed since sync', () => {
      const result = resolver.detectConflict(
        { timestamp: 150 },
        { timestamp: 150 },
        { timestamp: 100 }
      );
      expect(result).not.toBeNull();
    });

    // UT-028e: neither changed since sync (timestamps <= lastSync) → no conflict
    it('UT-028e: returns null when neither side changed since last sync', () => {
      const result = resolver.detectConflict(
        { timestamp: 50 },
        { timestamp: 50 },
        { timestamp: 150 }
      );
      expect(result).toBeNull();
    });
  });

  // UT-029 — _resolveLastWriteWins
  describe('_resolveLastWriteWins', () => {
    // UT-029a: Zotero newer → apply_zotero_to_disk
    it('UT-029a: applies Zotero to disk when Zotero timestamp is newer', async () => {
      const conflict = {
        zoteroState: { timestamp: 200, value: 'z_val' },
        diskState: { timestamp: 100, value: 'd_val' }
      };
      const result = await resolver._resolveLastWriteWins('test_type', conflict, {});
      expect(result.action).toBe('apply_zotero_to_disk');
      expect(result.winner).toBe('zotero');
    });

    // UT-029b: disk newer → apply_disk_to_zotero
    it('UT-029b: applies disk to Zotero when disk timestamp is newer', async () => {
      const conflict = {
        zoteroState: { timestamp: 100, value: 'z_val' },
        diskState: { timestamp: 200, value: 'd_val' }
      };
      const result = await resolver._resolveLastWriteWins('test_type', conflict, {});
      expect(result.action).toBe('apply_disk_to_zotero');
      expect(result.winner).toBe('disk');
    });

    // UT-029c: equal timestamps → disk wins (else branch)
    it('UT-029c: applies disk to Zotero when timestamps are equal (disk wins by else branch)', async () => {
      const conflict = {
        zoteroState: { timestamp: 150, value: 'z_val' },
        diskState: { timestamp: 150, value: 'd_val' }
      };
      const result = await resolver._resolveLastWriteWins('test_type', conflict, {});
      expect(result.action).toBe('apply_disk_to_zotero');
      expect(result.winner).toBe('disk');
    });
  });

  // UT-030 — _resolveFileExists (via resolve())
  describe('resolve with type=file_exists', () => {
    const params = { type: 'file_exists', sourcePath: '/a/file.pdf', targetPath: '/b/file.pdf' };

    // UT-030a: DISK_WINS → skip
    it('UT-030a: returns skip when strategy is DISK_WINS', async () => {
      resolver._strategy = ResolutionStrategy.DISK_WINS;
      const result = await resolver.resolve(params);
      expect(result.action).toBe('skip');
    });

    // UT-030b: ZOTERO_WINS → overwrite
    it('UT-030b: returns overwrite when strategy is ZOTERO_WINS', async () => {
      resolver._strategy = ResolutionStrategy.ZOTERO_WINS;
      const result = await resolver.resolve(params);
      expect(result.action).toBe('overwrite');
    });

    // UT-030c: KEEP_BOTH → rename
    it('UT-030c: returns rename when strategy is KEEP_BOTH', async () => {
      resolver._strategy = ResolutionStrategy.KEEP_BOTH;
      const result = await resolver.resolve(params);
      expect(result.action).toBe('rename');
    });

    // UT-030d: LAST_WRITE_WINS → rename (default)
    it('UT-030d: returns rename when strategy is LAST_WRITE_WINS (default)', async () => {
      resolver._strategy = ResolutionStrategy.LAST_WRITE_WINS;
      const result = await resolver.resolve(params);
      expect(result.action).toBe('rename');
    });
  });

  // UT-031 — _logConflict / getConflictLog / clearLog
  describe('conflict log operations', () => {
    it('UT-031a: log entries are prepended (most recent first)', () => {
      // Manually call _logConflict for two entries
      const conflict1 = { zoteroState: { timestamp: 100 }, diskState: { timestamp: 200 } };
      const conflict2 = { zoteroState: { timestamp: 300 }, diskState: { timestamp: 400 } };
      resolver._logConflict('type_a', conflict1, {});
      resolver._logConflict('type_b', conflict2, {});
      const log = resolver.getConflictLog();
      // type_b was added last so it should be first (unshift)
      expect(log[0].type).toBe('type_b');
      expect(log[1].type).toBe('type_a');
    });

    it('UT-031b: log is trimmed to _maxLogSize', () => {
      resolver._maxLogSize = 3;
      const conflict = { zoteroState: { timestamp: 1 }, diskState: { timestamp: 2 } };
      for (let i = 0; i < 5; i++) {
        resolver._logConflict(`type_${i}`, conflict, {});
      }
      expect(resolver.getConflictLog().length).toBe(3);
    });

    it('UT-031c: clearLog empties the conflict log', () => {
      const conflict = { zoteroState: { timestamp: 1 }, diskState: { timestamp: 2 } };
      resolver._logConflict('type_x', conflict, {});
      expect(resolver.getConflictLog().length).toBe(1);
      resolver.clearLog();
      expect(resolver.getConflictLog().length).toBe(0);
    });

    it('UT-031d: log entry contains expected fields', () => {
      const conflict = {
        zoteroState: { timestamp: 100 },
        diskState: { timestamp: 200 }
      };
      resolver._logConflict('file_modified', conflict, { path: '/some/path', collection: { id: 5 }, item: { id: 10 } });
      const entry = resolver.getConflictLog()[0];
      expect(entry.type).toBe('file_modified');
      expect(entry.zoteroTimestamp).toBe(100);
      expect(entry.diskTimestamp).toBe(200);
      expect(entry.path).toBe('/some/path');
      expect(entry.collectionID).toBe(5);
      expect(entry.itemID).toBe(10);
    });
  });

  // UT-032 — setStrategy validates known values
  describe('setStrategy', () => {
    // UT-032a: known strategy 'zotero' is accepted
    it('UT-032a: accepts known strategy value "zotero"', () => {
      resolver.setStrategy('zotero');
      expect(resolver.getStrategy()).toBe('zotero');
    });

    // UT-032b: invalid strategy leaves strategy unchanged
    it('UT-032b: ignores unknown strategy, leaves strategy unchanged', () => {
      resolver._strategy = ResolutionStrategy.LAST_WRITE_WINS;
      resolver.setStrategy('invalid');
      expect(resolver.getStrategy()).toBe(ResolutionStrategy.LAST_WRITE_WINS);
    });

    it('UT-032c: accepts all known strategy values', () => {
      for (const strategy of Object.values(ResolutionStrategy)) {
        resolver.setStrategy(strategy);
        expect(resolver.getStrategy()).toBe(strategy);
      }
    });
  });
});
