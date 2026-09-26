<script lang="ts">
  import { Route } from '$lib/route';
  import { deleteCopies, setCopyAsOriginal } from '$lib/utils/asset-copies';
  import { getParentPath } from '$lib/utils/tree-utils';
  import { getAssetMetadata, type AssetResponseDto } from '@immich/sdk';
  import { IconButton } from '@immich/ui';
  import { mdiSwapVertical, mdiTrashCanOutline } from '@mdi/js';

  interface Props {
    asset: AssetResponseDto;
    onChanged: () => Promise<void>;
  }

  let { asset, onChanged }: Props = $props();

  // same key as EXTERNAL_COPIES_KEY on the server
  const COPIES_KEY = 'custom.copies';

  let copies = $state<string[]>([]);
  let isBusy = $state(false);

  const loadCopies = async (id: string) => {
    try {
      const items = await getAssetMetadata({ id });
      const paths = (items.find((item) => item.key === COPIES_KEY)?.value as { paths?: unknown } | undefined)?.paths;
      copies = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string').sort() : [];
    } catch {
      copies = [];
    }
  };

  $effect(() => {
    // reload when another asset is shown or when the original file changed
    const { id, originalPath } = asset;
    void originalPath;
    void loadCopies(id);
  });

  const setAsOriginal = async (path: string) => {
    isBusy = true;
    try {
      if (await setCopyAsOriginal(asset.id, path)) {
        await onChanged();
      }
    } finally {
      isBusy = false;
    }
  };

  const remove = async (path: string) => {
    isBusy = true;
    try {
      const deleted = await deleteCopies([{ assetId: asset.id, path }]);
      if (deleted.length > 0) {
        await loadCopies(asset.id);
      }
    } finally {
      isBusy = false;
    }
  };
</script>

{#if copies.length > 0}
  <div class="pb-2 text-xs">
    <p class="pt-1 opacity-70">
      {copies.length === 1 ? '1 copie identique' : `${copies.length} copies identiques`}
    </p>
    <ul>
      {#each copies as path (path)}
        <li class="flex items-center gap-1">
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is supposed to be treated as an absolute/external link -->
          <a
            href={Route.folders({ path: getParentPath(path) })}
            title="Aller au dossier"
            class="min-w-0 grow break-all whitespace-pre-wrap opacity-50 hover:text-primary"
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
              onclick={() => setAsOriginal(path)}
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
              onclick={() => remove(path)}
            />
          </span>
        </li>
      {/each}
    </ul>
  </div>
{/if}
