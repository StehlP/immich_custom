<script lang="ts">
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetMetadata, type AssetResponseDto } from '@immich/sdk';
  import { Button, toastManager } from '@immich/ui';

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
  <div class="pt-1 pb-2 text-xs">
    <p class="opacity-70">Copies identiques ({copies.length})</p>
    <ul>
      {#each copies as path (path)}
        <li class="flex items-center gap-2 py-1">
          <span class="grow break-all whitespace-pre-wrap opacity-50">{path}</span>
          <Button
            size="small"
            variant="outline"
            color="secondary"
            class="shrink-0"
            disabled={pendingPath !== null}
            loading={pendingPath === path}
            onclick={() => setAsOriginal(path)}
          >
            Définir comme original
          </Button>
        </li>
      {/each}
    </ul>
  </div>
{/if}
