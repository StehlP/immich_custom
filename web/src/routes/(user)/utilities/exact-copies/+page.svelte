<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    deleteCopies,
    getAssetsWithCopies,
    setCopiesAsOriginal,
    setCopyAsOriginal,
    type AssetWithCopies,
    type CopyToDelete,
  } from '$lib/utils/asset-copies';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetMediaSize } from '@immich/sdk';
  import { Button, IconButton, LoadingSpinner, Text } from '@immich/ui';
  import { mdiArrowLeftBold, mdiSwapVertical, mdiTrashCanOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  type CopyItem = {
    assetId: string;
    path: string;
    originalPath: string;
    originalFileName: string;
    takenAt: number;
    key: string;
  };
  type CopyGroup = { key: string; copyDir: string; originalDir: string; latest: number; items: CopyItem[] };

  let assets = $state<AssetWithCopies[]>([]);
  let isLoading = $state(true);
  let isBusy = $state(false);
  let selected = $state(new Set<string>());

  const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/';
  const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const keyOf = (assetId: string, path: string) => `${assetId}\n${path}`;

  const items = $derived<CopyItem[]>(
    assets.flatMap((asset) =>
      asset.copies.map((path) => ({
        assetId: asset.id,
        path,
        originalPath: asset.originalPath,
        originalFileName: asset.originalFileName,
        takenAt: new Date(asset.fileCreatedAt).getTime() || 0,
        key: keyOf(asset.id, path),
      })),
    ),
  );

  // one group per (folder of the copies, folder of their originals), most recent photos first
  const groups = $derived.by<CopyGroup[]>(() => {
    const byKey = new Map<string, CopyGroup>();
    for (const item of items) {
      const copyDir = dirOf(item.path);
      const originalDir = dirOf(item.originalPath);
      const key = `${copyDir}\n${originalDir}`;
      let group = byKey.get(key);
      if (!group) {
        group = { key, copyDir, originalDir, latest: 0, items: [] };
        byKey.set(key, group);
      }
      group.items.push(item);
      group.latest = Math.max(group.latest, item.takenAt);
    }
    const sorted = [...byKey.values()];
    for (const group of sorted) {
      group.items.sort((a, b) => b.takenAt - a.takenAt || a.path.localeCompare(b.path));
    }
    return sorted.sort((a, b) => b.latest - a.latest || a.copyDir.localeCompare(b.copyDir));
  });

  const isAllSelected = $derived(items.length > 0 && selected.size === items.length);
  const isGroupSelected = (group: CopyGroup) => group.items.every(({ key }) => selected.has(key));

  const load = async () => {
    try {
      assets = await getAssetsWithCopies();
    } catch (error) {
      handleError(error, 'Impossible de charger les copies exactes');
    } finally {
      isLoading = false;
    }
    const existing = new Set(items.map(({ key }) => key));
    selected = new Set([...selected].filter((key) => existing.has(key)));
  };

  onMount(() => {
    void load();
  });

  const setSelection = (keys: string[], isSelected: boolean) => {
    const next = new Set(selected);
    for (const key of keys) {
      if (isSelected) {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    selected = next;
  };

  const toggle = (key: string) => setSelection([key], !selected.has(key));
  const toggleGroup = (group: CopyGroup) =>
    setSelection(
      group.items.map(({ key }) => key),
      !isGroupSelected(group),
    );
  const toggleAll = () => (selected = isAllSelected ? new Set() : new Set(items.map(({ key }) => key)));

  const remove = async (copies: CopyToDelete[]) => {
    isBusy = true;
    try {
      const deleted = await deleteCopies(copies);
      if (deleted.length > 0) {
        await load();
      }
    } finally {
      isBusy = false;
    }
  };

  const removeSelected = () =>
    remove(items.filter(({ key }) => selected.has(key)).map(({ assetId, path }) => ({ assetId, path })));

  const setGroupAsOriginal = async (group: CopyGroup) => {
    isBusy = true;
    try {
      const copies = group.items.map(({ assetId, path }) => ({ assetId, path }));
      if ((await setCopiesAsOriginal(copies, group.copyDir)) > 0) {
        await load();
      }
    } finally {
      isBusy = false;
    }
  };

  const setAsOriginal = async (assetId: string, path: string) => {
    isBusy = true;
    try {
      if (await setCopyAsOriginal(assetId, path)) {
        await load();
      }
    } finally {
      isBusy = false;
    }
  };
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  {#if isLoading}
    <div class="flex justify-center p-8"><LoadingSpinner /></div>
  {:else if items.length === 0}
    <p class="flex place-content-center place-items-center p-8 text-center text-lg dark:text-white">
      Aucune copie exacte
    </p>
  {:else}
    <div
      class="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-4 bg-light py-2 dark:bg-immich-dark-bg dark:text-white"
    >
      <Text color="muted">
        {items.length} cop{items.length > 1 ? 'ies' : 'ie'} · {assets.length} photo{assets.length > 1 ? 's' : ''} ·
        {groups.length} groupe{groups.length > 1 ? 's' : ''} de dossiers
      </Text>
      <label class="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" class="size-4 accent-primary" checked={isAllSelected} onchange={toggleAll} />
        Tout sélectionner
      </label>
      <Button
        size="small"
        color="danger"
        leadingIcon={mdiTrashCanOutline}
        disabled={selected.size === 0 || isBusy}
        onclick={removeSelected}
      >
        Supprimer la sélection ({selected.size})
      </Button>
    </div>

    <div class="flex flex-col gap-6 pb-8">
      {#each groups as group (group.key)}
        <section class="rounded-2xl border border-gray-300 p-4 dark:border-immich-dark-gray dark:text-white">
          <header class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <label class="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                class="size-4 accent-primary"
                aria-label="Sélectionner tout le groupe"
                checked={isGroupSelected(group)}
                onchange={() => toggleGroup(group)}
              />
              <span class="font-medium">
                {group.items.length} cop{group.items.length > 1 ? 'ies' : 'ie'}
              </span>
            </label>
            {#if group.latest > 0}
              <span class="text-xs opacity-60" title="Date de la photo la plus récente du groupe">
                {new Date(group.latest).toLocaleDateString()}
              </span>
            {/if}
            <div class="flex min-w-0 grow flex-wrap items-center gap-2 text-sm">
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is supposed to be treated as an absolute/external link -->
              <a
                href={Route.folders({ path: group.copyDir })}
                class="min-w-0 rounded-lg bg-gray-100 px-2 py-0.5 break-all hover:text-primary dark:bg-immich-dark-gray"
                title="Dossier des copies"
              >
                {group.copyDir}
              </a>
              <span title="Définir ce dossier comme original pour tout le groupe">
                <IconButton
                  icon={mdiSwapVertical}
                  aria-label="Définir ce dossier comme original pour tout le groupe"
                  size="small"
                  shape="round"
                  color="secondary"
                  variant="ghost"
                  disabled={isBusy}
                  onclick={() => setGroupAsOriginal(group)}
                />
              </span>
              <span title="Supprimer toutes les copies de ce groupe">
                <IconButton
                  icon={mdiTrashCanOutline}
                  aria-label="Supprimer toutes les copies de ce groupe"
                  size="small"
                  shape="round"
                  color="secondary"
                  variant="ghost"
                  disabled={isBusy}
                  onclick={() => remove(group.items.map(({ assetId, path }) => ({ assetId, path })))}
                />
              </span>
              <span class="flex items-center gap-1 opacity-60">
                <svg viewBox="0 0 24 24" class="size-4 fill-current" aria-hidden="true"><path d={mdiArrowLeftBold} /></svg>
                copies des originaux de
              </span>
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is supposed to be treated as an absolute/external link -->
              <a
                href={Route.folders({ path: group.originalDir })}
                class="min-w-0 rounded-lg bg-gray-100 px-2 py-0.5 break-all hover:text-primary dark:bg-immich-dark-gray"
                title="Dossier des originaux"
              >
                {group.originalDir}
              </a>
              <span
                class="rounded-full border border-primary px-2 py-0.5 text-xs text-primary"
                title="Les photos de ce groupe utilisent actuellement ce dossier comme original"
              >
                original actuel
              </span>
            </div>
          </header>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {#each group.items as item (item.key)}
              <div
                class="flex gap-3 rounded-xl border p-2 text-xs transition-colors {selected.has(item.key)
                  ? 'border-primary bg-primary/10'
                  : 'border-gray-200 dark:border-immich-dark-gray'}"
              >
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is supposed to be treated as an absolute/external link -->
                <a href={Route.viewAsset({ id: item.assetId })} class="shrink-0" title="Ouvrir la photo">
                  <img
                    src={getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail })}
                    alt={item.originalFileName}
                    class="size-16 rounded-lg object-cover"
                    loading="lazy"
                  />
                </a>

                <div class="flex min-w-0 grow flex-col justify-between">
                  <label class="flex min-w-0 cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      class="mt-0.5 size-4 shrink-0 accent-primary"
                      checked={selected.has(item.key)}
                      onchange={() => toggle(item.key)}
                    />
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-medium" title={item.path}>{nameOf(item.path)}</span>
                      <span class="block truncate opacity-60" title={item.originalPath}>
                        original : {nameOf(item.originalPath)}
                      </span>
                    </span>
                  </label>

                  <div class="flex justify-end">
                    <span title="Définir comme original">
                      <IconButton
                        icon={mdiSwapVertical}
                        aria-label="Définir comme original"
                        size="small"
                        shape="round"
                        color="secondary"
                        variant="ghost"
                        disabled={isBusy}
                        onclick={() => setAsOriginal(item.assetId, item.path)}
                      />
                    </span>
                    <span title="Supprimer cette copie">
                      <IconButton
                        icon={mdiTrashCanOutline}
                        aria-label="Supprimer cette copie"
                        size="small"
                        shape="round"
                        color="secondary"
                        variant="ghost"
                        disabled={isBusy}
                        onclick={() => remove([{ assetId: item.assetId, path: item.path }])}
                      />
                    </span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</UserPageLayout>
