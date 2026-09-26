<script lang="ts">
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { getParentPath } from '$lib/utils/tree-utils';
  import { getAssetMetadata, type AssetResponseDto } from '@immich/sdk';
  import { IconButton, toastManager } from '@immich/ui';
  import { mdiSwapVertical } from '@mdi/js';

  interface Props {
    asset: AssetResponseDto;
    onChanged: () => Promise<void>;
  }

  let { asset, onChanged }: Props = $props();

  // same key as EXTERNAL_COPIES_KEY on the server
  const COPIES_KEY = 'custom.copies';

  let copies = $state<string[]>([]);
  let pendingPath = $state<string | null>(null);

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
    pendingPath = path;
    try {
      const response = await fetch(`/api/assets/${asset.id}/copies/original`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ path }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `HTTP ${response.status}`);
      }
      await onChanged();
      toastManager.primary('Original modifié');
    } catch (error) {
      handleError(error, "Impossible de définir cette copie comme original");
    } finally {
      pendingPath = null;
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
              disabled={pendingPath !== null}
              onclick={() => setAsOriginal(path)}
            />
          </span>
        </li>
      {/each}
    </ul>
  </div>
{/if}
