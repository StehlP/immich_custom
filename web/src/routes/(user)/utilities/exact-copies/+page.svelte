<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    deleteCopies,
    getAssetsWithCopies,
    setCopyAsOriginal,
    type AssetWithCopies,
    type CopyToDelete,
  } from '$lib/utils/asset-copies';
  import { handleError } from '$lib/utils/handle-error';
  import { getParentPath } from '$lib/utils/tree-utils';
  import { AssetMediaSize } from '@immich/sdk';
  import { Button, IconButton, LoadingSpinner, Text } from '@immich/ui';
  import { mdiSwapVertical, mdiTrashCanOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let assets = $state<AssetWithCopies[]>([]);
  let isLoading = $state(true);
  let isBusy = $state(false);
  let selected = $state(new Set<string>());

  const keyOf = (assetId: string, path: string) => `${assetId}\n${path}`;
  const allCopies = $derived(assets.flatMap(({ id, copies }) => copies.map((path) => ({ assetId: id, path }))));
  const isAllSelected = $derived(allCopies.length > 0 && selected.size === allCopies.length);

  const load = async () => {
    try {
      assets = await getAssetsWithCopies();
    } catch (error) {
      handleError(error, 'Impossible de charger les copies exactes');
    } finally {
      isLoading = false;
    }
    const existing = new Set(allCopies.map(({ assetId, path }) => keyOf(assetId, path)));
    selected = new Set([...selected].filter((key) => existing.has(key)));
  };

  onMount(() => {
    void load();
  });

  const toggle = (assetId: string, path: string) => {
    const key = keyOf(assetId, path);
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    selected = next;
  };

  const toggleAll = () => {
    selected = isAllSelected ? new Set() : new Set(allCopies.map(({ assetId, path }) => keyOf(assetId, path)));
  };

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
    remove(allCopies.filter(({ assetId, path }) => selected.has(keyOf(assetId, path))));

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
  {:else if assets.length === 0}
    <p class="flex place-content-center place-items-center p-8 text-center text-lg dark:text-white">
      Aucune copie exacte
    </p>
  {:else}
    <div class="mb-4 flex flex-wrap items-center gap-4">
      <Text color="muted">
        {assets.length} photo{assets.length > 1 ? 's' : ''} · {allCopies.length} cop{allCopies.length > 1 ? 'ies' : 'ie'}
      </Text>
      <label class="flex cursor-pointer items-center gap-2 text-sm dark:text-white">
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

    <ul class="flex flex-col gap-2">
      {#each assets as asset (asset.id)}
        <li class="flex gap-4 rounded-2xl border border-gray-300 p-3 dark:border-immich-dark-gray dark:text-white">
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is supposed to be treated as an absolute/external link -->
          <a href={Route.viewAsset({ id: asset.id })} class="shrink-0" title="Ouvrir la photo">
            <img
              src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail })}
              alt={asset.originalFileName}
              class="size-24 rounded-lg object-cover"
              loading="lazy"
            />
          </a>

          <div class="min-w-0 grow text-sm">
            <p class="font-medium break-all">{asset.originalFileName}</p>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is supposed to be treated as an absolute/external link -->
            <a
              href={Route.folders({ path: getParentPath(asset.originalPath) })}
              title="Aller au dossier"
              class="text-xs break-all opacity-70 hover:text-primary"
            >
              Original : {asset.originalPath}
            </a>

            <ul class="mt-1">
              {#each asset.copies as path (path)}
                <li class="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="size-4 shrink-0 accent-primary"
                    aria-label="Sélectionner {path}"
                    checked={selected.has(keyOf(asset.id, path))}
                    onchange={() => toggle(asset.id, path)}
                  />
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is supposed to be treated as an absolute/external link -->
                  <a
                    href={Route.folders({ path: getParentPath(path) })}
                    title="Aller au dossier"
                    class="min-w-0 grow break-all opacity-50 hover:text-primary"
                  >
                    {path}
                  </a>
                  <span class="shrink-0" title="Définir comme original">
                    <IconButton
                      icon={mdiSwapVertical}
                      aria-label="Définir comme original"
                      size="small"
                      shape="round"
                      color="secondary"
                      variant="ghost"
                      disabled={isBusy}
                      onclick={() => setAsOriginal(asset.id, path)}
                    />
                  </span>
                  <span class="shrink-0" title="Supprimer cette copie">
                    <IconButton
                      icon={mdiTrashCanOutline}
                      aria-label="Supprimer cette copie"
                      size="small"
                      shape="round"
                      color="secondary"
                      variant="ghost"
                      disabled={isBusy}
                      onclick={() => remove([{ assetId: asset.id, path }])}
                    />
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</UserPageLayout>
