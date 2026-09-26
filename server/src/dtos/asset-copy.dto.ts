import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const AssetCopyOriginalSchema = z
  .object({
    path: z.string().min(1).describe('Path of the identical copy that becomes the original file'),
  })
  .meta({ id: 'AssetCopyOriginalDto' });

export class AssetCopyOriginalDto extends createZodDto(AssetCopyOriginalSchema) {}
