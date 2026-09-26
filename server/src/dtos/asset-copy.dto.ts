import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const AssetCopyOriginalSchema = z
  .object({
    path: z.string().min(1).describe('Path of the identical copy that becomes the original file'),
  })
  .meta({ id: 'AssetCopyOriginalDto' });

const AssetCopyDeleteSchema = z
  .object({
    items: z
      .array(
        z.object({
          assetId: z.uuidv4().describe('Asset ID'),
          path: z.string().min(1).describe('Path of the identical copy to delete from disk'),
        }),
      )
      .min(1)
      .max(1000),
  })
  .meta({ id: 'AssetCopyDeleteDto' });

export class AssetCopyOriginalDto extends createZodDto(AssetCopyOriginalSchema) {}
export class AssetCopyDeleteDto extends createZodDto(AssetCopyDeleteSchema) {}

export type AssetCopyDeleteResult = {
  deleted: number;
  failed: Array<{ path: string; reason: string }>;
};
