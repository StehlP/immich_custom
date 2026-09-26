import { handleError } from '$lib/utils/handle-error';
import { modalManager, toastManager } from '@immich/ui';

// custom routes of this fork, not part of the generated SDK

export type AssetWithCopies = {
  id: string;
  originalPath: string;
  originalFileName: string;
  /** capture date, ISO string */
  fileCreatedAt: string;
  copies: string[];
};

export type CopyToDelete = { assetId: string; path: string };

type DeleteResult = { deleted: number; failed: Array<{ path: string; reason: string }> };

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `HTTP ${response.status}`);
  }

  return (response.status === 204 ? undefined : await response.json()) as T;
};

export const getAssetsWithCopies = () => request<AssetWithCopies[]>('/api/asset-copies');

const putOriginal = (assetId: string, path: string) =>
  request<void>(`/api/assets/${assetId}/copies/original`, {
    method: 'PUT',
    body: JSON.stringify({ path }),
  });

export const setCopyAsOriginal = async (assetId: string, path: string) => {
  try {
    await putOriginal(assetId, path);
    toastManager.primary('Original modifié');
    return true;
  } catch (error) {
    handleError(error, 'Impossible de définir cette copie comme original');
    return false;
  }
};

/** asks for confirmation, then makes every given copy the original of its photo; returns how many changed */
export const setCopiesAsOriginal = async (copies: CopyToDelete[], folder: string): Promise<number> => {
  if (copies.length === 0) {
    return 0;
  }

  const isConfirmed = await modalManager.showDialog({
    title: 'Définir ce dossier comme original',
    prompt: `Les ${copies.length} photos de ce groupe utiliseront désormais leur fichier de ${folder} comme original. Aucun fichier n'est supprimé ni déplacé.`,
    confirmText: 'Définir comme original',
  });

  if (!isConfirmed) {
    return 0;
  }

  let changed = 0;
  const failures: string[] = [];
  for (const { assetId, path } of copies) {
    try {
      await putOriginal(assetId, path);
      changed++;
    } catch (error) {
      failures.push(`${path} (${error instanceof Error ? error.message : error})`);
    }
  }

  if (changed > 0) {
    toastManager.primary(changed === 1 ? '1 original modifié' : `${changed} originaux modifiés`);
  }
  for (const failure of failures) {
    toastManager.warning(`Original inchangé : ${failure}`);
  }

  return changed;
};

/** asks for confirmation, deletes the copies from disk and reports the result; returns the deleted paths */
export const deleteCopies = async (copies: CopyToDelete[]): Promise<string[]> => {
  if (copies.length === 0) {
    return [];
  }

  const isConfirmed = await modalManager.showDialog({
    title: copies.length === 1 ? 'Supprimer la copie' : `Supprimer ${copies.length} copies`,
    prompt:
      (copies.length === 1 ? 'Ce fichier sera supprimé' : `Ces ${copies.length} fichiers seront supprimés`) +
      " définitivement du NAS, et Syncthing les supprimera aussi de tes autres appareils. L'original de chaque photo est conservé et vérifié avant suppression.",
    confirmText: 'Supprimer',
    confirmColor: 'danger',
  });

  if (!isConfirmed) {
    return [];
  }

  try {
    const result = await request<DeleteResult>('/api/asset-copies', {
      method: 'DELETE',
      body: JSON.stringify({ items: copies }),
    });

    if (result.deleted > 0) {
      toastManager.primary(result.deleted === 1 ? 'Copie supprimée' : `${result.deleted} copies supprimées`);
    }

    for (const { path, reason } of result.failed) {
      toastManager.warning(`Copie conservée : ${path} (${reason})`);
    }

    const failed = new Set(result.failed.map(({ path }) => path));
    return copies.map(({ path }) => path).filter((path) => !failed.has(path));
  } catch (error) {
    handleError(error, 'Impossible de supprimer les copies');
    return [];
  }
};
