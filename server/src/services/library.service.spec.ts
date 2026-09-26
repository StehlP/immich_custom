import { BadRequestException } from '@nestjs/common';
import { Stats } from 'node:fs';
import { JOBS_LIBRARY_PAGINATION_SIZE } from 'src/constants';
import { defaults, SystemConfig } from 'src/dtos/config.dto';
import { mapLibrary } from 'src/dtos/library.dto';
import { AssetStatus, AssetType, ChecksumAlgorithm, CronJob, ImmichWorker, JobName, JobStatus } from 'src/enum';
import { LibraryService } from 'src/services/library.service';
import { ILibraryBulkIdsJob, ILibraryFileJob } from 'src/types';
import { AssetFactory } from 'test/factories/asset.factory';
import { authStub } from 'test/fixtures/auth.stub';
import { systemConfigStub } from 'test/fixtures/system-config.stub';
import { makeMockWatcher } from 'test/repositories/storage.repository.mock';
import { factory, newDate, newUuid } from 'test/small.factory';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';
import { vitest } from 'vitest';

async function* mockWalk() {
  // eslint-disable-next-line unicorn/no-useless-promise-resolve-reject
  yield await Promise.resolve(['/data/user1/photo.jpg']);
}

describe(LibraryService.name, () => {
  let sut: LibraryService;

  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(LibraryService));

    mocks.database.tryLock.mockResolvedValue(true);
    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onConfigInit', () => {
    it('should init cron job and handle config changes', async () => {
      mocks.cron.create.mockResolvedValue();
      mocks.cron.update.mockResolvedValue();

      await sut.onConfigInit({ newConfig: defaults });

      expect(mocks.cron.create).toHaveBeenCalled();

      await sut.onConfigUpdate({
        oldConfig: defaults,
        newConfig: {
          library: {
            scan: {
              enabled: true,
              cronExpression: '0 1 * * *',
            },
            watch: { enabled: false },
          },
        } as SystemConfig,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: CronJob.LibraryScan,
        expression: '0 1 * * *',
        start: true,
      });
    });

    it('should initialize watcher for all external libraries', async () => {
      const library1 = factory.library({ importPaths: ['/foo', '/bar'] });
      const library2 = factory.library({ importPaths: ['/xyz', '/asdf'] });

      mocks.library.getAll.mockResolvedValue([library1, library2]);

      mocks.library.get.mockImplementation((id) =>
        Promise.resolve([library1, library2].find((library) => library.id === id)),
      );
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });

      expect(mocks.storage.watch.mock.calls).toEqual(
        expect.arrayContaining([(library1.importPaths, expect.anything()), (library2.importPaths, expect.anything())]),
      );
    });

    it('should not initialize watcher when watching is disabled', async () => {
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchDisabled as SystemConfig });

      expect(mocks.storage.watch).not.toHaveBeenCalled();
    });

    it('should not initialize watcher when lock is taken', async () => {
      mocks.database.tryLock.mockResolvedValue(false);

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });

      expect(mocks.storage.watch).not.toHaveBeenCalled();
    });

    it('should not initialize library scan cron job when lock is taken', async () => {
      mocks.database.tryLock.mockResolvedValue(false);

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });

      expect(mocks.cron.create).not.toHaveBeenCalled();
    });
  });

  describe('onConfigUpdateEvent', () => {
    beforeEach(async () => {
      mocks.database.tryLock.mockResolvedValue(true);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: defaults });
    });

    it('should do nothing if instance does not have the watch lock', async () => {
      mocks.database.tryLock.mockResolvedValue(false);
      await sut.onConfigInit({ newConfig: defaults });
      await sut.onConfigUpdate({ newConfig: systemConfigStub.libraryScan as SystemConfig, oldConfig: defaults });
      expect(mocks.cron.update).not.toHaveBeenCalled();
    });

    it('should update cron job and enable watching', async () => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.cron.create.mockResolvedValue();
      mocks.cron.update.mockResolvedValue();

      await sut.onConfigUpdate({
        newConfig: systemConfigStub.libraryScanAndWatch as SystemConfig,
        oldConfig: defaults,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: CronJob.LibraryScan,
        expression: systemConfigStub.libraryScan.library.scan.cronExpression,
        start: systemConfigStub.libraryScan.library.scan.enabled,
      });
    });

    it('should update cron job and disable watching', async () => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.cron.create.mockResolvedValue();
      mocks.cron.update.mockResolvedValue();

      await sut.onConfigUpdate({
        newConfig: systemConfigStub.libraryScanAndWatch as SystemConfig,
        oldConfig: defaults,
      });
      await sut.onConfigUpdate({
        newConfig: systemConfigStub.libraryScan as SystemConfig,
        oldConfig: defaults,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: CronJob.LibraryScan,
        expression: systemConfigStub.libraryScan.library.scan.cronExpression,
        start: systemConfigStub.libraryScan.library.scan.enabled,
      });
    });
  });

  describe('handleQueueSyncFiles', () => {
    it('should queue refresh of a new asset', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(mockWalk);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.asset.filterNewExternalAssetPaths.mockResolvedValue(['/data/user1/photo.jpg']);

      await sut.handleQueueSyncFiles({ id: library.id });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibrarySyncFiles,
        data: {
          libraryId: library.id,
          paths: ['/data/user1/photo.jpg'],
          progressCounter: 1,
        },
      });
    });

    it('should fail when library is not found', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      await expect(sut.handleQueueSyncFiles({ id: library.id })).resolves.toBe(JobStatus.Skipped);
    });

    it('should ignore import paths that do not exist', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });
      mocks.storage.stat.mockImplementation((path): Promise<Stats> => {
        if (path === library.importPaths[0]) {
          const error = { code: 'ENOENT' } as any;
          throw error;
        }
        return Promise.resolve({
          isDirectory: () => true,
        } as Stats);
      });

      mocks.storage.checkFileExists.mockResolvedValue(true);

      mocks.library.get.mockResolvedValue(library);

      await sut.handleQueueSyncFiles({ id: library.id });

      expect(mocks.storage.walk).toHaveBeenCalledWith({
        pathsToCrawl: [library.importPaths[1]],
        exclusionPatterns: [],
        includeHidden: false,
        take: JOBS_LIBRARY_PAGINATION_SIZE,
      });
    });
  });

  describe('handleQueueSyncFiles', () => {
    it('should queue refresh of a new asset', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(mockWalk);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.asset.filterNewExternalAssetPaths.mockResolvedValue(['/data/user1/photo.jpg']);

      await sut.handleQueueSyncFiles({ id: library.id });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibrarySyncFiles,
        data: {
          libraryId: library.id,
          paths: ['/data/user1/photo.jpg'],
          progressCounter: 1,
        },
      });
    });

    it("should fail when library can't be found", async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      await expect(sut.handleQueueSyncFiles({ id: library.id })).resolves.toBe(JobStatus.Skipped);
    });

    it('should ignore import paths that do not exist', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      mocks.storage.stat.mockImplementation((path): Promise<Stats> => {
        if (path === library.importPaths[0]) {
          const error = { code: 'ENOENT' } as any;
          throw error;
        }
        return Promise.resolve({
          isDirectory: () => true,
        } as Stats);
      });

      mocks.storage.checkFileExists.mockResolvedValue(true);

      mocks.library.get.mockResolvedValue(library);

      await sut.handleQueueSyncFiles({ id: library.id });

      expect(mocks.storage.walk).toHaveBeenCalledWith({
        pathsToCrawl: [library.importPaths[1]],
        exclusionPatterns: [],
        includeHidden: false,
        take: JOBS_LIBRARY_PAGINATION_SIZE,
      });
    });
  });

  describe('handleQueueSyncAssets', () => {
    it('should call the offline check', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(async function* generator() {});
      mocks.asset.getLibraryAssetCount.mockResolvedValue(1);
      mocks.asset.detectOfflineExternalAssets.mockResolvedValue({ numUpdatedRows: 1n });

      const response = await sut.handleQueueSyncAssets({ id: library.id });

      expect(response).toBe(JobStatus.Success);
      expect(mocks.asset.detectOfflineExternalAssets).toHaveBeenCalledWith(
        library.id,
        library.importPaths,
        library.exclusionPatterns,
      );
    });

    it('should skip an empty library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(async function* generator() {});
      mocks.asset.getLibraryAssetCount.mockResolvedValue(0);
      mocks.asset.detectOfflineExternalAssets.mockResolvedValue({ numUpdatedRows: 1n });

      const response = await sut.handleQueueSyncAssets({ id: library.id });

      expect(response).toBe(JobStatus.Success);
      expect(mocks.asset.detectOfflineExternalAssets).not.toHaveBeenCalled();
    });

    it('should queue asset sync', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });
      const asset = AssetFactory.create({ libraryId: library.id, isExternal: true });

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(async function* generator() {});
      mocks.library.streamAssetIds.mockReturnValue(makeStream([asset]));
      mocks.asset.getLibraryAssetCount.mockResolvedValue(1);
      mocks.asset.detectOfflineExternalAssets.mockResolvedValue({ numUpdatedRows: 0n });

      const response = await sut.handleQueueSyncAssets({ id: library.id });

      expect(mocks.job.queue).toBeCalledWith({
        name: JobName.LibrarySyncAssets,
        data: {
          libraryId: library.id,
          importPaths: library.importPaths,
          exclusionPatterns: library.exclusionPatterns,
          assetIds: [asset.id],
          progressCounter: 1,
          totalAssets: 1,
        },
      });

      expect(response).toBe(JobStatus.Success);
      expect(mocks.asset.detectOfflineExternalAssets).toHaveBeenCalledWith(
        library.id,
        library.importPaths,
        library.exclusionPatterns,
      );
    });

    it("should fail if library can't be found", async () => {
      await expect(sut.handleQueueSyncAssets({ id: newUuid() })).resolves.toBe(JobStatus.Skipped);
    });
  });

  describe('handleSyncAssets', () => {
    it('should offline assets no longer on disk', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockRejectedValue(new Error('ENOENT, no such file or directory'));

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAllIfPathUnchanged).toHaveBeenCalledWith(
        [{ id: asset.id, originalPath: asset.originalPath }],
        { isOffline: true, deletedAt: expect.anything() },
      );
    });

    it('should set assets deleted from disk as offline', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/data/user2'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockRejectedValue(new Error('Could not read file'));

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAllIfPathUnchanged).toHaveBeenCalledWith(
        [{ id: asset.id, originalPath: asset.originalPath }],
        { isOffline: true, deletedAt: expect.anything() },
      );
    });

    it('should switch to an existing copy instead of offlining the asset', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true, originalPath: '/data/a.jpg' });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
      mocks.asset.getExternalCopiesByAssetIds.mockResolvedValue(new Map([[asset.id, ['/data/gone.jpg', '/data/b.jpg']]]));
      mocks.storage.checkFileExists.mockImplementation((path: string) => Promise.resolve(path === '/data/b.jpg'));

      await sut.handleSyncAssets(mockAssetJob);

      expect(mocks.asset.removeExternalCopy).toHaveBeenCalledWith(asset.id, '/data/gone.jpg');
      expect(mocks.asset.swapExternalOriginal).toHaveBeenCalledWith(asset.id, {
        from: '/data/a.jpg',
        to: '/data/b.jpg',
        keepFrom: false,
        values: { originalPath: '/data/b.jpg', originalFileName: 'b.jpg', isOffline: false, deletedAt: null },
      });
      expect(mocks.asset.updateAllIfPathUnchanged).not.toHaveBeenCalled();
    });

    it('should remove copies that no longer exist', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true, fileModifiedAt: new Date('2023-01-01') });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: new Date('2023-01-01') } as Stats);
      mocks.asset.getExternalCopiesByAssetIds.mockResolvedValue(new Map([[asset.id, ['/data/gone.jpg']]]));
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await sut.handleSyncAssets(mockAssetJob);

      expect(mocks.asset.removeExternalCopy).toHaveBeenCalledWith(asset.id, '/data/gone.jpg');
      expect(mocks.asset.swapExternalOriginal).not.toHaveBeenCalled();
    });

    it('should do nothing with offline assets deleted from disk', async () => {
      const asset = AssetFactory.create({ isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/data/user2'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockRejectedValue(new Error('Could not read file'));

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('should un-trash an asset previously marked as offline', async () => {
      const asset = AssetFactory.create({ originalPath: '/original/path.jpg', isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/original/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: newDate() } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset.id], {
        isOffline: false,
        deletedAt: null,
      });
    });

    it('should do nothing with offline asset if covered by exclusion pattern', async () => {
      const asset = AssetFactory.create({ originalPath: '/original/path.jpg', isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/original/'],
        exclusionPatterns: ['**/path.jpg'],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: newDate() } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should do nothing with offline asset if not in import path', async () => {
      const asset = AssetFactory.create({ originalPath: '/original/path.jpg', isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/import/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: newDate() } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should do nothing with unchanged online assets', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: asset.fileModifiedAt } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('should not touch fileCreatedAt when un-trashing an asset previously marked as offline', async () => {
      const asset = AssetFactory.create({ isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: newDate() } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(
        [asset.id],
        expect.not.objectContaining({
          fileCreatedAt: expect.anything(),
        }),
      );
    });

    it('should update with online assets that have changed', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      const mtime = new Date(asset.fileModifiedAt.getDate() + 1);

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.SidecarCheck,
          data: {
            id: asset.id,
            source: 'upload',
          },
        },
      ]);
    });
  });

  describe('handleSyncFiles', () => {
    beforeEach(() => {
      mocks.storage.stat.mockResolvedValue({
        size: 100,
        mtime: new Date('2023-01-01'),
        ctime: new Date('2023-01-01'),
      } as Stats);
      mocks.asset.filterNewExternalAssetPaths.mockImplementation((_, paths) => Promise.resolve(paths));
      mocks.crypto.hashFile.mockImplementation((path) => Promise.resolve(Buffer.from(`${path} (file-hashed)`)));
    });

    it('should import a new asset with a content checksum', async () => {
      const library = factory.library();
      const asset = AssetFactory.create();

      mocks.asset.createAll.mockResolvedValue([asset.id]);
      mocks.library.get.mockResolvedValue(library);

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/photo.jpg'] });

      expect(mocks.asset.createAll).toHaveBeenCalledWith([
        expect.objectContaining({
          checksum: Buffer.from('/data/user1/photo.jpg (file-hashed)'),
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
        }),
      ]);
    });

    it('should skip paths that are already in the library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.asset.filterNewExternalAssetPaths.mockResolvedValue([]);

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/photo.jpg'] });

      expect(mocks.crypto.hashFile).not.toHaveBeenCalled();
      expect(mocks.asset.createAll).not.toHaveBeenCalled();
    });

    it('should save imports in batches of 1000 files', async () => {
      const library = factory.library();
      const paths = Array.from({ length: 2500 }, (_, index) => `/data/user1/photo-${index}.jpg`);

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);

      await sut.handleSyncFiles({ libraryId: library.id, paths });

      expect(mocks.asset.createAll).toHaveBeenCalledTimes(3);
      expect(mocks.asset.createAll.mock.calls[0][0]).toHaveLength(1000);
      expect(mocks.asset.createAll.mock.calls[2][0]).toHaveLength(500);
    });

    it('should detect a moved file and keep the existing asset', async () => {
      const library = factory.library();
      const existing = AssetFactory.create({ libraryId: library.id, originalPath: '/data/user1/old/photo.jpg' });

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.asset.getByChecksum.mockResolvedValueOnce(existing as any);
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/new/photo.jpg'] });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([existing.id], {
        originalPath: '/data/user1/new/photo.jpg',
        originalFileName: 'photo.jpg',
        fileModifiedAt: new Date('2023-01-01'),
        isOffline: false,
        deletedAt: null,
      });
      expect(mocks.asset.createAll).toHaveBeenCalledWith([]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SidecarCheck, data: { id: existing.id, source: 'upload' } },
      ]);
    });

    it('should keep a user-trashed asset in the trash when its file moved', async () => {
      const library = factory.library();
      const existing = AssetFactory.create({
        libraryId: library.id,
        originalPath: '/data/user1/old/photo.jpg',
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.asset.getByChecksum.mockResolvedValueOnce(existing as any);
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/new/photo.jpg'] });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([existing.id], {
        originalPath: '/data/user1/new/photo.jpg',
        originalFileName: 'photo.jpg',
        fileModifiedAt: new Date('2023-01-01'),
        isOffline: false,
      });
    });

    it('should record an identical file as a copy of the existing asset', async () => {
      const library = factory.library();
      const existing = AssetFactory.create({ libraryId: library.id, originalPath: '/data/user1/old/photo.jpg' });

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.asset.getByChecksum.mockResolvedValueOnce(existing as any);
      mocks.storage.checkFileExists.mockResolvedValue(true);

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/copy/photo.jpg'] });

      expect(mocks.asset.addExternalCopy).toHaveBeenCalledWith(existing.id, '/data/user1/copy/photo.jpg');
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.asset.createAll).toHaveBeenCalledWith([]);
    });

    it('should record every identical file of the same batch as a copy', async () => {
      const library = factory.library();
      const existing = AssetFactory.create({ libraryId: library.id, originalPath: '/data/user1/photo.jpg' });

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.asset.getByChecksum.mockResolvedValue(existing as any);
      mocks.storage.checkFileExists.mockResolvedValue(true);

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/a.jpg', '/data/user1/b.jpg'] });

      expect(mocks.asset.addExternalCopy).toHaveBeenCalledTimes(2);
    });

    it('should remove a copy from its asset when its content changed', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.asset.getExternalCopyOwnerId.mockResolvedValue('owner-id');

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/edited.jpg'] });

      expect(mocks.asset.removeExternalCopy).toHaveBeenCalledWith('owner-id', '/data/user1/edited.jpg');
      expect(mocks.asset.createAll).toHaveBeenCalledWith([
        expect.objectContaining({ originalPath: '/data/user1/edited.jpg' }),
      ]);
    });

    it('should move a copy to another asset when its content now matches it', async () => {
      const library = factory.library();
      const existing = AssetFactory.create({ libraryId: library.id, originalPath: '/data/user1/other.jpg' });

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.asset.getExternalCopyOwnerId.mockResolvedValue('previous-owner');
      mocks.asset.getByChecksum.mockResolvedValueOnce(existing as any);
      mocks.storage.checkFileExists.mockResolvedValue(true);

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/copy.jpg'] });

      expect(mocks.asset.removeExternalCopy).toHaveBeenCalledWith('previous-owner', '/data/user1/copy.jpg');
      expect(mocks.asset.addExternalCopy).toHaveBeenCalledWith(existing.id, '/data/user1/copy.jpg');
    });

    it('should promote a copy to original when the original file is gone', async () => {
      const library = factory.library();
      const existing = AssetFactory.create({ libraryId: library.id, originalPath: '/data/user1/photo.jpg' });

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.asset.getExternalCopyOwnerId.mockResolvedValue(existing.id);
      mocks.asset.getByChecksum.mockResolvedValueOnce(existing as any);
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/copy.jpg'] });

      expect(mocks.asset.removeExternalCopy).toHaveBeenCalledWith(existing.id, '/data/user1/copy.jpg');
      expect(mocks.asset.updateAll).toHaveBeenCalledWith(
        [existing.id],
        expect.objectContaining({ originalPath: '/data/user1/copy.jpg', originalFileName: 'copy.jpg' }),
      );
    });

    it('should ignore a file whose upload is being moved into the library', async () => {
      const library = factory.library();
      // outside of the media location (/data in tests), i.e. already moved out of the Immich storage
      const upload = AssetFactory.create({ libraryId: null, originalPath: '/mnt/photos/iphone_upload/photo.jpg' });

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.asset.getByChecksum.mockResolvedValueOnce(undefined).mockResolvedValueOnce(upload as any);

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/mnt/photos/iphone_upload/photo.jpg'] });

      expect(mocks.asset.createAll).toHaveBeenCalledWith([]);
    });

    it('should import only one of two identical new files', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.asset.createAll.mockResolvedValue([]);
      mocks.crypto.hashFile.mockResolvedValue(Buffer.from('same content'));

      await sut.handleSyncFiles({ libraryId: library.id, paths: ['/data/user1/a.jpg', '/data/user1/b.jpg'] });

      expect(mocks.asset.createAll).toHaveBeenCalledWith([expect.objectContaining({ isExternal: true })]);
    });

    it('should import a new asset', async () => {
      const library = factory.library();
      const asset = AssetFactory.create();

      const mockLibraryJob: ILibraryFileJob = {
        libraryId: library.id,
        paths: ['/data/user1/photo.jpg'],
      };

      mocks.asset.createAll.mockResolvedValue([asset.id]);
      mocks.library.get.mockResolvedValue(library);

      await expect(sut.handleSyncFiles(mockLibraryJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.createAll).toHaveBeenCalledWith([
        expect.objectContaining({
          ownerId: library.ownerId,
          libraryId: library.id,
          originalPath: '/data/user1/photo.jpg',
          type: AssetType.Image,
          originalFileName: 'photo.jpg',
          isExternal: true,
        }),
      ]);

      expect(mocks.event.emit).toHaveBeenCalledWith('AssetCreate', {
        asset: { id: asset.id, ownerId: library.ownerId },
      });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.SidecarCheck,
          data: {
            id: asset.id,
            source: 'upload',
          },
        },
      ]);
    });

    it('should not import an asset to a soft deleted library', async () => {
      const library = factory.library({ deletedAt: new Date() });

      const mockLibraryJob: ILibraryFileJob = {
        libraryId: library.id,
        paths: ['/data/user1/photo.jpg'],
      };

      mocks.library.get.mockResolvedValue(library);

      await expect(sut.handleSyncFiles(mockLibraryJob)).resolves.toBe(JobStatus.Failed);

      expect(mocks.asset.createAll.mock.calls).toEqual([]);
    });
  });

  describe('handleAssetRemoval', () => {
    it('should switch to an existing copy when the original file is deleted', async () => {
      const asset = AssetFactory.create({ originalPath: '/data/a.jpg', checksumAlgorithm: ChecksumAlgorithm.sha1File });

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset as any);
      mocks.asset.getExternalCopies.mockResolvedValue(['/data/b.jpg']);
      mocks.storage.checkFileExists.mockResolvedValue(true);

      await sut.handleAssetRemoval({ libraryId: 'library-id', paths: ['/data/a.jpg'] });

      expect(mocks.asset.swapExternalOriginal).toHaveBeenCalledWith(
        asset.id,
        expect.objectContaining({ from: '/data/a.jpg', to: '/data/b.jpg', keepFrom: false }),
      );
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('should offline the asset when it has no copy left', async () => {
      const asset = AssetFactory.create({ originalPath: '/data/a.jpg', checksumAlgorithm: ChecksumAlgorithm.sha1File });

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset as any);

      await sut.handleAssetRemoval({ libraryId: 'library-id', paths: ['/data/a.jpg'] });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset.id], { isOffline: true, deletedAt: expect.any(Date) });
    });

    it('should remove a deleted copy from its asset', async () => {
      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(undefined);
      mocks.asset.getExternalCopyOwnerId.mockResolvedValue('owner-id');

      await sut.handleAssetRemoval({ libraryId: 'library-id', paths: ['/data/copy.jpg'] });

      expect(mocks.asset.removeExternalCopy).toHaveBeenCalledWith('owner-id', '/data/copy.jpg');
    });
  });

  describe('setExternalOriginal', () => {
    it('should swap the original file with a copy', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', originalPath: '/data/a.jpg' });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(asset as any);
      mocks.asset.getExternalCopies.mockResolvedValue(['/data/b.jpg']);
      mocks.storage.checkFileExists.mockResolvedValue(true);

      await sut.setExternalOriginal(authStub.admin, asset.id, { path: '/data/b.jpg' });

      expect(mocks.asset.swapExternalOriginal).toHaveBeenCalledWith(asset.id, {
        from: '/data/a.jpg',
        to: '/data/b.jpg',
        keepFrom: true,
        values: { originalPath: '/data/b.jpg', originalFileName: 'b.jpg', isOffline: false, deletedAt: null },
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SidecarCheck, data: { id: asset.id, source: 'upload' } },
      ]);
    });

    it('should refuse a path that is not a known copy', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id' });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(asset as any);
      mocks.asset.getExternalCopies.mockResolvedValue(['/data/b.jpg']);

      await expect(sut.setExternalOriginal(authStub.admin, asset.id, { path: '/etc/passwd' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.asset.swapExternalOriginal).not.toHaveBeenCalled();
    });

    it('should drop a copy that no longer exists', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id' });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(asset as any);
      mocks.asset.getExternalCopies.mockResolvedValue(['/data/b.jpg']);
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await expect(sut.setExternalOriginal(authStub.admin, asset.id, { path: '/data/b.jpg' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.asset.removeExternalCopy).toHaveBeenCalledWith(asset.id, '/data/b.jpg');
    });

    it('should require access to the asset', async () => {
      await expect(sut.setExternalOriginal(authStub.admin, 'asset-id', { path: '/data/b.jpg' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.asset.getById).not.toHaveBeenCalled();
    });
  });

  describe('deleteExternalCopies', () => {
    const checksum = Buffer.from('photo content');
    const setup = () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', originalPath: '/data/a.jpg', checksum });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(asset as any);
      mocks.asset.getExternalCopies.mockResolvedValue(['/data/b.jpg']);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.crypto.hashFile.mockResolvedValue(checksum);
      return asset;
    };

    it('should delete an identical copy and keep the original', async () => {
      const asset = setup();

      await expect(
        sut.deleteExternalCopies(authStub.admin, { items: [{ assetId: asset.id, path: '/data/b.jpg' }] }),
      ).resolves.toEqual({ deleted: 1, failed: [] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('/data/b.jpg');
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith('/data/a.jpg');
      expect(mocks.asset.removeExternalCopy).toHaveBeenCalledWith(asset.id, '/data/b.jpg');
    });

    it('should never delete the original file', async () => {
      const asset = setup();

      const result = await sut.deleteExternalCopies(authStub.admin, { items: [{ assetId: asset.id, path: '/data/a.jpg' }] });

      expect(result.deleted).toBe(0);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should keep the copy when the original is missing', async () => {
      const asset = setup();
      mocks.storage.checkFileExists.mockImplementation((path: string) => Promise.resolve(path !== '/data/a.jpg'));

      const result = await sut.deleteExternalCopies(authStub.admin, { items: [{ assetId: asset.id, path: '/data/b.jpg' }] });

      expect(result).toEqual({ deleted: 0, failed: [{ path: '/data/b.jpg', reason: expect.any(String) }] });
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should keep the copy when the original content changed', async () => {
      const asset = setup();
      mocks.crypto.hashFile.mockImplementation((path) =>
        Promise.resolve(path === '/data/a.jpg' ? Buffer.from('edited') : checksum),
      );

      const result = await sut.deleteExternalCopies(authStub.admin, { items: [{ assetId: asset.id, path: '/data/b.jpg' }] });

      expect(result.deleted).toBe(0);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should keep the copy when its own content changed', async () => {
      const asset = setup();
      mocks.crypto.hashFile.mockImplementation((path) =>
        Promise.resolve(path === '/data/b.jpg' ? Buffer.from('edited') : checksum),
      );

      const result = await sut.deleteExternalCopies(authStub.admin, { items: [{ assetId: asset.id, path: '/data/b.jpg' }] });

      expect(result.deleted).toBe(0);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should refuse a path that is not a known copy', async () => {
      const asset = setup();

      const result = await sut.deleteExternalCopies(authStub.admin, { items: [{ assetId: asset.id, path: '/etc/passwd' }] });

      expect(result.deleted).toBe(0);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should require access to every asset', async () => {
      await expect(
        sut.deleteExternalCopies(authStub.admin, { items: [{ assetId: 'asset-id', path: '/data/b.jpg' }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete a library', async () => {
      const library = factory.library();

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
      mocks.library.get.mockResolvedValue(library);

      await sut.delete(library.id);

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryDelete, data: { id: library.id } });
      expect(mocks.library.softDelete).toHaveBeenCalledWith(library.id);
    });

    it('should allow an external library to be deleted', async () => {
      const library = factory.library();

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
      mocks.library.get.mockResolvedValue(library);

      await sut.delete(library.id);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibraryDelete,
        data: { id: library.id },
      });

      expect(mocks.library.softDelete).toHaveBeenCalledWith(library.id);
    });

    it('should unwatch an external library when deleted', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
      mocks.library.get.mockResolvedValue(library);
      mocks.library.getAll.mockResolvedValue([library]);

      const mockClose = vitest.fn();
      mocks.storage.watch.mockImplementation(makeMockWatcher({ close: mockClose }));
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      await sut.delete(library.id);

      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should return a library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);

      await expect(sut.get(library.id)).resolves.toEqual(
        expect.objectContaining({
          id: library.id,
          name: library.name,
          ownerId: library.ownerId,
        }),
      );

      expect(mocks.library.get).toHaveBeenCalledWith(library.id);
    });

    it('should throw an error when a library is not found', async () => {
      const library = factory.library();

      await expect(sut.get(library.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.library.get).toHaveBeenCalledWith(library.id);
    });
  });

  describe('getStatistics', () => {
    it('should return library statistics', async () => {
      const library = factory.library();

      mocks.library.getStatistics.mockResolvedValue({ photos: 10, videos: 0, total: 10, usage: 1337 });
      await expect(sut.getStatistics(library.id)).resolves.toEqual({
        photos: 10,
        videos: 0,
        total: 10,
        usage: 1337,
      });

      expect(mocks.library.getStatistics).toHaveBeenCalledWith(library.id);
    });
  });

  describe('create', () => {
    describe('external library', () => {
      it('should create with default settings', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);
        await expect(sut.create({ ownerId: authStub.admin.user.id })).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: [],
            exclusionPatterns: expect.any(Array),
          }),
        );
      });

      it('should create with name', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);

        await expect(sut.create({ ownerId: authStub.admin.user.id, name: 'My Awesome Library' })).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'My Awesome Library',
            importPaths: [],
            exclusionPatterns: expect.any(Array),
          }),
        );
      });

      it('should create with import paths', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);
        await expect(
          sut.create({
            ownerId: authStub.admin.user.id,
            importPaths: ['/data/images', '/data/videos'],
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: ['/data/images', '/data/videos'],
            exclusionPatterns: expect.any(Array),
          }),
        );
      });

      it('should create watched with import paths', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.create.mockResolvedValue(library);
        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([]);
        mocks.cron.create.mockResolvedValue();

        await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
        await sut.create({ ownerId: authStub.admin.user.id, importPaths: library.importPaths });
      });

      it('should create with exclusion patterns', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);
        await expect(
          sut.create({
            ownerId: authStub.admin.user.id,
            exclusionPatterns: ['*.tmp', '*.bak'],
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: [],
            exclusionPatterns: ['*.tmp', '*.bak'],
          }),
        );
      });
    });
  });

  describe('getAll', () => {
    it('should get all libraries', async () => {
      const library = factory.library();

      mocks.library.getAll.mockResolvedValue([library]);

      await expect(sut.getAll()).resolves.toEqual([expect.objectContaining({ id: library.id })]);
    });
  });

  describe('handleQueueCleanup', () => {
    it('should queue cleanup jobs', async () => {
      const library1 = factory.library({ deletedAt: new Date() });
      const library2 = factory.library({ deletedAt: new Date() });

      mocks.library.getAllDeleted.mockResolvedValue([library1, library2]);
      await expect(sut.handleQueueCleanup()).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.LibraryDelete, data: { id: library1.id } },
        { name: JobName.LibraryDelete, data: { id: library2.id } },
      ]);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
    });

    it('should throw an error if an import path is invalid', async () => {
      const library = factory.library();

      mocks.library.update.mockResolvedValue(library);
      mocks.library.get.mockResolvedValue(library);

      await expect(sut.update('library-id', { importPaths: ['foo/bar'] })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.library.update).not.toHaveBeenCalled();
    });

    it('should update library', async () => {
      const library = factory.library();

      mocks.library.update.mockResolvedValue(library);
      mocks.library.get.mockResolvedValue(library);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);

      const cwd = process.cwd();

      await expect(sut.update('library-id', { importPaths: [`${cwd}/foo/bar`] })).resolves.toEqual(mapLibrary(library));
      expect(mocks.library.update).toHaveBeenCalledWith(
        'library-id',
        expect.objectContaining({ importPaths: [`${cwd}/foo/bar`] }),
      );
    });
  });

  describe('onShutdown', () => {
    it('should do nothing if instance does not have the watch lock', async () => {
      await sut.onShutdown();
    });
  });

  describe('watchAll', () => {
    it('should return false if instance does not have the watch lock', async () => {
      await expect(sut.watchAll()).resolves.toBe(false);
    });

    describe('watching disabled', () => {
      beforeEach(async () => {
        mocks.cron.create.mockResolvedValue();

        await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchDisabled as SystemConfig });
      });

      it('should not watch library', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).not.toHaveBeenCalled();
      });
    });

    describe('watching enabled', () => {
      beforeEach(async () => {
        mocks.library.getAll.mockResolvedValue([]);
        mocks.cron.create.mockResolvedValue();

        await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      });

      it('should watch library', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).toHaveBeenCalledWith(library.importPaths, expect.anything(), expect.anything());
      });

      it('should watch and unwatch library', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.getAll.mockResolvedValue([library]);
        mocks.library.get.mockResolvedValue(library);
        const mockClose = vitest.fn();
        mocks.storage.watch.mockImplementation(makeMockWatcher({ close: mockClose }));

        await sut.watchAll();
        await sut.unwatch(library.id);

        expect(mockClose).toHaveBeenCalled();
      });

      it('should not watch library without import paths', async () => {
        const library = factory.library();

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).not.toHaveBeenCalled();
      });

      it('should handle a new file event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
        mocks.storage.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/foo/photo.jpg' }] }));

        await sut.watchAll();

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.LibrarySyncFiles,
          data: {
            libraryId: library.id,
            paths: ['/foo/photo.jpg'],
          },
        });
      });

      it('should handle a file change event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'change', value: '/foo/photo.jpg' }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.LibrarySyncFiles,
          data: {
            libraryId: library.id,
            paths: ['/foo/photo.jpg'],
          },
        });
      });

      it('should handle a file unlink event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });
        const asset = AssetFactory.create();

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'unlink', value: asset.originalPath }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.LibraryRemoveAsset,
          data: {
            libraryId: library.id,
            paths: [asset.originalPath],
          },
        });
      });

      it('should handle an error event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });
        const asset = AssetFactory.create({ libraryId: library.id, isExternal: true });

        mocks.library.get.mockResolvedValue(library);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({
            items: [{ event: 'error', value: 'Error!' }],
          }),
        );

        await expect(sut.watchAll()).resolves.toBeUndefined();
      });

      it('should not import a file with unknown extension', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/foo/photo.xyz' }] }));

        await sut.watchAll();

        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('should ignore excluded paths', async () => {
        const library = factory.library({ importPaths: ['/xyz', '/asdf'], exclusionPatterns: ['**/dir1/**'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'add', value: '/dir1/photo.txt' }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('should ignore excluded paths without case sensitivity', async () => {
        const library = factory.library({
          importPaths: ['/xyz', '/asdf'],
          exclusionPatterns: ['**/dir1/**'],
        });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'add', value: '/DIR1/photo.txt' }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).not.toHaveBeenCalled();
      });
    });
  });

  describe('teardown', () => {
    it('should tear down all watchers', async () => {
      const library1 = factory.library({ importPaths: ['/foo', '/bar'] });
      const library2 = factory.library({ importPaths: ['/xyz', '/asdf'] });

      mocks.library.getAll.mockResolvedValue([library1, library2]);
      mocks.library.get.mockImplementation((id) =>
        Promise.resolve([library1, library2].find((library) => library.id === id)),
      );

      const mockClose = vitest.fn();
      mocks.storage.watch.mockImplementation(makeMockWatcher({ close: mockClose }));
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      await sut.onShutdown();

      expect(mockClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleDeleteLibrary', () => {
    it('should delete an empty library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.library.streamAssetIds.mockReturnValue(makeStream([]));

      await expect(sut.handleDeleteLibrary({ id: library.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.library.delete).toHaveBeenCalled();
    });

    it('should delete all assets in a library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.library.streamAssetIds.mockReturnValue(makeStream([AssetFactory.create()]));

      await expect(sut.handleDeleteLibrary({ id: library.id })).resolves.toBe(JobStatus.Success);
    });
  });

  describe('queueScan', () => {
    it('should queue a library scan', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);

      await sut.queueScan(library.id);

      expect(mocks.job.queue).toHaveBeenCalledTimes(2);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibrarySyncFilesQueueAll,
        data: { id: library.id },
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibrarySyncAssetsQueueAll,
        data: { id: library.id },
      });
    });
  });

  describe('handleQueueAllScan', () => {
    it('should queue the refresh job', async () => {
      const library = factory.library();

      mocks.library.getAll.mockResolvedValue([library]);

      await expect(sut.handleQueueScanAll()).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibraryDeleteCheck,
        data: {},
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.LibrarySyncFilesQueueAll, data: { id: library.id } },
      ]);
    });
  });

  describe('validate', () => {
    it('should not require import paths', async () => {
      await expect(sut.validate('library-id', {})).resolves.toEqual({ importPaths: [] });
    });

    it('should validate directory', async () => {
      mocks.storage.stat.mockResolvedValue({
        isDirectory: () => true,
      } as Stats);

      mocks.storage.checkFileExists.mockResolvedValue(true);

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: true,
            message: undefined,
          },
        ],
      });
    });

    it('should detect when path does not exist', async () => {
      mocks.storage.stat.mockImplementation(() => {
        const error = { code: 'ENOENT' } as any;
        throw error;
      });

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: false,
            message: 'Path does not exist (ENOENT)',
          },
        ],
      });
    });

    it('should detect when path is not a directory', async () => {
      mocks.storage.stat.mockResolvedValue({
        isDirectory: () => false,
      } as Stats);

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/file'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/file',
            isValid: false,
            message: 'Not a directory',
          },
        ],
      });
    });

    it('should return an unknown exception from stat', async () => {
      mocks.storage.stat.mockImplementation(() => {
        throw new Error('Unknown error');
      });

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: false,
            message: 'Error: Unknown error',
          },
        ],
      });
    });

    it('should detect when access rights are missing', async () => {
      mocks.storage.stat.mockResolvedValue({
        isDirectory: () => true,
      } as Stats);

      mocks.storage.checkFileExists.mockResolvedValue(false);

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: false,
            message: 'Lacking read permission for folder',
          },
        ],
      });
    });

    it('should detect when import path is not absolute', async () => {
      const cwd = process.cwd();

      await expect(sut.validate('library-id', { importPaths: ['relative/path'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: 'relative/path',
            isValid: false,
            message: `Import path must be absolute, try ${cwd}/relative/path`,
          },
        ],
      });
    });

    it('should detect when import path is in immich media folder', async () => {
      const importPaths = ['/data/thumbs', `${process.cwd()}/xyz`, '/data/library'];
      const library = factory.library({ importPaths });

      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);

      mocks.storage.checkFileExists.mockImplementation((importPath) => Promise.resolve(importPath === importPaths[1]));

      await expect(sut.validate(library.id, { importPaths })).resolves.toEqual({
        importPaths: [
          {
            importPath: importPaths[0],
            isValid: false,
            message: 'Cannot use media upload folder for external libraries',
          },
          {
            importPath: importPaths[1],
            isValid: true,
          },
          {
            importPath: importPaths[2],
            isValid: false,
            message: 'Cannot use media upload folder for external libraries',
          },
        ],
      });
    });
  });
});
